import { z } from "zod";

export const networkSnapshotParamsSchema = z.strictObject({
	maxDepth: z.number().int().min(0).max(8).default(2),
	maxNodes: z.number().int().min(1).max(500).default(100),
	parentPath: z
		.string()
		.min(1)
		.max(2048)
		.refine((path) => !path.includes("\0")),
});

export type NetworkSnapshotScriptParams = z.input<
	typeof networkSnapshotParamsSchema
>;

/** Read-only, root-inclusive BFS. Limits bound inspected nodes and wire fanout.
 * Truncation counts describe omitted direct references, never unvisited subtrees.
 * DAT text, parameter contents, recursive diagnostics and forced cooks are absent.
 */
export function buildNetworkSnapshotScript(
	params: NetworkSnapshotScriptParams,
): string {
	const payload = Buffer.from(
		JSON.stringify(networkSnapshotParamsSchema.parse(params)),
		"utf8",
	).toString("base64");
	return `import base64
import json
import math
from collections import deque
from itertools import islice

_ns_request = json.loads(base64.b64decode("${payload}").decode("utf-8"))
_ns_limits = dict(maxDepth=_ns_request["maxDepth"], maxNodes=_ns_request["maxNodes"],
    maxConnections=min(2000, _ns_request["maxNodes"] * 8),
    connectorsPerNode=64, diagnosticsPerKind=4, diagnosticChars=256, fieldChars=512)
_ns_truncation = dict(nodeLimitedChildReferences=0, depthLimitedChildReferences=0,
    connectors=0, connections=0, diagnosticMessages=0, clippedStrings=0)
_ns_report = dict(ok=True, parentPath=_ns_request["parentPath"], nodes=[],
    connections=[], limits=_ns_limits, truncation=_ns_truncation, truncated=False)

def _ns_text(value, limit=512):
    text = str(value)
    if len(text) > limit:
        _ns_truncation["clippedStrings"] += 1
    return text[:limit]

def _ns_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None

def _ns_id(node):
    value = getattr(node, "id", None)
    return value if isinstance(value, int) else _ns_text(getattr(node, "path", ""))

def _ns_key(node):
    return getattr(node, "id", None) or str(getattr(node, "path", ""))

def _ns_diagnostics(node, kind):
    method = getattr(node, kind, None)
    if method is None:
        return []
    try:
        messages = method(recurse=False)
    except Exception as error:
        return ["Diagnostic read failed: " + type(error).__name__]
    if not messages:
        return []
    if isinstance(messages, str):
        messages = [messages]
    count = len(messages)
    _ns_truncation["diagnosticMessages"] += max(0, count - _ns_limits["diagnosticsPerKind"])
    return [_ns_text(message, _ns_limits["diagnosticChars"])
            for message in islice(messages, _ns_limits["diagnosticsPerKind"])]

def _ns_wire_ports(node, ports, capacity, kind):
    _ns_truncation["connectors"] += max(0, len(ports) - capacity)
    for fallback_index, port in enumerate(islice(ports, capacity)):
        links = getattr(port, "connections", ())
        remaining = _ns_limits["maxConnections"] - len(_ns_report["connections"])
        _ns_truncation["connections"] += max(0, len(links) - remaining)
        for link in islice(links, remaining):
            source = getattr(link, "owner", None)
            if source is None:
                source = getattr(link, "ownerOP", None)
            if source is None:
                _ns_truncation["connections"] += 1
                continue
            _ns_report["connections"].append(dict(
                kind=kind,
                sourceId=_ns_id(source), sourcePath=_ns_text(getattr(source, "path", "")),
                targetId=_ns_id(node), targetPath=_ns_text(node.path),
                inputIndex=_ns_number(getattr(port, "index", fallback_index)),
                outputIndex=_ns_number(getattr(link, "index", None))))

def _ns_wires(node):
    capacity = _ns_limits["connectorsPerNode"]
    for name, kind in (("inputConnectors", "operator"), ("inputCOMPConnectors", "component")):
        ports = getattr(node, name, ())
        _ns_wire_ports(node, ports, capacity, kind)
        capacity = max(0, capacity - len(ports))

_ns_root = op(_ns_request["parentPath"])
if _ns_root is None:
    _ns_report["ok"] = False
    _ns_report["error"] = dict(code="PARENT_NOT_FOUND", message="Parent operator was not found")
else:
    _ns_queue = deque([(_ns_root, 0)])
    _ns_seen = {_ns_key(_ns_root)}
    while _ns_queue:
        _ns_node, _ns_depth = _ns_queue.popleft()
        _ns_entry = dict(id=_ns_id(_ns_node), path=_ns_text(_ns_node.path),
            name=_ns_text(_ns_node.name), family=_ns_text(_ns_node.family),
            type=_ns_text(_ns_node.type), depth=_ns_depth,
            flags={name: bool(getattr(_ns_node, name)) if hasattr(_ns_node, name) else None
                   for name in ("allowCooking", "bypass", "lock", "viewer", "display", "render")},
            errors=_ns_diagnostics(_ns_node, "errors"), warnings=_ns_diagnostics(_ns_node, "warnings"))
        for _ns_field in ("nodeX", "nodeY", "nodeWidth", "nodeHeight"):
            _ns_entry[_ns_field] = _ns_number(getattr(_ns_node, _ns_field, None))
        _ns_report["nodes"].append(_ns_entry)
        _ns_wires(_ns_node)
        _ns_children = getattr(_ns_node, "children", ())
        if _ns_depth >= _ns_limits["maxDepth"]:
            _ns_truncation["depthLimitedChildReferences"] += len(_ns_children)
            continue
        _ns_available = _ns_limits["maxNodes"] - len(_ns_seen)
        # Reading a bounded prefix avoids iterating enormous child collections.
        _ns_truncation["nodeLimitedChildReferences"] += max(0, len(_ns_children) - _ns_available)
        for _ns_child in islice(_ns_children, _ns_available):
            _ns_child_key = _ns_key(_ns_child)
            if _ns_child_key not in _ns_seen:
                _ns_seen.add(_ns_child_key)
                _ns_queue.append((_ns_child, _ns_depth + 1))
_ns_report["nodeCount"] = len(_ns_report["nodes"])
_ns_report["connectionCount"] = len(_ns_report["connections"])
_ns_report["truncated"] = any(_ns_truncation.values())
result = json.dumps(_ns_report, ensure_ascii=True, allow_nan=False)
`;
}
