from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "td"))
from architecture import builder


class Par:
	def __init__(self):
		self.val = None
		self.pulsed = 0

	def pulse(self):
		self.pulsed += 1

	def eval(self):
		return self.val


class Pars:
	def __init__(self):
		object.__setattr__(self, "values", {})

	def __getattr__(self, key):
		if key not in self.values:
			self.values[key] = Par()
		return self.values[key]


class Page:
	def __init__(self, node):
		self.node = node

	def __getattr__(self, name):
		return lambda key, **kwargs: [getattr(self.node.par, key)]


class Node:
	def __init__(self, path, parent=None, family="COMP"):
		self.path, self._parent, self.family = path, parent, family
		self.par = Pars()
		self.children = []
		self.text = ""
		self.tags = set()
		self.runs = 0
		self.valid = True
		self.selectedChildren = []

	def op(self, path):
		if path.startswith("/"):
			if path == "/":
				return ROOT
			if path == "/project1":
				return PROJECT
		return next(
			(node for node in self.children if node.path.split("/")[-1] == path), None
		)

	@property
	def name(self):
		return self.path.rsplit("/", 1)[-1]

	@name.setter
	def name(self, value):
		self.path = self._parent.path.rstrip("/") + "/" + value

	def parent(self):
		return self._parent

	def pars(self):
		for name, value in self.par.values.items():
			value.name = name
		return list(self.par.values.values())

	def create(self, kind, name):
		child = Node(self.path.rstrip("/") + "/" + name, self, kind)
		self.children.append(child)
		return child

	def appendCustomPage(self, name):
		return Page(self)

	def run(self, *args, **kwargs):
		self.runs += 1

	def destroy(self):
		self._parent.children.remove(self)


ROOT = PROJECT = None


def fake():
	global ROOT, PROJECT
	ROOT = Node("/")
	PROJECT = Node("/project1", ROOT)
	ROOT.children.append(PROJECT)
	names = (
		"containerCOMP buttonCOMP parameterCOMP panelexecuteDAT "
		"opexecuteDAT textDAT webclientDAT parameterexecuteDAT executeDAT windowCOMP"
	)
	td = SimpleNamespace(**{name: name for name in names.split()}, op=ROOT.op)
	return td


def test_builder_never_overwrites_preexisting_operator():
	td = fake()
	existing = ROOT.create("containerCOMP", builder.OWNER_NAME)
	existing.text = "user work"
	with pytest.raises(ValueError):
		builder.install(td_module=td, activate=False)
	assert existing.text == "user work" and len(ROOT.children) == 2


def test_builder_native_bounded_rows_callbacks_embedded_and_no_network_waits():
	td = fake()
	result = builder.install(td_module=td, activate=False, open_window=False)
	panel = ROOT.op(builder.OWNER_NAME)
	assert result["architectureObserver"] == 1 and result["path"] == panel.path
	assert (
		len(
			[
				node
				for node in panel.children
				if node.path.split("/")[-1].startswith("ui_row_")
				and not node.path.endswith("_click")
			]
		)
		== 18
	)
	for name in ("Network", "Classification", "Changes", "Memory"):
		assert panel.op("ui_tab_" + name.lower()) is not None
	assert panel.op("ui_filters") is not None and panel.op("service_client") is not None
	assert panel.op("observer").par.precook.val is False
	assert panel.op("observer").par.postcook.val is False
	assert panel.op("startup").par.framestart.val is False
	assert panel.op("startup").par.frameend.val is False
	for node in panel.children:
		if node.text:
			compile(node.text, node.path, "exec")
	assert panel.op("bootstrap").runs == 0


def test_builder_rejects_invalid_root_before_creating_anything():
	td = fake()
	with pytest.raises(ValueError):
		builder.install(root_path="/missing", td_module=td, activate=False)
	assert len(ROOT.children) == 1


