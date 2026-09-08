"""Identity-only OP Execute observer; never reads contents, dependencies or cooks.

The collector consumes a bounded ledger through its existing Python executor.
Registered-path coverage is explicit: call watch(scanned_paths) after a scan.
"""

from collections import deque
import hashlib
import json
import re
import sys
import time
import uuid

MAX_EVENTS = 2048
MAX_WATCHED = 5000
OWNER_NAME = "_td_architecture_inspector"
session_id = ""
dirty_revision = 0
project_identity = ""
root_path = ""
active = False
_events = deque(maxlen=MAX_EVENTS)
_dropped = 0
_watched = ()
_watcher = None
_lookup = None
_project = {}


def configure(watcher, op_lookup, project_info=None):
	"""Builder injects the owned DAT and TD lookup; no network work occurs here."""
	global _watcher, _lookup, _project
	_watcher, _lookup = watcher, op_lookup
	_project = dict(project_info or {})
	sys.modules["_td_mcp_architecture"] = sys.modules[__name__]


def _valid_path(path):
	return (
		isinstance(path, str)
		and len(path) <= 1024
		and re.fullmatch(r"/(?:[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*)?", path) is not None
	)


def _inside(path):
	return path == root_path or path.startswith(root_path.rstrip("/") + "/")


def _parameter(name, value):
	parameter = getattr(_watcher.par, name, None)
	if parameter is None:
		raise RuntimeError(
			"This TouchDesigner build lacks OP Execute parameter: " + name
		)
	parameter.val = value


def start(rootPath):
	"""Start a new session only after validating the requested existing COMP."""
	global \
		root_path, \
		active, \
		session_id, \
		dirty_revision, \
		project_identity, \
		_events, \
		_dropped
	if _watcher is None or _lookup is None:
		raise RuntimeError(
			"Install the native architecture inspector before starting its observer"
		)
	node = _lookup(rootPath) if _valid_path(rootPath) else None
	if node is None or node.family != "COMP":
		raise ValueError("Observer root must be an existing absolute COMP path")
	_parameter("active", False)
	for name in ("precook", "postcook", "currentchildchange"):
		_parameter(name, False)
	for name in (
		"opdelete",
		"flagchange",
		"wirechange",
		"namechange",
		"pathchange",
		"uichange",
		"numchildrenchange",
		"childrename",
		"extensionchange",
	):
		_parameter(name, True)
	root_path = rootPath
	session_id, dirty_revision, _events, _dropped = (
		str(uuid.uuid4()),
		0,
		deque(maxlen=MAX_EVENTS),
		0,
	)
	identity = dict(
		_project, rootPath=rootPath, rootId=str(getattr(node, "id", "unknown"))
	)
	project_identity = hashlib.sha256(
		json.dumps(identity, sort_keys=True).encode()
	).hexdigest()
	watch([rootPath])
	active = True
	_parameter("active", True)
	return status()


def watch(paths):
	"""Replace the explicit watch set after full preflight; no recursive traversal."""
	global _watched
	if not isinstance(paths, (list, tuple)) or len(paths) > MAX_WATCHED:
		raise ValueError("Observer watch set must contain at most 5000 paths")
	if any(not _valid_path(path) or not _inside(path) for path in paths):
		raise ValueError("Observer watch paths must be canonical and within its root")
	selected = tuple(sorted({root_path, *paths} - {""}))
	selected = tuple(path for path in selected if OWNER_NAME not in path.split("/"))
	if len(selected) > MAX_WATCHED:
		raise ValueError("Observer watch set including its root exceeds 5000 paths")
	_parameter("op", " ".join(selected))
	_watched = selected
	return status()


def record(kind, path, parentPath="", now=None):
	"""Callback hot path: bounded identity data only; repeated events coalesce."""
	global dirty_revision, _dropped, _events
	if not active or not _inside(path) or OWNER_NAME in path.split("/"):
		return
	dirty_revision += 1
	event = {
		"revision": dirty_revision,
		"kind": str(kind)[:40],
		"path": path[:1024],
		"parentPath": str(parentPath)[:1024],
		"at": time.monotonic() if now is None else now,
	}
	if (
		_events
		and all(
			_events[-1][key] == event[key] for key in ("kind", "path", "parentPath")
		)
		and 0 <= event["at"] - _events[-1]["at"] < 0.15
	):
		_events[-1] = event
		return
	if len(_events) == MAX_EVENTS:
		_dropped += 1
	_events.append(event)


def changed(kind, node=None, flag=None):
	"""OP Execute adapter; destruction has no changed-OP argument in TD."""
	if flag in ("selected", "current"):
		return
	if node is None:
		record(kind, root_path, root_path)
		return
	try:
		path = node.path
		parent = node.parent()
		record(kind, path, parent.path if parent else "")
	except Exception:
		# A deleting OP may no longer expose its path. Invalidate the root.
		record(kind, root_path, root_path)


def status():
	return {
		"architectureObserver": 1,
		"active": active,
		"root_path": root_path,
		"session_id": session_id,
		"dirty_revision": dirty_revision,
		"project_identity": project_identity,
		"pending": len(_events),
		"dropped": _dropped,
		"coverage": "registered_paths",
		"watched_count": len(_watched),
	}


def drain(limit=256):
	if type(limit) is not int or not 1 <= limit <= 1024:
		raise ValueError("Observer drain limit must be an integer from 1 to 1024")
	events = [dict(_events.popleft()) for _ in range(min(limit, len(_events)))]
	return dict(status(), events=events, remaining=len(_events))


def stop():
	global active
	active = False
	if _watcher is not None:
		_parameter("active", False)
	return status()


def callback_source():
	"""Documented OP Execute callback signatures; deliberately no cook hooks."""
	return """import sys

def _changed(kind, node=None, flag=None):
    observer = sys.modules.get('_td_mcp_architecture')
    if observer is not None:
        observer.changed(kind, node, flag)

def onDestroy():
    _changed('destroy')
def onFlagChange(changeOp, flag):
    _changed('flag', changeOp, flag)
def onWireChange(changeOp):
    _changed('wire', changeOp)
def onNameChange(changeOp):
    _changed('name', changeOp)
def onPathChange(changeOp):
    _changed('path', changeOp)
def onUIChange(changeOp):
    _changed('ui', changeOp)
def onNumChildrenChange(changeOp):
    _changed('children', changeOp)
def onChildRename(changeOp):
    _changed('child_name', changeOp)
def onExtensionChange(changeOp, extension):
    _changed('extension', changeOp)
"""
