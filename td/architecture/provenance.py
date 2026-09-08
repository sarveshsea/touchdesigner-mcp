"""Embedded source integrity and pristine-export checks; no service/network access."""

import hashlib
import json
import re

OWNER_TAG = "td_architecture_owned_v1"
MANIFEST_NODE = "build_manifest"
MAX_MANIFEST_BYTES = 128 * 1024


def digest(value):
	return hashlib.sha256(value.encode("utf-8")).hexdigest()


def verify_panel(panel):
	manifest_node = panel.op(MANIFEST_NODE)
	if (
		manifest_node is None
		or len(manifest_node.text.encode("utf-8")) > MAX_MANIFEST_BYTES
	):
		raise ValueError("Inspector source manifest is missing or oversized")
	manifest = json.loads(manifest_node.text)
	if not isinstance(manifest, dict) or set(manifest) != {
		"schemaVersion",
		"cleanExport",
		"activation",
		"sourceHashes",
		"inventory",
		"datHashes",
		"labelHashes",
	}:
		raise ValueError(
			"Inspector source manifest contains unexpected or missing fields"
		)
	if manifest.get("schemaVersion") != 1 or not isinstance(
		manifest.get("datHashes"), dict
	):
		raise ValueError("Inspector source manifest has an unsupported format")
	if not 1 <= len(manifest["datHashes"]) <= 100:
		raise ValueError("Inspector source manifest exceeds its node bound")
	for name, expected in manifest["datHashes"].items():
		if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
			raise ValueError(
				"Inspector source manifest contains an invalid local node name"
			)
		node = panel.op(name)
		if node is None or digest(node.text) != expected:
			raise ValueError("Inspector source hash mismatch: " + name)
	return manifest


def descendants(panel):
	pending = list(panel.children)
	result = []
	while pending:
		node = pending.pop(0)
		result.append(node)
		if len(result) > 512:
			raise ValueError("Clean export exceeds its descendant inventory bound")
		pending.extend(getattr(node, "children", ()))
	return result


def configuration_hash(node):
	values = []
	for par in node.pars():
		value = par.val
		if hasattr(value, "path"):
			value = value.path
		values.append(
			(
				par.name,
				str(value),
				str(getattr(par, "expr", "")),
				str(getattr(par, "mode", "")),
			)
		)
	return digest(json.dumps(sorted(values), sort_keys=True))


def inventory(panel):
	return {
		node.path[len(panel.path) + 1 :]: {
			"type": str(getattr(node, "type", node.family)),
			"textHash": "self-manifest"
			if node is panel.op(MANIFEST_NODE)
			else digest(str(getattr(node, "text", ""))),
			"configurationHash": configuration_hash(node),
			"commentHash": digest(str(getattr(node, "comment", ""))),
		}
		for node in (panel, *descendants(panel))
	}


def validate_clean_panel(panel):
	manifest = verify_panel(panel)
	if (
		OWNER_TAG not in panel.tags
		or manifest.get("cleanExport") is not True
		or manifest.get("activation") != "explicit-connect"
	):
		raise ValueError(
			"Only a freshly built clean-export inspector can be distributed"
		)
	if panel.par.Autostart.eval() or not panel.par.Cleanexport.eval():
		raise ValueError("Inspector must remain inactive in clean-export mode")
	for name in ("startup", "observer", "service_client"):
		if panel.op(name).par.active.eval():
			raise ValueError("Clean-export operator is active: " + name)
	client = panel.op("service_client")
	if client.text.strip() or getattr(client, "connections", ()):
		raise ValueError(
			"Clean export contains a cached WebClient response or live connection"
		)
	for name, expected in {
		"Rootpath": "/project1",
		"Search": "",
		"Role": "all",
		"Subsystem": "Subsystem",
	}.items():
		if getattr(panel.par, name).eval() != expected:
			raise ValueError(
				"Clean export contains a project-specific parameter: " + name
			)
	for name, expected in manifest.get("labelHashes", {}).items():
		if digest(str(panel.op(name).par.label.eval())) != expected:
			raise ValueError("Clean export contains a changed UI label: " + name)
	current_inventory = inventory(panel)
	if set(current_inventory) != set(manifest.get("inventory", {})):
		raise ValueError("Clean export descendant inventory changed")
	if current_inventory != manifest["inventory"]:
		raise ValueError("Clean export operator data or configuration changed")
	for node in (panel, *descendants(panel)):
		if getattr(node, "storage", {}):
			raise ValueError("Clean export contains component storage: " + node.name)
	return manifest
