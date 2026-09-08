import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "td/architecture/observer.py"


def load_observer():
	spec = importlib.util.spec_from_file_location("architecture_observer_test", SOURCE)
	module = importlib.util.module_from_spec(spec)
	sys.modules[spec.name] = module
	spec.loader.exec_module(module)
	return module


class Parameter:
	def __init__(self):
		self.val = None


class Watcher:
	def __init__(self):
		names = (
			"active op precook postcook opdelete flagchange wirechange namechange "
			"pathchange uichange numchildrenchange childrename currentchildchange extensionchange"
		)
		self.par = SimpleNamespace(**{name: Parameter() for name in names.split()})
		self.path = "/_td_architecture_inspector/observer"


def ready():
	module = load_observer()
	root = SimpleNamespace(path="/project1", family="COMP", id=12)
	child = SimpleNamespace(path="/project1/child", family="TOP", id=13)
	nodes = {root.path: root, child.path: child}
	watcher = Watcher()
	module.configure(watcher, nodes.get, {"folder": "/tmp", "name": "art.toe"})
	module.start("/project1")
	return module, watcher


def test_start_alias_and_callback_configuration_exclude_cook_and_selection():
	module, watcher = ready()
	assert sys.modules["_td_mcp_architecture"] is module
	assert module.status()["architectureObserver"] == 1
	assert module.status()["active"] is True
	assert watcher.par.precook.val is False and watcher.par.postcook.val is False
	assert watcher.par.currentchildchange.val is False
	assert (
		watcher.par.wirechange.val is True and watcher.par.numchildrenchange.val is True
	)
	assert watcher.par.op.val == "/project1"
	assert "onPreCook" not in module.callback_source()
	assert "onPostCook" not in module.callback_source()


def test_dirty_revisions_and_bounded_drain_preserve_session_identity():
	module, _ = ready()
	identity = module.project_identity
	module.record("wire", "/project1/child", "/project1", now=1)
	module.record("name", "/project1/child", "/project1", now=2)
	first = module.drain(1)
	assert first["events"][0]["kind"] == "wire"
	assert first["remaining"] == 1 and first["dirty_revision"] == 2
	assert module.drain(1)["events"][0]["revision"] == 2
	assert module.project_identity == identity
	assert module.drain(1)["events"] == []


def test_debounce_updates_revision_without_unbounded_same_event_entries():
	module, _ = ready()
	for index in range(20):
		module.record("ui", "/project1/child", "/project1", now=index * 0.001)
	output = module.drain(100)
	assert len(output["events"]) == 1
	assert output["dirty_revision"] == 20 and output["events"][0]["revision"] == 20


def test_overflow_is_visible_and_watch_scope_is_preflighted():
	module, watcher = ready()
	for index in range(module.MAX_EVENTS + 5):
		module.record("wire", "/project1/child", "/project1", now=index)
	assert module.status()["dropped"] == 5
	assert module.status()["pending"] == module.MAX_EVENTS
	module.watch(["/project1/child"])
	assert watcher.par.op.val == "/project1 /project1/child"
	with pytest.raises(ValueError):
		module.watch(["/foreign"])
	assert watcher.par.op.val == "/project1 /project1/child"
	with pytest.raises(ValueError):
		module.watch(["/project1/child"] * 5001)


def test_external_and_owned_inspector_events_are_excluded_and_stop_is_quiet():
	module, watcher = ready()
	module.record("wire", "/other/node", "/other")
	module.record(
		"wire", "/_td_architecture_inspector/client", "/_td_architecture_inspector"
	)
	assert module.dirty_revision == 0
	module.stop()
	module.record("wire", "/project1/child", "/project1")
	assert module.dirty_revision == 0 and watcher.par.active.val is False


def test_callbacks_record_identity_without_reading_operator_content():
	module, _ = ready()
	child = SimpleNamespace(
		path="/project1/child", parent=lambda: SimpleNamespace(path="/project1")
	)
	callbacks = {}
	exec(module.callback_source(), callbacks)
	callbacks["onWireChange"](child)
	callbacks["onFlagChange"](child, "selected")
	callbacks["onDestroy"]()
	events = module.drain(10)["events"]
	assert [event["kind"] for event in events] == ["wire", "destroy"]
	assert events[-1]["path"] == "/project1"


def test_start_invalid_root_and_drain_invalid_limit_are_rejected():
	module, _ = ready()
	session = module.session_id
	with pytest.raises(ValueError):
		module.start("/project1/child")
	assert module.session_id == session
	for limit in (0, 1025, True, 1.5):
		with pytest.raises(ValueError):
			module.drain(limit)
