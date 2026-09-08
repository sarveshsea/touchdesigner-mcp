"""Nonblocking authenticated loopback RPC through a native Web Client DAT."""

import json
import os
from pathlib import Path
import re
import stat
import time
from urllib.parse import urlsplit

METHODS = frozenset(
	(
		"get_td_operator_catalog",
		"map_td_project",
		"classify_td_network",
		"plan_td_refactor",
		"stage_td_refactor",
		"get_td_memory",
		"record_td_memory",
		"inspector_state",
	)
)


def descriptor_path():
	root = os.environ.get("TD_ARCHITECTURE_STATE_DIR")
	return (
		Path(root).expanduser()
		if root
		else Path.home() / ".touchdesigner-mcp/architecture"
	) / "service.json"


def load_descriptor(path=None):
	target = Path(path) if path is not None else descriptor_path()
	info = target.lstat()
	if not stat.S_ISREG(info.st_mode):
		raise ValueError(
			"Architecture service descriptor must be a regular file, not a link or device"
		)
	descriptor = os.open(
		target,
		os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
	)
	with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
		info = os.fstat(stream.fileno())
		if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
			raise ValueError(
				"Architecture service descriptor must be a small regular file"
			)
		if os.name != "nt" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
			raise ValueError(
				"Architecture service descriptor must be private to the current user (0600)"
			)
		raw = stream.read(16385)
		if len(raw) > 16384:
			raise ValueError("Architecture service descriptor exceeds its size limit")
	document = json.loads(raw)
	parsed = urlsplit(document.get("url", ""))
	if (
		parsed.scheme != "http"
		or parsed.hostname not in ("127.0.0.1", "::1")
		or parsed.username
		or parsed.password
		or parsed.path not in ("", "/")
		or parsed.query
		or parsed.fragment
		or parsed.port is None
	):
		raise ValueError(
			"Architecture service URL must be an explicit HTTP loopback port"
		)
	if not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", document.get("token", "")):
		raise ValueError(
			"Architecture service descriptor has an invalid authentication token"
		)
	if type(document.get("pid")) is not int or document["pid"] <= 0:
		raise ValueError(
			"Architecture service descriptor has an invalid process identifier"
		)
	if not isinstance(document.get("version"), str) or len(document["version"]) > 80:
		raise ValueError("Architecture service descriptor has an invalid version")
	return document


class LocalClient:
	MAX_RESPONSE = 4 * 1024 * 1024

	def __init__(self, web_client, on_result, descriptor_path=None):
		self.web_client, self.on_result = web_client, on_result
		self.descriptor_path = descriptor_path
		self.pending, self.error, self.started = None, "", 0.0

	def request(self, method, params):
		if method not in METHODS or not isinstance(params, dict):
			raise ValueError("Unsupported architecture RPC method or parameters")
		if self.pending is not None:
			return False
		credential = None
		try:
			descriptor = load_descriptor(self.descriptor_path)
			credential = descriptor["token"]
			body = json.dumps({"method": method, "params": params}, allow_nan=False)
			if len(body) > 65536:
				raise ValueError("Architecture action exceeds the request size limit")
			identifier = self.web_client.request(
				descriptor["url"].rstrip("/") + "/rpc",
				"POST",
				header={
					"Content-Type": "application/json",
					"Authorization": "Bearer " + descriptor["token"],
				},
				data=body,
				timeout=10000,
			)
			self.pending = {"id": identifier, "method": method, "params": dict(params)}
			self.started, self.error = time.monotonic(), ""
			return True
		except (OSError, ValueError, TypeError, RuntimeError) as error:
			message = (
				str(error).replace(credential, "[redacted]")
				if credential
				else str(error)
			)
			self.error = "Service unavailable: " + message[:240]
			return False

	def response(self, status_code, data, request_id=None):
		pending = self.pending
		if pending is None:
			return
		if request_id is not None and request_id != pending["id"]:
			return
		self.pending = None
		try:
			code = (
				status_code.get("code", 0)
				if isinstance(status_code, dict)
				else int(status_code)
			)
			if not isinstance(data, (str, bytes)) or len(data) > self.MAX_RESPONSE:
				raise ValueError(
					"Architecture response is too large or has an unsupported format"
				)
			try:
				document = json.loads(data)
			except ValueError:
				raise ValueError(
					f"Architecture service returned HTTP {code} with an invalid response"
				)
			if not isinstance(document, dict) or not isinstance(
				document.get("ok"), bool
			):
				raise ValueError("Architecture response is malformed")
			if not document["ok"]:
				detail = document.get("error", {})
				raise ValueError(
					str(detail.get("message", "Architecture request failed"))[:240]
				)
			if code != 200:
				raise ValueError(f"Architecture service returned HTTP {code}")
			self.error = ""
			self.on_result(
				dict(
					document, method=pending["method"], requestParams=pending["params"]
				)
			)
		except (ValueError, TypeError, AttributeError) as error:
			self.error = str(error)[:300]

	def expire(self):
		if self.pending is not None and time.monotonic() - self.started > 12:
			self.close()
			self.error = "Architecture service timed out; last snapshot retained"

	def close(self):
		pending, self.pending = self.pending, None
		if pending is not None:
			self.web_client.closeConnection(pending["id"])
