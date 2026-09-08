import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "td"))
from architecture.client import LocalClient, load_descriptor
from architecture.model import InspectorModel


def descriptor(tmp_path, **changes):
	value = dict(
		url="http://127.0.0.1:6281", token="a" * 64, pid=123, version="1", **changes
	)
	target = tmp_path / "service.json"
	target.write_text(json.dumps(value))
	target.chmod(0o600)
	return target


class WebClient:
	def __init__(self):
		self.calls = []
		self.closed = []

	def request(self, *args, **kwargs):
		self.calls.append((args, kwargs))
		return len(self.calls)

	def closeConnection(self, identifier):
		self.closed.append(identifier)


def test_descriptor_requires_private_loopback_file_and_never_returns_remote(tmp_path):
	target = descriptor(tmp_path)
	assert load_descriptor(target)["pid"] == 123
	target.chmod(0o644)
	with pytest.raises(ValueError):
		load_descriptor(target)
	target.chmod(0o600)
	data = json.loads(target.read_text())
	data["url"] = "http://example.com:6281"
	target.write_text(json.dumps(data))
	with pytest.raises(ValueError):
		load_descriptor(target)


def test_async_rpc_serializes_auth_without_storing_in_parameters(tmp_path):
	target = descriptor(tmp_path)
	web = WebClient()
	results = []
	client = LocalClient(web, results.append, descriptor_path=target)
	assert client.request("inspector_state", {}) is True
	assert client.request("inspector_state", {}) is False
	args, kwargs = web.calls[0]
	assert args == ("http://127.0.0.1:6281/rpc", "POST")
	assert kwargs["header"]["Authorization"] == "Bearer " + "a" * 64
	assert json.loads(kwargs["data"]) == {"method": "inspector_state", "params": {}}
	client.response({"code": 200}, json.dumps({"ok": True, "result": {"graph": {}}}))
	assert client.pending is None and results[-1]["result"] == {"graph": {}}
	assert not hasattr(client, "token")


def test_async_errors_and_response_bounds_preserve_actionable_status(tmp_path):
	client = LocalClient(
		WebClient(), lambda _: None, descriptor_path=descriptor(tmp_path)
	)
	client.request("inspector_state", {})
	client.response({"code": 401}, "denied")
	assert client.error and client.pending is None
	client.request("inspector_state", {})
	client.response({"code": 200}, "x" * (client.MAX_RESPONSE + 1))
	assert "large" in client.error
	with pytest.raises(ValueError):
		client.request("execute_python_script", {})


def test_pagination_search_and_role_filters_are_bounded_and_stable():
	model = InspectorModel()
	nodes = [{"path": f"/project1/n{i:03}", "family": "TOP"} for i in range(50)]
	classifications = [
		{"path": node["path"], "role": "rendering", "confidence": 0.9}
		for node in nodes[:20]
	]
	model.update(
		{
			"graph": {
				"nodes": nodes,
				"revision": 1,
				"status": "fresh",
				"complete": True,
			},
			"classification": {"classifications": classifications},
		}
	)
	first = model.rows()
	assert len(first["rows"]) == 18 and first["total"] == 50
	model.page = 2
	assert len(model.rows()["rows"]) == 14
	model.role = "rendering"
	model.page = 0
	assert model.rows()["total"] == 20
	model.search = "n019"
	assert model.rows()["total"] == 1
	model.tab = "Classification"
	assert "90%" in model.rows()["rows"][0]["label"]


def test_preview_must_exist_and_match_current_revision_before_staging():
	model = InspectorModel()
	model.update(
		{"graph": {"revision": 2, "nodes": [], "status": "fresh", "complete": True}}
	)
	assert not model.can_stage
	model.preview(
		{"planId": "p1", "operations": [{"path": "/project1/a", "action": "move"}]}
	)
	assert model.can_stage and model.tab == "Changes"
	model.update({"graph": {"revision": 3, "nodes": []}})
	assert not model.can_stage
	model.tab = "Memory"
	model.update({"memory": {"records": [{"kind": "note", "text": "hello"}]}})
	assert model.rows()["total"] == 1


def test_initial_null_shared_state_is_renderable_and_cannot_stage():
	model = InspectorModel()
	model.update({"graph": None, "classification": None, "transaction": None})
	assert model.rows()["rows"] == [] and "unscanned" in model.summary().lower()
	model.preview({"id": "p", "blockedReasons": []})
	assert not model.can_stage


