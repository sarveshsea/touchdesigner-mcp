"""Build the optional native inspector only in a newly-created protected COMP.

Run install() inside TouchDesigner. No binary export is fabricated: export the
returned component using its native .save(path) after actual build validation.
"""

import hashlib
import json
from pathlib import Path

from .model import PAGE_SIZE, ROLES, TABS
from .observer import OWNER_NAME, callback_source
from .provenance import MANIFEST_NODE, digest, inventory, validate_clean_panel

_LOADED_BUILDER_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _create(parent, kind, name):
	"""Verify exact names on newly owned nodes even when TD auto-appends digits."""
	if parent.op(name) is not None:
		raise ValueError("Inspector node name already exists: " + name)
	node = parent.create(kind, name)
	try:
		if node.name != name:
			node.name = name
		if node.name != name or parent.op(name) != node:
			raise RuntimeError(
				"TouchDesigner could not retain inspector node name: " + name
			)
		return node
	except Exception:
		node.destroy()
		raise


def _set(node, **values):
	for name, value in values.items():
		parameter = getattr(node.par, name, None)
		if parameter is not None:
			parameter.val = value


def _button(panel, td, name, label, x, y, width, action=None, argument=None, height=28):
	name = "ui_" + name
	node = _create(panel, td.buttonCOMP, name)
	_set(
		node,
		x=x,
		y=y,
		w=width,
		h=height,
		label=label,
		buttontype="momentary",
		fontsize=12,
		bgcolorr=0.055,
		bgcolorg=0.09,
		bgcolorb=0.12,
		bgalpha=1,
		colorr=0.92,
		colorg=0.94,
		colorb=0.96,
	)
	if action:
		callback = _create(panel, td.panelexecuteDAT, name + "_click")
		_set(
			callback,
			panels=node,
			panelvalue="lselect",
			offtoon=True,
			whileon=False,
			ontooff=False,
			whileoff=False,
			valuechange=False,
		)
		if action == "connect":
			callback.text = (
				"def onOffToOn(panelValue):\n"
				"    panel = parent()\n"
				"    panel.par.Cleanexport = False\n"
				"    panel.par.Autostart = True\n"
				"    panel.op('startup').par.active = True\n"
				"    panel.op('service_client').par.active = True\n"
				"    panel.op('bootstrap').run()\n"
			)
			return node
		callback.text = (
			"import sys\ndef onOffToOn(panelValue):\n"
			"    module = sys.modules.get('_td_architecture_runtime.controller')\n"
			f"    if module: module.action(parent().path, {action!r}, {argument!r})\n"
		)
	return node


def _custom_parameters(panel):
	page = panel.appendCustomPage("Inspector")
	page.appendToggle("Autostart", label="Autostart after connecting")[0].val = False
	page.appendToggle("Cleanexport", label="Pristine distribution build")[0].val = False
	page.appendStr("Rootpath", label="Root COMP")[0].val = "/project1"
	page.appendStr("Search", label="Search")[0].val = ""
	role = page.appendMenu("Role", label="Role")[0]
	role.menuNames, role.menuLabels = list(ROLES), [role.title() for role in ROLES]
	role.val = "all"
	page.appendStr("Subsystem", label="Staged subsystem name")[0].val = "Subsystem"


def _native_interface(panel, td):
	_set(panel, w=920, h=840, bgcolorr=0.022, bgcolorg=0.03, bgcolorb=0.04, bgalpha=1)
	_button(
		panel,
		td,
		"title",
		"T O U C H D E S I G N E R   /   A R C H I T E C T U R E",
		16,
		802,
		744,
	)
	_button(panel, td, "connect", "CONNECT", 772, 802, 132, "connect")
	for index, tab in enumerate(TABS):
		_button(
			panel,
			td,
			"tab_" + tab.lower(),
			tab.upper(),
			16 + index * 224,
			764,
			216,
			"tab",
			tab,
		)
	filters = _create(panel, td.parameterCOMP, "ui_filters")
	_set(
		filters,
		x=16,
		y=656,
		w=888,
		h=100,
		op=panel,
		parscope="Rootpath Search Role Subsystem",
		pagescope="",
		combinescopes="any",
		scopeorder=True,
		header=False,
		builtin=False,
		custom=True,
		pagenames=False,
		allowexpand=False,
	)
	actions = (
		("scan", "SCAN"),
		("watch", "WATCH"),
		("classify", "CLASSIFY"),
		("preview", "PREVIEW SELECTION"),
		("stage", "STAGE PREVIEW"),
		("dock", "DOCK"),
	)
	for index, (name, label) in enumerate(actions):
		_button(panel, td, name, label, 16 + index * 148, 620, 140, name)
	_button(panel, td, "status", "Disconnected · unscanned", 16, 584, 888)
	_button(
		panel, td, "message", "Start the architecture service, then Scan", 16, 553, 888
	)
	for index in range(PAGE_SIZE):
		_button(
			panel,
			td,
			f"row_{index:02}",
			"",
			16,
			516 - index * 25,
			888,
			"row",
			index,
			height=24,
		)
	_button(panel, td, "previous", "PREVIOUS", 16, 32, 110, "page", -1)
	_button(panel, td, "pagination", "Page 1 / 1", 136, 32, 648)
	_button(panel, td, "next", "NEXT", 794, 32, 110, "page", 1)
	change = _create(panel, td.parameterexecuteDAT, "filter_changes")
	_set(
		change,
		op=panel,
		pars="Search Role",
		valuechange=True,
		pulse=False,
		onvaluechange=True,
		valueschanged=False,
		expressionchange=False,
	)
	change.text = (
		"import sys\ndef onValueChange(par, prev):\n"
		"    module = sys.modules.get('_td_architecture_runtime.controller')\n"
		"    if module: module.filters(parent().path)\n"
	)