def controller_fixture(monkeypatch):
	from architecture import controller

	td = fake()
	builder.install(td_module=td, activate=False, open_window=False)
	panel = ROOT.op(builder.OWNER_NAME)
	td.PaneType = SimpleNamespace(NETWORKEDITOR="network", PANEL="panel")

	class Client:
		def __init__(self, *args, **kwargs):
			self.pending = None
			self.error = ""
			self.calls = []
			self.closed = False

		def request(self, *args):
			self.calls.append(args)
			return True

		def expire(self):
			pass

		def close(self):
			self.closed = True

		def response(self, *args):
			self.response_args = args

	monkeypatch.setattr(controller, "LocalClient", Client)
	pane = SimpleNamespace(type="network", owner=PROJECT, home=lambda **kwargs: None)
	pane.splitRight = lambda: pane
	pane.changeType = lambda kind: pane

	class Panes(list):
		@property
		def current(self):
			return self[0]

	ui = SimpleNamespace(panes=Panes([pane]))
	scheduled = []
	current = controller.mount(
		panel,
		td,
		ui,
		lambda *args, **kwargs: scheduled.append((args, kwargs)),
		SimpleNamespace(folder="/tmp", name="art.toe"),
	)
	return controller, current, panel, pane, scheduled


def test_controller_native_actions_and_two_second_nonrender_poll(monkeypatch):
	module, current, panel, pane, scheduled = controller_fixture(monkeypatch)
	assert current.client.calls[0] == (
		"inspector_state",
		{"offset": 0, "limit": 18, "search": ""},
	)
	assert scheduled[0][1] == {"delayMilliSeconds": 2000, "wallTime": True}
	current.received(
		{
			"method": "inspector_state",
			"result": {
				"graph": {
					"revision": 1,
					"nodes": [],
					"status": "fresh",
					"complete": True,
				}
			},
		}
	)
	child = SimpleNamespace(path="/project1/input1")
	pane.owner.selectedChildren = [child]
	current.action("preview")
	assert current.client.calls[-1] == (
		"plan_td_refactor",
		{"paths": [child.path], "name": "Subsystem"},
	)
	current.received(
		{
			"method": "plan_td_refactor",
			"result": {"id": "p1", "revision": 1, "blockedReasons": []},
		}
	)
	current.action("stage")
	assert current.client.calls[-1] == (
		"stage_td_refactor",
		{"action": "apply", "planId": "p1"},
	)
	current.received({"method": "stage_td_refactor", "result": {"status": "staged"}})
	assert current.model.plan is None
	for action in ("scan", "watch", "classify"):
		current.action(action)
		assert current.client.calls[-1][1]["summaryOnly"] is True
		if action in ("scan", "watch"):
			assert current.client.calls[-1][1]["wait"] is False
	assert current.client.calls[-1] == (
		"classify_td_network",
		{"rootPath": "/project1", "summaryOnly": True},
	)
	panel.par.Search.val = "something"
	module.filters(panel.path)
	assert current.model.search == "something"
	module.action(panel.path, "tab", "Memory")
	assert current.model.tab == "Memory"
	module.action(panel.path, "page", 1)
	assert current.model.page == 0
	module.action(panel.path, "dock")
	assert pane.owner is panel
	module.stop(panel.path)
	assert current.client.closed


def test_controller_missing_selection_stale_preview_and_invalid_action_are_visible(
	monkeypatch,
):
	module, current, panel, pane, _ = controller_fixture(monkeypatch)
	for action in ("preview", "stage", "unknown"):
		count = len(current.client.calls)
		current.action(action)
		assert len(current.client.calls) == count and current.model.message
	current.action("tab", "invalid")
	assert "Unknown" in current.model.message
	current.focus("/missing")
	assert "no longer exists" in current.model.message
	current.client.error = "Service unavailable"
	current.tick()
	assert "Disconnected" in current.model.connection
	count = len(current.client.calls)
	module.tick(panel.path, "old-generation")
	assert len(current.client.calls) == count
	module.tick(panel.path, current.generation)
	assert len(current.client.calls) == count + 1
	module.response(panel.path, {"code": 500}, "failure")
	assert current.client.response_args == ({"code": 500}, "failure", None)
	module.stop(panel.path)


