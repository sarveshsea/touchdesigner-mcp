import { z } from "zod";

const absoluteOperatorPath = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/)
	.refine(
		(path) => path === path.trim(),
		"Operator paths must be canonical absolute paths",
	);

/** Deliberately narrow: this tool only places immediate children on a grid. */
export const layoutNetworkScriptParamsSchema = z.strictObject({
	columns: z.number().int().min(1).max(12).default(4),
	dryRun: z.boolean().default(true),
	nodePaths: z
		.array(absoluteOperatorPath)
		.max(200)
		.refine(
			(paths) => new Set(paths).size === paths.length,
			"Duplicate node paths are not allowed",
		)
		.optional(),
	originX: z.number().int().min(-1_000_000).max(1_000_000).default(0),
	originY: z.number().int().min(-1_000_000).max(1_000_000).default(0),
	parentPath: absoluteOperatorPath,
	spacingX: z.number().int().min(180).max(1000).default(260),
	spacingY: z.number().int().min(140).max(1000).default(180),
});

export type LayoutNetworkScriptParams = z.input<
	typeof layoutNetworkScriptParamsSchema
>;

/**
 * Preflight the entire bounded plan, then update nodeX/nodeY only. Restoration
 * after setter failure is best effort, with explicit per-coordinate errors.
 * No selection, current flag, parameter, operator hierarchy or cooking changes.
 */
export function buildLayoutNetworkScript(
	input: LayoutNetworkScriptParams,
): string {
	const params = layoutNetworkScriptParamsSchema.parse(input);
	// Encode a JSON document inside a Python string literal. Canonical ASCII
	// operator paths and finite numeric fields avoid cross-language escape cases.
	const documentLiteral = JSON.stringify(JSON.stringify(params));
	return `import json
import math

layout_params = json.loads(${documentLiteral})
layout_parent_path = layout_params["parentPath"]
layout_parent = op(layout_parent_path)
if layout_parent is None or layout_parent.family != "COMP":
    raise ValueError("Layout parent must resolve to a COMP: " + layout_parent_path)
if layout_parent.path != layout_parent_path:
    raise ValueError("Layout parent resolved to a different path: " + layout_parent_path)

layout_paths = layout_params.get("nodePaths")
if layout_paths is None:
    layout_nodes = list(layout_parent.children)
    if len(layout_nodes) > 200:
        raise ValueError("Layout exceeds 200 immediate children; select an explicit subset")
else:
    layout_nodes = []
    for layout_path in layout_paths:
        layout_node = op(layout_path)
        if layout_node is None or layout_node.path != layout_path:
            raise ValueError("Layout node does not resolve exactly: " + layout_path)
        layout_nodes.append(layout_node)

# Every scope and coordinate check completes before the first setter call.
for layout_node in layout_nodes:
    layout_owner = layout_node.parent()
    if layout_owner is None or layout_owner.path != layout_parent_path:
        raise ValueError("Layout requires immediate children of " + layout_parent_path
                         + "; rejected " + layout_node.path)
layout_nodes = sorted(layout_nodes, key=lambda node: node.path)
if len(set(node.path for node in layout_nodes)) != len(layout_nodes):
    raise ValueError("Layout resolved duplicate operators")
layout_changes = []
for layout_index, layout_node in enumerate(layout_nodes):
    layout_before = {"x": layout_node.nodeX, "y": layout_node.nodeY}
    layout_after = {
        "x": layout_params["originX"] + (layout_index % layout_params["columns"]) * layout_params["spacingX"],
        "y": layout_params["originY"] - (layout_index // layout_params["columns"]) * layout_params["spacingY"],
    }
    if not all(math.isfinite(value) for value in list(layout_before.values()) + list(layout_after.values())):
        raise ValueError("Layout coordinates must be finite: " + layout_node.path)
    layout_changes.append({"path": layout_node.path, "before": layout_before, "after": layout_after})

layout_touched = []
if not layout_params["dryRun"]:
    try:
        for layout_node, layout_change in zip(layout_nodes, layout_changes):
            # Record before either setter: a failing setter may partially write.
            layout_touched.append((layout_node, layout_change))
            for layout_write_coordinate, layout_write_key in (("nodeX", "x"), ("nodeY", "y")):
                layout_requested = layout_change["after"][layout_write_key]
                setattr(layout_node, layout_write_coordinate, layout_requested)
                if getattr(layout_node, layout_write_coordinate) != layout_requested:
                    raise RuntimeError(layout_write_coordinate + " did not retain its requested value")
    except Exception as layout_failure:
        layout_failed_path = layout_change["path"]
        layout_restore_errors = []
        for layout_restore_node, layout_restore_change in reversed(layout_touched):
            for layout_coordinate, layout_key in (("nodeX", "x"), ("nodeY", "y")):
                try:
                    layout_expected = layout_restore_change["before"][layout_key]
                    setattr(layout_restore_node, layout_coordinate, layout_expected)
                    if getattr(layout_restore_node, layout_coordinate) != layout_expected:
                        raise RuntimeError("Coordinate did not retain its restored value")
                except Exception as layout_restore_failure:
                    layout_restore_errors.append({
                        "path": layout_restore_change["path"], "coordinate": layout_coordinate,
                        "error": str(layout_restore_failure),
                    })
        raise RuntimeError(json.dumps({
            "message": "Layout write failed; attempted coordinate restoration. Review the affected nodes before retrying.",
            "failedPath": layout_failed_path, "failedCoordinate": layout_write_coordinate,
            "writeError": str(layout_failure),
            "restorationComplete": not layout_restore_errors,
            "restorationErrors": layout_restore_errors, "changes": layout_changes,
        })) from layout_failure

result = json.dumps({"parentPath": layout_parent_path, "dryRun": layout_params["dryRun"],
                     "count": len(layout_changes), "changes": layout_changes})
`;
}
