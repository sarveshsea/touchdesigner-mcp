import { z } from "zod";
import type { BridgeExecutor, ProjectGraph } from "../types.js";
import { decodeBridgeResult } from "./schema.js";

const dirtySchema = z.object({
	active: z.boolean().optional(),
	dirty_revision: z.number().int().nonnegative(),
	dropped: z.number().int().nonnegative(),
	events: z
		.array(
			z.object({
				at: z.number().finite(),
				kind: z.string().max(64),
				parentPath: z.string().max(2048),
				path: z.string().max(2048),
				revision: z.number().int().nonnegative(),
			}),
		)
		.max(1024),
	project_identity: z.string().max(128),
	remaining: z.number().int().nonnegative(),
	session_id: z.string().max(128),
});
export type DirtyGraphEvents = z.infer<typeof dirtySchema>;
/** Read the optional observer's bounded ledger. This never installs watchers. */
export async function drainGraphDirtyEvents(
	executor: BridgeExecutor,
	limit = 256,
): Promise<DirtyGraphEvents> {
	const checked = z.number().int().min(1).max(1024).parse(limit);
	const script = `import json, sys\n_dm=sys.modules.get('_td_mcp_architecture')\nif _dm is not None and callable(getattr(_dm,'drain',None)):\n    _dr=_dm.drain(${checked})\nelse:\n    _dr=dict(events=[],remaining=0,dropped=0,dirty_revision=0,session_id='',project_identity='',active=False)\nresult=json.dumps(_dr)\n`;
	return dirtySchema.parse(decodeBridgeResult(await executor.execute(script)));
}
/** Events invalidate freshness without fabricating a new observed revision.
 * Overflow/session replacement requires a complete rescan, not delta patching.
 * A quiet ledger is not proof of freshness: its registered-path coverage is partial.
 */
export function markGraphDirty(
	graph: ProjectGraph,
	batch: DirtyGraphEvents,
): ProjectGraph {
	const checked = dirtySchema.parse(batch);
	if (checked.active === false)
		return {
			...graph,
			status: "stale",
			warnings: [
				...graph.warnings,
				"Observer unavailable; reconciliation required",
			].slice(-100),
		};
	const invalidated =
		checked.session_id !== graph.sessionId || checked.dropped > 0;
	if (!invalidated && !checked.events.length && !checked.remaining)
		return graph;
	return {
		...graph,
		complete: invalidated ? false : graph.complete,
		dependencyComplete: false,
		status: "stale",
		warnings: [
			...graph.warnings,
			invalidated
				? "Observer epoch changed or ledger overflowed; full rescan required"
				: "Observed network changes; graph reconciliation pending",
		].slice(-100),
	};
}