def _bootstrap_source():
	return """import sys
import types
import td
import hashlib
import json

if not parent().par.Autostart.eval():
    raise RuntimeError('Inspector inactive: press CONNECT to start')
manifest = json.loads(parent().op('build_manifest').text)
for name, expected in manifest['datHashes'].items():
    node = parent().op(name)
    if node is None or hashlib.sha256(node.text.encode('utf-8')).hexdigest() != expected:
        raise RuntimeError('Inspector source hash mismatch: ' + name)
previous = sys.modules.get('_td_architecture_runtime.controller')
if previous:
    previous.stop(parent().path)
package = types.ModuleType('_td_architecture_runtime')
package.__path__ = []
sys.modules[package.__name__] = package
for name in ('provenance', 'observer', 'client', 'model', 'controller'):
    full_name = package.__name__ + '.' + name
    module = types.ModuleType(full_name)
    module.__package__ = package.__name__
    sys.modules[full_name] = module
    setattr(package, name, module)
    exec(compile(parent().op(name + '_source').text, full_name, 'exec'), module.__dict__)
package.controller.mount(parent(), td, ui, run, project)
"""


def install(
	root_path="/project1",
	td_module=None,
	open_window=True,
	activate=True,
	clean_export=False,
):
	"""Create once. An existing protected name is always rejected, never overwritten."""
	if td_module is None:
		import td as td_module
	td = td_module
	host = td.op("/")
	root = host if clean_export else td.op(root_path)
	if clean_export:
		root_path, activate, open_window = "/project1", False, False
	if root is None or root.family != "COMP":
		raise ValueError("Inspector root must be an existing COMP")
	if host.op(OWNER_NAME) is not None:
		raise ValueError(
			"Protected inspector name already exists; use its viewer or choose a clean project"
		)
	sources = {
		name: Path(__file__).with_name(name + ".py").read_text(encoding="utf-8")
		for name in ("provenance", "observer", "client", "model", "controller")
	}
	panel = _create(host, td.containerCOMP, OWNER_NAME)
	panel.tags.add("td_architecture_owned_v1")
	panel.comment = "Native architecture inspector v1. Owned UI only; no artwork nodes are overwritten."
	try:
		_custom_parameters(panel)
		panel.par.Rootpath.val = root_path
		panel.par.Autostart.val = bool(activate)
		panel.par.Cleanexport.val = bool(clean_export)
		if clean_export:
			# loadTox disables this flag; canonicalize it before pristine hashing.
			_set(panel, enableexternaltox=False)
		_native_interface(panel, td)
		for name, source in sources.items():
			_create(panel, td.textDAT, name + "_source").text = source
		watcher = _create(panel, td.opexecuteDAT, "observer")
		_set(
			watcher,
			active=False,
			precook=False,
			postcook=False,
			currentchildchange=False,
		)
		watcher.text = callback_source()
		client = _create(panel, td.webclientDAT, "service_client")
		callbacks = _create(panel, td.textDAT, "service_callbacks")
		callbacks.text = (
			"import sys\ndef onResponse(webClientDAT, statusCode, headerDict, data, id=None):\n"
			"    module = sys.modules.get('_td_architecture_runtime.controller')\n"
			"    if module: module.response(webClientDAT.parent().path, statusCode, data, id)\n"
		)
		_set(
			client,
			callbacks=callbacks,
			active=bool(activate),
			stream=False,
			timeout=10000,
		)
		bootstrap = _create(panel, td.textDAT, "bootstrap")
		bootstrap.text = _bootstrap_source()
		startup = _create(panel, td.executeDAT, "startup")
		_set(
			startup,
			active=bool(activate),
			start=True,
			create=True,
			exit=True,
			framestart=False,
			frameend=False,
			playstatechange=False,
			devicechange=False,
		)
		startup.text = (
			'import sys\ndef onStart():\n    if parent().par.Autostart.eval(): parent().op("bootstrap").run()\n'
			'def onCreate():\n    if parent().par.Autostart.eval(): parent().op("bootstrap").run(delayMilliSeconds=1, wallTime=True)\n'
			"def onExit():\n"
			"    module = sys.modules.get('_td_architecture_runtime.controller')\n"
			"    if module: module.stop(parent().path)\n"
		)
		window = _create(panel, td.windowCOMP, "window")
		_set(window, winop=panel, winw=920, winh=840, borders=True, alwaysontop=False)
		manifest_node = _create(panel, td.textDAT, MANIFEST_NODE)
		manifest = {
			"schemaVersion": 1,
			"cleanExport": bool(clean_export),
			"activation": "explicit-connect" if clean_export else "configured",
			"sourceHashes": source_hashes(),
			"inventory": inventory(panel),
			"datHashes": {
				child.name: digest(child.text)
				for child in panel.children
				if getattr(child, "text", "")
			},
			"labelHashes": {
				child.name: digest(str(child.par.label.eval()))
				for child in panel.children
				if child.name.startswith("ui_")
				and not child.name.endswith("_click")
				and child.name != "ui_filters"
			},
		}
		manifest_node.text = json.dumps(manifest, sort_keys=True)
		for index, child in enumerate(panel.children):
			child.nodeX, child.nodeY = (index % 8) * 170, -(index // 8) * 130
		if activate:
			bootstrap.run()
		if open_window:
			window.par.winopen.pulse()
		return {
			"architectureObserver": 1,
			"cleanExport": bool(clean_export),
			"path": panel.path,
			"windowPath": window.path,
			"visibleRows": PAGE_SIZE,
			"export": "Use export_clean on a fresh install_clean_export build for distribution",
		}
	except Exception:
		# Only this newly-created and tagged UI subtree is eligible for cleanup.
		panel.destroy()
		raise


def source_hashes():
	"""Repository-relative provenance; no user paths or project data are included."""
	if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != _LOADED_BUILDER_HASH:
		raise ValueError(
			"Reload the architecture package after source changes before building or exporting"
		)
	return {
		"td/architecture/" + name: hashlib.sha256(
			Path(__file__).with_name(name).read_bytes()
		).hexdigest()
		for name in (
			"__init__.py",
			"builder.py",
			"provenance.py",
			"observer.py",
			"client.py",
			"model.py",
			"controller.py",
		)
	}


def install_clean_export(td_module=None):
	"""Create a fresh, inert, project-neutral component; never scrub/reuse a live one."""
	return install(
		td_module=td_module, open_window=False, activate=False, clean_export=True
	)


def validate_clean_export(panel):
	manifest = validate_clean_panel(panel)
	if manifest["sourceHashes"] != source_hashes():
		raise ValueError(
			"Inspector embedded source hashes do not match the current checkout"
		)
	return manifest


def _receipt_path():
	return Path(__file__).with_name("inspector.build.json")


def export_clean(panel, output_path, build="2025.33230", td_module=None):
	"""Root-only live TD export followed by a verifiable source/binary receipt."""
	manifest = validate_clean_export(panel)
	if td_module is None:
		import td as td_module
	actual_build = str(td_module.app.build)
	if actual_build not in ("202533230", "2025.33230"):
		raise ValueError(
			"The running TouchDesigner build is not pinned build 2025.33230"
		)
	target = Path(output_path)
	if target.name != "inspector.tox" or target.is_symlink():
		raise ValueError("Distribution export must be a regular inspector.tox")
	if build != "2025.33230":
		raise ValueError(
			"Native export must use the pinned TouchDesigner build 2025.33230"
		)
	panel.save(str(target))
	validate_clean_export(panel)
	if (
		target.is_symlink()
		or not target.is_file()
		or not 0 < target.stat().st_size <= 4 * 1024 * 1024
	):
		raise ValueError("Native inspector export missing, empty, or larger than 4 MiB")
	receipt = {
		"schemaVersion": 1,
		"build": build,
		"cleanExport": True,
		"autostart": False,
		"sources": {
			Path(name).name: value for name, value in manifest["sourceHashes"].items()
		},
		"binary": {
			"path": target.name,
			"bytes": target.stat().st_size,
			"sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
		},
	}
	_receipt_path().write_text(
		json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
	)
	return receipt
