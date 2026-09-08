import type { ProjectGraph } from "../types.js";
export interface GraphDiff {
	invalidated: boolean;
	added: string[];
	removed: string[];
	changed: string[];
	edgesAdded: string[];
	edgesRemoved: string[];
	fromRevision: number;
	toRevision: number;
}
/** OP IDs are comparable only inside the same project/session epoch. */
export function graphDiff(
	previous: ProjectGraph,
	next: ProjectGraph,
): GraphDiff {
	const invalidated =
		previous.sessionId !== next.sessionId ||
		previous.projectId !== next.projectId ||
		previous.rootPath !== next.rootPath;
	const before = new Map(previous.nodes.map((n) => [n.id, n]));
	const after = new Map(next.nodes.map((n) => [n.id, n]));
	const oldEdges = new Set(previous.edges.map((e) => e.id));
	const newEdges = new Set(next.edges.map((e) => e.id));
	return {
		added: next.nodes
			.filter((n) => invalidated || !before.has(n.id))
			.map((n) => n.path),
		changed: invalidated
			? []
			: next.nodes
					.filter((n) => {
						const old = before.get(n.id);
						return (
							old && (old.path !== n.path || old.fingerprint !== n.fingerprint)
						);
					})
					.map((n) => n.path),
		edgesAdded: [...newEdges].filter((id) => invalidated || !oldEdges.has(id)),
		edgesRemoved: [...oldEdges].filter(
			(id) => invalidated || !newEdges.has(id),
		),
		fromRevision: previous.revision,
		invalidated,
		removed: previous.nodes
			.filter((n) => invalidated || !after.has(n.id))
			.map((n) => n.path),
		toRevision: next.revision,
	};
}