def test_builder_normalizes_td_auto_suffixes_and_controller_uses_exact_ui_names(
	monkeypatch,
):
	td = fake()
	original_create = Node.create

	def auto_suffix(parent, kind, name):
		return original_create(
			parent, kind, name + "1" if not name[-1].isdigit() else name
		)

	monkeypatch.setattr(Node, "create", auto_suffix)
	receipt = builder.install(td_module=td, activate=False, open_window=False)
	panel = ROOT.op(builder.OWNER_NAME)
	assert panel is not None and receipt["path"] == panel.path
	for name in (
		"ui_status",
		"ui_message",
		"ui_stage",
		"ui_pagination",
		"ui_title",
		"ui_scan",
		"ui_tab_network",
		"ui_row_00",
		"bootstrap",
		"observer",
		"service_client",
		"service_callbacks",
		"ui_filters",
	):
		assert panel.op(name) is not None, name


def test_row_details_remain_visible_without_an_open_network_editor(monkeypatch):
	module, current, panel, pane, _ = controller_fixture(monkeypatch)
	current.model.update(
		{
			"graph": {
				"nodes": [
					{"path": "/project1", "family": "COMP", "opType": "baseCOMP"}
				],
				"edges": [],
				"revision": 1,
				"status": "fresh",
				"complete": True,
			}
		}
	)
	current.ui.panes.clear()
	current.focus("/project1")
	assert "COMP/baseCOMP" in current.model.message
	assert current.model.selected_path == "/project1"
	module.stop(panel.path)


def test_clean_export_is_inert_and_delayed_create_cannot_activate(monkeypatch):
	td = fake()
	receipt = builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	assert receipt["cleanExport"] is True
	assert panel.par.Autostart.val is False and panel.par.Cleanexport.val is True
	assert panel.op("startup").par.active.val is False
	assert panel.op("service_client").par.active.val is False
	assert panel.op("bootstrap").runs == 0
	callbacks = {"parent": lambda: panel}
	exec(panel.op("startup").text, callbacks)
	callbacks["onCreate"]()
	callbacks["onStart"]()
	assert panel.op("bootstrap").runs == 0
	assert panel.op("ui_connect") is not None
	assert builder.validate_clean_export(panel)["cleanExport"] is True


def test_pristine_export_guard_rejects_cached_response_ui_facts_and_source_tampering():
	from architecture import provenance

	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	client = panel.op("service_client")
	client.text = "private project graph"
	with pytest.raises(ValueError, match="response"):
		builder.validate_clean_export(panel)
	client.text = ""
	panel.op("ui_message").par.label.val = "Private song or project title"
	with pytest.raises(ValueError, match="label"):
		builder.validate_clean_export(panel)
	panel.op("ui_message").par.label.val = "Start the architecture service, then Scan"
	source = panel.op("controller_source")
	source.text += "\n# altered source\n"
	with pytest.raises(ValueError, match="hash"):
		provenance.verify_panel(panel)


def test_activate_false_uses_persistent_guard_even_outside_export_mode():
	td = fake()
	builder.install(td_module=td, activate=False, open_window=False)
	panel = ROOT.op(builder.OWNER_NAME)
	callbacks = {"parent": lambda: panel}
	exec(panel.op("startup").text, callbacks)
	callbacks["onCreate"]()
	assert panel.op("bootstrap").runs == 0


def test_clean_export_rejects_added_nodes_and_client_configuration():
	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	extra = panel.create("textDAT", "private_cache")
	extra.text = "private data"
	with pytest.raises(ValueError, match="inventory"):
		builder.validate_clean_export(panel)
	extra.destroy()
	panel.op("service_client").par.url.val = "http://127.0.0.1/private"
	with pytest.raises(ValueError, match="configuration"):
		builder.validate_clean_export(panel)


