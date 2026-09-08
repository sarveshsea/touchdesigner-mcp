import type {
	Classification,
	GraphNode,
	LayoutProposal,
	ProjectGraph,
} from "../types.js";
import { stronglyConnectedComponents } from "./scc.js";

export function dependencyEdges(
	graph: ProjectGraph,
	index: Map<string, number>,
): Array<[number, number]> {
	const edges: Array<[number, number]> = [];
	const seen = new Set<number>();
	const add = (source: string, target: string) => {
		const a = index.get(source);
		const b = index.get(target);
		if (a !== undefined && b !== undefined) {
			const key = a * graph.nodes.length + b;
			if (seen.has(key)) return;
			seen.add(key);
			if (edges.length >= 500000)
				throw new Error("Dependency edge budget exceeded (500000).");
			edges.push([a, b]);
		}
	};
	for (const edge of graph.edges)
		if (
			edge.evidence !== "unresolved" &&
			(edge.kind === "wire" ||
				edge.kind === "component-wire" ||
				edge.kind === "export" ||
				edge.kind === "parameter" ||
				edge.kind === "expression" ||
				edge.kind === "binding")
		)
			add(edge.source, edge.target);
	for (const node of graph.nodes)
		for (const reference of node.parameterReferences ?? [])
			if (reference.evidence !== "unresolved")
				for (const target of reference.targetPaths) add(target, node.path);
	return edges;
}
function pinned(node: GraphNode, pins: Set<string>): boolean {
	return (
		pins.has(node.path) ||
		node.flags.pinned === true ||
		node.flags.docked === true ||
		node.flags.annotation === true ||
		node.ownership.some((value) => value !== "source-code") ||
		["annotatecomp", "commentcomp"].includes(node.opType.toLowerCase()) ||
		node.tags.includes("layout:pin")
	);
}
function dimension(value: number | undefined, fallback: number): number {
	return Number.isFinite(value)
		? Math.max(20, Math.min(2000, value as number))
		: fallback;
}
/** Coordinate-only layout. Every path stays in its existing parent network. */
export function proposeLayout(
	graph: ProjectGraph,
	classifications: Classification[],
	options: { pins: string[]; columnGap: number; rowGap: number },
	edges: Array<[number, number]>,
): LayoutProposal[] {
	// Components can cross hierarchy boundaries; only sibling edges define coordinates.
	const siblings = edges.filter(
		([a, b]) => graph.nodes[a].parentPath === graph.nodes[b].parentPath,
	);
	const { components, componentOf } = stronglyConnectedComponents(
		graph.nodes.length,
		siblings,
	);
	const globalGroups =
		siblings.length === edges.length
			? { componentOf, components }
			: stronglyConnectedComponents(graph.nodes.length, edges);
	const groupNames = globalGroups.components.map((members) =>
		members.reduce(
			(name, member) =>
				graph.nodes[member].path < name ? graph.nodes[member].path : name,
			graph.nodes[members[0]].path,
		),
	);
	const globalSelfLoops = new Set(
		edges.filter(([a, b]) => a === b).map(([a]) => a),
	);
	const outgoing: number[][] = Array.from(
		{ length: components.length },
		() => [],
	);
	const indegree = new Uint32Array(components.length);
	for (const [a, b] of siblings)
		if (componentOf[a] !== componentOf[b]) {
			outgoing[componentOf[a]].push(componentOf[b]);
			indegree[componentOf[b]]++;
		}
	const column = new Uint32Array(components.length);
	const queue: number[] = [];
	for (let i = 0; i < components.length; i++)
		if (indegree[i] === 0) queue.push(i);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const current = queue[cursor];
		for (const next of outgoing[current]) {
			column[next] = Math.max(column[next], column[current] + 1);
			if (--indegree[next] === 0) queue.push(next);
		}
	}
	const pins = new Set(options.pins);
	const dimensions = new Map<string, { width: number; height: number }>();
	const pinnedFloor = new Map<string, number>();
	for (const node of graph.nodes) {
		const old = dimensions.get(node.parentPath) ?? { height: 90, width: 130 };
		dimensions.set(node.parentPath, {
			height: Math.max(old.height, dimension(node.nodeHeight, 90)),
			width: Math.max(old.width, dimension(node.nodeWidth, 130)),
		});
		if (pinned(node, pins)) {
			pinnedFloor.set(
				node.parentPath,
				Math.min(pinnedFloor.get(node.parentPath) ?? 0, node.nodeY),
			);
		}
	}
	const rows = new Map<string, number>();
	const proposed = new Map<number, LayoutProposal>();
	const groups = components
		.map((members, id) => ({
			id,
			members: [...members].sort((a, b) =>
				graph.nodes[a].path.localeCompare(graph.nodes[b].path),
			),
		}))
		.sort((a, b) => {
			const left = graph.nodes[a.members[0]];
			const right = graph.nodes[b.members[0]];
			return (
				left.parentPath.localeCompare(right.parentPath) ||
				column[a.id] - column[b.id] ||
				classifications[a.members[0]].role.localeCompare(
					classifications[b.members[0]].role,
				) ||
				left.path.localeCompare(right.path)
			);
		});
	for (const { members, id } of groups) {
		const first = graph.nodes[members[0]];
		const { width, height } = dimensions.get(first.parentPath) as {
			width: number;
			height: number;
		};
		const key = `${first.parentPath}:${column[id]}`;
		const globalId = globalGroups.componentOf[members[0]];
		const group =
			globalGroups.components[globalId].length > 1 ||
			globalSelfLoops.has(members[0])
				? `feedback:${groupNames[globalId]}`
				: `${classifications[members[0]].role}:${first.path}`;
		let row = rows.get(key) ?? 0;
		for (const member of members) {
			const node = graph.nodes[member];
			if (pinned(node, pins)) {
				proposed.set(member, {
					group,
					path: node.path,
					pinned: true,
					x: node.nodeX,
					y: node.nodeY,
				});
				continue;
			}
			const x = column[id] * (width + options.columnGap);
			// Preserve all pinned islands; new coordinates start below their lowest edge.
			// This avoids quadratic collision searches in heavily annotated 50k graphs.
			const floor = pinnedFloor.has(node.parentPath)
				? (pinnedFloor.get(node.parentPath) as number) - height - options.rowGap
				: 0;
			const y = floor - row * (height + options.rowGap);
			proposed.set(member, { group, path: node.path, pinned: false, x, y });
			row++;
		}
		rows.set(key, row);
	}
	return graph.nodes.map((_, index) => proposed.get(index) as LayoutProposal);
}
