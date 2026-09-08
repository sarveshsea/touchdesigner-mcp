"""Native inspector actions and low-frequency async polling, outside render hooks."""

import uuid

from . import observer
from .client import LocalClient
from .model import PAGE_SIZE, TABS, InspectorModel, text

_instances = {}


class Controller:
	def __init__(self, panel, td_module, ui_context, run_function, project):
		self.panel, self.td, self.ui, self.run = (
			panel,
			td_module,
			ui_context,
			run_function,
		)
		self.generation = str(uuid.uuid4())
		self.model = InspectorModel()
		self.client = LocalClient(panel.op("service_client"), self.received)
		observer.configure(
			panel.op("observer"),
			panel.op,
			{"folder": str(project.folder), "name": str(project.name)},
		)
		observer.start(str(panel.par.Rootpath.eval()))
		self.rows = []
		self.refresh()

	def received(self, response):
		method, result = response["method"], response.get("result") or {}
		if method == "inspector_state":
			self.model.update(result, response.get("requestParams"))
		elif method == "plan_td_refactor":
			self.model.preview(result)
		elif method == "stage_td_refactor":
			self.model.update({"transaction": result})
			self.model.plan = None
			self.model.message = "Staging finished; inspect the transaction result"
		elif method == "map_td_project" and result.get("job"):
			self.model.update({"job": result["job"]})
			self.model.message = (
				"Background scan accepted; progress updates automatically"
			)
		else:
			self.model.message = method + " finished; refreshing shared state"
		self.refresh()

	def send(self, method, params):
		if not self.client.request(method, params):
			self.model.message = self.client.error or "Another request is in progress"
		else:
			if method == "map_td_project" and params.get("wait") is False:
				self.model.snapshot = dict(
					self.model.snapshot, job={"status": "queued", "visited": 0}
				)
			self.model.message = method + "…"
		self.refresh()

	def filters(self):
		self.model.search = str(self.panel.par.Search.eval())[:160]
		self.model.role = str(self.panel.par.Role.eval())
		self.model.page = 0
		self.send("inspector_state", self.model.query())

	def focus(self, path):
		node = self.panel.op(path)
		if node is None:
			self.model.message = "Operator no longer exists; scan again"
			return
		self.model.selected_path = path
		self.model.message = self.model.describe(path)
		panes = [
			pane
			for pane in self.ui.panes
			if pane.type == self.td.PaneType.NETWORKEDITOR
		]
		if not panes:
			self.model.message = text(
				self.model.message + " | open Network Editor to focus", 190
			)
			return
		pane = panes[0]
		pane.owner = node.parent()
		pane.home(zoom=False, op=node)

	def selected_paths(self):
		for pane in self.ui.panes:
			if pane.type == self.td.PaneType.NETWORKEDITOR:
				selected = [node.path for node in pane.owner.selectedChildren]
				if selected:
					return selected[
						:201
					]  # Service rejects overflow, never silently stages a subset.
		return [self.model.selected_path] if self.model.selected_path else []

	def action(self, action, argument=None):
		try:
			root = str(self.panel.par.Rootpath.eval())
			if action == "tab":
				if argument not in TABS:
					raise ValueError("Unknown inspector tab")
				self.model.tab, self.model.page = argument, 0
				self.send("inspector_state", self.model.query())
			elif action == "row":
				index = int(argument)
				if 0 <= index < len(self.rows) and self.rows[index]["path"]:
					self.focus(self.rows[index]["path"])
			elif action == "page":
				self.model.page = max(0, self.model.page + int(argument))
				self.model.page = self.model.rows()["page"]
				if self.model.tab in ("Network", "Classification"):
					self.send("inspector_state", self.model.query())
			elif action == "scan":
				if root != observer.root_path:
					observer.start(root)
				self.send(
					"map_td_project",
					{
						"action": "refresh",
						"rootPath": root,
						"dependencyAnalysis": False,
						"summaryOnly": True,
						"wait": False,
					},
				)
			elif action == "watch":
				self.send(
					"map_td_project",
					{
						"action": "watch",
						"rootPath": root,
						"dependencyAnalysis": False,
						"summaryOnly": True,
						"wait": False,
					},
				)
			elif action == "classify":
				self.send(
					"classify_td_network", {"rootPath": root, "summaryOnly": True}
				)
			elif action == "preview":
				paths = self.selected_paths()
				if not paths:
					raise ValueError(
						"Select operators in the network or click a row before Preview"
					)
				self.send(
					"plan_td_refactor",
					{"paths": paths, "name": str(self.panel.par.Subsystem.eval())},
				)
			elif action == "stage":
				if not self.model.can_stage:
					raise ValueError("Preview the current revision before staging")
				self.send(
					"stage_td_refactor",
					{"action": "apply", "planId": self.model.plan_id},
				)
			elif action == "dock":
				pane = self.ui.panes.current.splitRight()
				pane = pane.changeType(self.td.PaneType.PANEL)
				pane.owner = self.panel
			else:
				raise ValueError("Unknown inspector action")
		except Exception as error:
			self.model.message = text(error, 190)
		self.refresh()

	def refresh(self):
		page = self.model.rows()
		self.rows, self.model.page = page["rows"], page["page"]
		self.panel.op("ui_status").par.label.val = self.model.summary()
		self.panel.op("ui_message").par.label.val = text(
			self.client.error or self.model.message, 190
		)
		self.panel.op(
			"ui_pagination"
		).par.label.val = f"Page {page['page'] + 1} / {page['pages']}   ·   {page['total']} matches   ·   {PAGE_SIZE} visible rows"
		self.panel.op("ui_stage").par.enable.val = (
			self.model.can_stage and self.client.pending is None
		)
		for index in range(PAGE_SIZE):
			node = self.panel.op(f"ui_row_{index:02}")
			node.par.label.val = (
				self.rows[index]["label"] if index < len(self.rows) else ""
			)
			node.par.enable.val = index < len(self.rows)
		for tab in TABS:
			self.panel.op("ui_tab_" + tab.lower()).par.bgcolorg.val = (
				0.25 if self.model.tab == tab else 0.09
			)

	def tick(self):
		self.client.expire()
		if self.client.pending is None:
			self.client.request("inspector_state", self.model.query())
		if self.client.error:
			self.model.connection = "Disconnected · snapshot retained"
		self.refresh()
		self.run(
			"import sys; sys.modules['_td_architecture_runtime.controller'].tick(args[0], args[1])",
			self.panel.path,
			self.generation,
			delayMilliSeconds=2000,
			wallTime=True,
		)


def mount(panel, td_module, ui_context, run_function, project):
	previous = _instances.get(panel.path)
	if previous:
		previous.client.close()
	controller = Controller(panel, td_module, ui_context, run_function, project)
	_instances[panel.path] = controller
	controller.tick()
	return controller


def tick(path, generation):
	controller = _instances.get(path)
	if controller and controller.generation == generation and controller.panel.valid:
		controller.tick()


def action(path, name, argument=None):
	controller = _instances.get(path)
	if controller:
		controller.action(name, argument)


def filters(path):
	controller = _instances.get(path)
	if controller:
		controller.filters()


def response(path, status_code, data, request_id=None):
	controller = _instances.get(path)
	if controller:
		controller.client.response(status_code, data, request_id)
		controller.refresh()


def stop(path):
	controller = _instances.pop(path, None)
	if controller:
		controller.client.close()
		observer.stop()