def test_blocked_refactor_reasons_and_affected_paths_are_readable_in_preview():
	model = InspectorModel()
	model.update(
		{"graph": {"revision": 2, "status": "fresh", "complete": True, "nodes": []}}
	)
	model.preview(
		{
			"id": "p",
			"revision": 2,
			"containerPath": "/project1/Sub",
			"affectedPaths": ["/project1/a"],
			"blockedReasons": ["External dependency unresolved"],
			"ports": [],
			"repairs": [],
			"preview": {"checkpointPolicy": "Save first"},
		}
	)
	assert not model.can_stage
	labels = [row["label"] for row in model.rows()["rows"]]
	assert any("External dependency unresolved" in label for label in labels)
	assert any("/project1/a" in label for label in labels)


def test_service_error_envelope_is_shown_without_raw_payload(tmp_path):
	client = LocalClient(
		WebClient(), lambda _: None, descriptor_path=descriptor(tmp_path)
	)
	client.request("plan_td_refactor", {})
	client.response(
		{"code": 422},
		json.dumps({"ok": False, "error": {"message": "Select same-parent nodes"}}),
	)
	assert "same-parent" in client.error


def test_descriptor_symlink_is_rejected(tmp_path):
	target = descriptor(tmp_path)
	link = tmp_path / "linked.json"
	link.symlink_to(target)
	with pytest.raises((ValueError, OSError)):
		load_descriptor(link)


def test_descriptor_rejects_fifo_without_waiting(tmp_path):
	import os

	if not hasattr(os, "mkfifo"):
		pytest.skip("FIFO available on POSIX only")
	fifo = tmp_path / "service.json"
	os.mkfifo(fifo, 0o600)
	with pytest.raises(ValueError):
		load_descriptor(fifo)


def test_request_error_redacts_credential_and_expiry_closes_connection(tmp_path):
	class FailedClient(WebClient):
		def request(self, *args, **kwargs):
			raise RuntimeError("bad header " + kwargs["header"]["Authorization"])

	client = LocalClient(
		FailedClient(), lambda _: None, descriptor_path=descriptor(tmp_path)
	)
	assert client.request("inspector_state", {}) is False
	assert "a" * 64 not in client.error
	web = WebClient()
	client = LocalClient(web, lambda _: None, descriptor_path=tmp_path / "service.json")
	client.request("inspector_state", {})
	client.started -= 20
	client.expire()
	assert client.pending is None and web.closed == [1] and "timed out" in client.error


def test_late_untracked_response_is_ignored(tmp_path):
	results = []
	client = LocalClient(
		WebClient(), results.append, descriptor_path=descriptor(tmp_path)
	)
	client.response(
		{"code": 200}, json.dumps({"ok": True, "result": {"graph": {"revision": 99}}})
	)
	assert results == []


def test_preview_is_disabled_when_same_revision_becomes_stale_or_incomplete():
	model = InspectorModel()
	model.update({"graph": {"revision": 1, "status": "fresh", "complete": True}})
	model.preview({"id": "plan1", "revision": 1})
	assert model.can_stage
	model.update({"graph": {"revision": 1, "status": "stale", "complete": True}})
	assert not model.can_stage
	model.update({"graph": {"revision": 1, "status": "fresh", "complete": False}})
	assert not model.can_stage


def test_remote_pagination_supports_more_than_500_nodes_without_double_slicing():
	model = InspectorModel()
	model.page = 30
	model.update(
		{
			"graph": {
				"nodes": [
					{"path": f"/project1/n{i:04}", "family": "TOP"}
					for i in range(540, 558)
				],
				"revision": 1,
				"status": "fresh",
				"complete": True,
				"totalNodes": 603,
				"offset": 540,
				"limit": 18,
			}
		}
	)
	page = model.rows()
	assert page["page"] == 30 and page["pages"] == 34 and page["total"] == 603
	assert len(page["rows"]) == 18 and page["rows"][0]["path"] == "/project1/n0540"
	model.page = 33
	assert model.rows()["rows"] == []  # Await a new server page, not old rows.
	model.update(
		{
			"graph": {
				"nodes": [
					{"path": f"/project1/n{i:04}", "family": "TOP"}
					for i in range(594, 603)
				],
				"totalNodes": 603,
				"offset": 594,
				"limit": 18,
			}
		}
	)
	assert len(model.rows()["rows"]) == 9


