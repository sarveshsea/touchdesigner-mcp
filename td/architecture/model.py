"""Bounded inspector view model; no TD, HTTP, source evaluation or file writes."""

import copy
import json
import math

PAGE_SIZE = 18
MAX_ROWS = 5000
TABS = ("Network", "Classification", "Changes", "Memory")
ROLES = (
	"all",
	"input",
	"audio",
	"timing",
	"control",
	"geometry",
	"simulation",
	"materials",
	"rendering",
	"post",
	"typography",
	"output",
	"ui",
	"utilities",
	"documentation",
	"mixed",
	"unknown",
)


def text(value, length=160):
	return str(value).replace("\n", " ").replace("\r", " ").replace("\t", " ")[:length]


class InspectorModel:
	def __init__(self):
		self.snapshot = {}
		self.snapshot_query = None
		self._ready_hint_shown = False
		self.tab, self.search, self.role, self.page = "Network", "", "all", 0
		self.plan, self.plan_revision, self.selected_path = None, None, ""
		self.connection, self.message = (
			"Disconnected",
			"Start the architecture service, then Scan",
		)

	def update(self, snapshot, query=None):
		if not isinstance(snapshot, dict):
			raise ValueError("Inspector state must be an object")
		self.snapshot = dict(self.snapshot, **copy.deepcopy(snapshot))
		if "graph" in snapshot:
			self.snapshot_query = copy.deepcopy(query)
		self.connection = "Connected"
		if not self._ready_hint_shown and snapshot.get("graph") is not None:
			self._ready_hint_shown = True
			self.message = "Click a row for details; select network operators to preview a refactor."
		elif self.message == "Start the architecture service, then Scan":
			self.message = "Connected. Scan to build the operator graph."

	def preview(self, plan):
		if not isinstance(plan, dict):
			raise ValueError("Refactor preview must be an object")
		self.plan = copy.deepcopy(plan.get("plan", plan))
		self.plan_revision = self.plan.get(
			"revision", (self.snapshot.get("graph") or {}).get("revision")
		)
		self.tab, self.page = "Changes", 0
		self.message = "Preview ready. Stage creates the service-managed transaction."

	@property
	def plan_id(self):
		return (self.plan or {}).get("planId", (self.plan or {}).get("id"))

	@property
	def can_stage(self):
		graph = self.snapshot.get("graph") or {}
		revision = graph.get("revision")
		return bool(
			self.plan_id
			and revision is not None
			and self.plan_revision == revision
			and graph.get("status") == "fresh"
			and graph.get("complete") is True
			and not (self.plan or {}).get("blockedReasons")
			and (self.snapshot.get("job") or {}).get("status")
			not in ("queued", "scanning", "failed")
		)

	def describe(self, path):
		"""Describe bounded returned relationships; no dependency completeness claim."""
		graph = self.snapshot.get("graph") or {}
		node = next(
			(
				node
				for node in graph.get("nodes", [])[:MAX_ROWS]
				if node.get("path") == path
			),
			None,
		)
		if node is None:
			return text(path + ": details are outside the current page", 190)
		edges = [
			edge
			for edge in graph.get("edges", [])[:200]
			if edge.get("kind") != "containment"
			and path in (edge.get("source"), edge.get("target"))
		]
		incoming = sum(edge.get("target") == path for edge in edges)
		outgoing = sum(edge.get("source") == path for edge in edges)
		unresolved = sum(edge.get("evidence") == "unresolved" for edge in edges)
		classifications = (self.snapshot.get("classification") or {}).get(
			"classifications", []
		)
		classified = next(
			(item for item in classifications[:MAX_ROWS] if item.get("path") == path),
			{},
		)
		confidence = float(classified.get("confidence", 0))
		confidence = confidence if math.isfinite(confidence) else 0
		evidence = classified.get("evidence") or []
		rule = (
			text(evidence[0].get("ruleId", evidence[0].get("source", "unknown")), 40)
			if evidence
			else "no role evidence"
		)
		detail = (
			f"{node.get('family', 'OP')}/{node.get('opType', 'unknown')} | "
			f"{incoming} in / {outgoing} out shown | unresolved {unresolved} | "
			f"{classified.get('role', 'unknown')} {confidence:.0%} | {rule}"
		)
		if edges:
			edge = edges[0]
			peer = (
				edge.get("source") if edge.get("target") == path else edge.get("target")
			)
			detail += f" | {edge.get('kind', 'link')}: {peer}"
		return text(detail, 190)

	def _network_rows(self):
		classifications = (self.snapshot.get("classification") or {}).get(
			"classifications", []
		)[:MAX_ROWS]
		roles = {
			item.get("path"): item for item in classifications if isinstance(item, dict)
		}
		nodes = (self.snapshot.get("graph") or {}).get("nodes", [])[:MAX_ROWS]
		for node in nodes:
			path = node.get("path", "")
			classified = roles.get(path, {})
			role = classified.get("role", "unknown")
			if (
				"totalNodes" not in (self.snapshot.get("graph") or {})
				and self.role != "all"
				and role != self.role
			):
				continue
			if self.tab == "Classification":
				confidence = float(classified.get("confidence", 0))
				confidence = confidence if math.isfinite(confidence) else 0
				label = f"{role.upper():14} {confidence:.0%}   {path}"
			else:
				label = f"{node.get('family', 'OP'):4}  {role:14}  {path}"
			yield {"path": path, "label": text(label, 190)}

	def _rows(self):
		if self.tab in ("Network", "Classification"):
			return list(self._network_rows())
		if self.tab == "Memory":
			records = (self.snapshot.get("memory") or {}).get("records", [])[:MAX_ROWS]
		else:
			if self.plan and "affectedPaths" in self.plan:
				return self._plan_rows()
			document = self.plan or self.snapshot.get("transaction") or {}
			records = document.get(
				"operations", document.get("changes", document.get("actions", []))
			)
			if not records and document:
				records = [document]
		return [
			{
				"path": item.get("path", "") if isinstance(item, dict) else "",
				"label": text(json.dumps(item, ensure_ascii=False), 190),
			}
			for item in records[:MAX_ROWS]
		]

	def _plan_rows(self):
		plan = self.plan
		rows = [
			{"path": "", "label": "TARGET  " + text(plan.get("containerPath", ""), 160)}
		]
		rows += [
			{"path": "", "label": "BLOCKED  " + text(reason)}
			for reason in plan.get("blockedReasons", [])[:100]
		]
		rows += [
			{"path": path, "label": "STAGE  " + text(path)}
			for path in plan.get("affectedPaths", [])[:200]
		]
		rows += [
			{"path": "", "label": "PORT  " + text(json.dumps(port))}
			for port in plan.get("ports", [])[:200]
		]
		rows += [
			{
				"path": repair.get("owner", ""),
				"label": "REPAIR  " + text(json.dumps(repair)),
			}
			for repair in plan.get("repairs", [])[:200]
		]
		rows += [
			{"path": "", "label": key.upper() + "  " + text(value)}
			for key, value in plan.get("preview", {}).items()
		]
		return rows

	def query(self):
		network = self.tab in ("Network", "Classification")
		query = {
			"offset": max(0, min(int(self.page), 2777)) * PAGE_SIZE if network else 0,
			"limit": PAGE_SIZE,
			"search": self.search[:160] if network else "",
		}
		if network and self.role != "all":
			query["role"] = self.role
		return query

	def _remote_rows(self):
		graph = self.snapshot.get("graph") or {}
		total = max(0, min(int(graph["totalNodes"]), 50000))
		last = max(0, (total - 1) // PAGE_SIZE)
		page = max(0, min(int(self.page), last))
		rows = list(self._network_rows())[:PAGE_SIZE]
		if int(graph.get("offset", 0)) != page * PAGE_SIZE:
			rows = []
		if self.snapshot_query is not None and self.snapshot_query != self.query():
			rows = []
		return {
			"rows": rows,
			"total": total,
			"page": page,
			"pages": last + 1,
			"bounded": PAGE_SIZE,
		}

	def rows(self):
		if self.tab in ("Network", "Classification") and "totalNodes" in (
			self.snapshot.get("graph") or {}
		):
			return self._remote_rows()
		query = self.search.casefold()[:160]
		rows = [row for row in self._rows() if query in row["label"].casefold()]
		if self.tab in ("Network", "Classification"):
			rows.sort(key=lambda row: row["path"])
		last = max(0, (len(rows) - 1) // PAGE_SIZE)
		page = max(0, min(int(self.page), last))
		return {
			"rows": rows[page * PAGE_SIZE : (page + 1) * PAGE_SIZE],
			"total": len(rows),
			"page": page,
			"pages": last + 1,
			"bounded": MAX_ROWS,
		}

	def summary(self):
		graph = self.snapshot.get("graph") or {}
		transaction = self.snapshot.get("transaction") or {}
		job = self.snapshot.get("job") or {}
		if job.get("status") in ("queued", "scanning", "failed"):
			phase = "SCAN FAILED" if job["status"] == "failed" else "SCANNING"
			visited = text(job.get("visited", 0), 12)
			remaining = job.get("remaining")
			progress = f"{visited} visited"
			if remaining is not None:
				progress += f" / {text(remaining, 12)} remaining"
			return text(
				f"{self.connection} | {phase} | {progress} | incomplete "
				f"| retained r{graph.get('revision', '—')} "
				f"| transaction: {transaction.get('status', 'none')}",
				190,
			)
		return text(
			f"{self.connection} | {graph.get('status', 'unscanned').upper()} "
			f"| r{graph.get('revision', '—')} | "
			f"{'complete' if graph.get('complete') else 'partial/unscanned'} "
			f"| transaction: {transaction.get('status', 'none')}",
			190,
		)