def test_export_clean_receipt_is_relative_bound_to_bytes_and_rechecks_after_save(
	tmp_path, monkeypatch
):
	import json

	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	target = tmp_path / "inspector.tox"
	panel.save = lambda path: Path(path).write_bytes(b"fake native fixture")
	manifest_path = tmp_path / "inspector.build.json"
	monkeypatch.setattr(builder, "_receipt_path", lambda: manifest_path)
	receipt = builder.export_clean(
		panel, target, td_module=SimpleNamespace(app=SimpleNamespace(build=202533230))
	)
	assert receipt["build"] == "2025.33230" and receipt["autostart"] is False
	assert receipt["binary"]["path"] == "inspector.tox"
	assert receipt["binary"]["bytes"] == target.stat().st_size
	assert "builder.py" in receipt["sources"]
	assert json.loads(manifest_path.read_text()) == receipt

	def changed_save(path):
		Path(path).write_bytes(b"changed fixture")
		panel.op("service_client").text = "private response"

	panel.save = changed_save
	with pytest.raises(ValueError, match="response"):
		builder.export_clean(
			panel,
			target,
			td_module=SimpleNamespace(app=SimpleNamespace(build=202533230)),
		)


def test_export_rejects_actual_unpinned_build_before_native_save(tmp_path):
	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	panel.save = lambda path: pytest.fail("Save must not run on unsupported build")
	with pytest.raises(ValueError, match="running"):
		builder.export_clean(
			panel,
			tmp_path / "inspector.tox",
			td_module=SimpleNamespace(app=SimpleNamespace(build=202311600)),
		)


def test_clean_export_rejects_nested_manifest_names_and_root_state():
	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	extra = panel.op("ui_title").create("textDAT", "build_manifest")
	extra.text = "private nested data"
	with pytest.raises(ValueError, match="inventory"):
		builder.validate_clean_export(panel)
	extra.destroy()
	panel.par.Privatefact.val = "private fact"
	with pytest.raises(ValueError, match="configuration"):
		builder.validate_clean_export(panel)


def test_clean_manifest_rejects_unlisted_metadata_and_manifest_configuration():
	import json

	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	node = panel.op("build_manifest")
	original = node.text
	node.text = json.dumps(dict(json.loads(original), privateNotes="private project"))
	with pytest.raises(ValueError, match="fields"):
		builder.validate_clean_export(panel)
	node.text = original
	node.par.file.val = "/private/path"
	with pytest.raises(ValueError, match="configuration"):
		builder.validate_clean_export(panel)


def test_pristine_manifest_accepts_bounded_native_widget_descendants(monkeypatch):
	td = fake()
	original = Node.create

	def native_children(parent, kind, name):
		node = original(parent, kind, name)
		if kind == "buttonCOMP":
			for index in range(8):
				original(node, "containerCOMP", "native_widget_" + str(index))
		return node

	monkeypatch.setattr(Node, "create", native_children)
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	assert 65536 < len(panel.op("build_manifest").text) < 128 * 1024
	assert builder.validate_clean_export(panel)["cleanExport"] is True


def test_pristine_manifest_rejects_more_than_128_kib():
	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	panel.op("build_manifest").text = " " * (128 * 1024 + 1)
	with pytest.raises(ValueError, match="oversized"):
		builder.validate_clean_export(panel)


def test_clean_export_canonicalizes_external_tox_enable_before_inventory():
	td = fake()
	builder.install_clean_export(td_module=td)
	panel = ROOT.op(builder.OWNER_NAME)
	assert panel.par.enableexternaltox.val is False
	# loadTox forces this native flag off; it must already match the pristine hash.
	panel.par.enableexternaltox.val = False
	assert builder.validate_clean_export(panel)["cleanExport"] is True