def test_remote_filtered_page_uses_server_count_and_query_shape():
	model = InspectorModel()
	model.page = 1
	model.search = "hero"
	model.role = "geometry"
	assert model.query() == {
		"offset": 18,
		"limit": 18,
		"search": "hero",
		"role": "geometry",
	}
	model.update(
		{
			"graph": {
				"nodes": [{"path": "/project1/node25", "family": "SOP"}],
				"totalNodes": 19,
				"offset": 18,
				"limit": 18,
			}
		}
	)
	# Server search can match metadata not present in the short row label.
	assert model.rows()["total"] == 19 and len(model.rows()["rows"]) == 1
	model.tab = "Memory"
	assert model.query() == {"offset": 0, "limit": 18, "search": ""}


def test_response_id_rejects_cancelled_late_responses_without_clearing_new_request(
	tmp_path,
):
	results = []
	web = WebClient()
	client = LocalClient(web, results.append, descriptor_path=descriptor(tmp_path))
	client.request("inspector_state", {"offset": 0, "limit": 18})
	client.close()
	client.request("inspector_state", {"offset": 18, "limit": 18})
	client.response({"code": 200}, json.dumps({"ok": True, "result": {"old": True}}), 1)
	assert client.pending["id"] == 2 and results == []
	client.response({"code": 200}, json.dumps({"ok": True, "result": {"new": True}}), 2)
	assert client.pending is None and results[-1]["result"] == {"new": True}


def test_background_scan_progress_overrides_retained_fresh_graph_and_staging():
	model = InspectorModel()
	model.update({"graph": {"revision": 2, "status": "fresh", "complete": True}})
	model.preview({"id": "plan", "revision": 2})
	assert model.can_stage
	model.update(
		{"job": {"status": "scanning", "visited": 384, "remaining": 20, "pages": 3}}
	)
	assert "SCANNING" in model.summary() and "384 visited" in model.summary()
	assert "incomplete" in model.summary() and "FRESH" not in model.summary()
	assert not model.can_stage
	model.update({"job": {"status": "complete", "visited": 404, "remaining": 0}})
	assert "FRESH" in model.summary()


def test_scan_progress_without_any_graph_and_failed_jobs_are_visible():
	model = InspectorModel()
	model.update(
		{
			"graph": None,
			"job": {"status": "scanning", "visited": 128, "remaining": None},
		}
	)
	assert "128 visited" in model.summary() and model.rows()["rows"] == []
	model.update({"job": {"status": "failed", "visited": 128}})
	assert "FAILED" in model.summary() and "incomplete" in model.summary()


def test_first_connected_snapshot_replaces_setup_message_with_usage_hint():
	model = InspectorModel()
	model.update({"graph": None})
	assert "Start the architecture service" not in model.message
	assert "Scan" in model.message
	model.update(
		{"graph": {"revision": 1, "nodes": [], "status": "fresh", "complete": True}}
	)
	assert "Click a row" in model.message
	model.message = "A useful action result"
	model.update(
		{"graph": {"revision": 1, "nodes": [], "status": "fresh", "complete": True}}
	)
	assert model.message == "A useful action result"


def test_inspected_row_summarizes_returned_dependencies_and_classification_evidence():
	model = InspectorModel()
	path = "/project1/render"
	model.update(
		{
			"graph": {
				"nodes": [{"path": path, "family": "TOP", "opType": "glslTOP"}],
				"edges": [
					{
						"kind": "containment",
						"source": "/project1",
						"target": path,
						"evidence": "observed",
					},
					{
						"kind": "wire",
						"source": "/project1/input",
						"target": path,
						"evidence": "observed",
					},
					{
						"kind": "expression",
						"source": "/project1/data",
						"target": path,
						"evidence": "unresolved",
					},
					{
						"kind": "wire",
						"source": path,
						"target": "/project1/out",
						"evidence": "observed",
					},
					{
						"kind": "wire",
						"source": "/other/a",
						"target": "/other/b",
						"evidence": "observed",
					},
				],
			},
			"classification": {
				"classifications": [
					{
						"path": path,
						"role": "rendering",
						"confidence": 0.95,
						"evidence": [
							{"ruleId": "operator.glsl", "source": "operator-type"}
						],
					}
				]
			},
		}
	)
	detail = model.describe(path)
	assert "TOP/glslTOP" in detail and "2 in / 1 out" in detail
	assert "unresolved 1" in detail and "shown" in detail
	assert "rendering 95%" in detail and "operator.glsl" in detail
	assert len(detail) <= 190
	assert "current page" in model.describe("/missing")
