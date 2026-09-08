import { createHash } from "node:crypto";
import { z } from "zod";
import type { GraphEdge, ProjectGraph } from "../types.js";
export const refactorInputSchema = z.strictObject({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
	paths: z
		.array(z.string().regex(/^\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/))
		.min(1)
		.max(100),
});
export type RefactorInput = z.infer<typeof refactorInputSchema>;
/** Server-owned verified registry; never accept adapter claims from a tool caller. */
export interface VerifiedToolingAdapter {
	id: string;
	sessionId: string;
	projectId: string;
	nodeFingerprints: Record<string, string>;
}
export interface RefactorPlan {
	trustedAdapters: VerifiedToolingAdapter[];
	id: string;
	input: RefactorInput;
	sessionId: string;
	projectId: string;
	projectPath: string;
	revision: number;
	build: string;
	graphDigest: string;
	parentPath: string;
	containerPath: string;
	blockedReasons: string[];
	affectedPaths: string[];
	readSet: Array<{ id: number; path: string; fingerprint: string }>;
	repairs: Array<{
		owner: string;
		parameter: string;
		targetsBefore: string[];
		targetsAfter: string[];
	}>;
	ports: Array<{
		direction: "in" | "out";
		source: string;
		outputIndex: number;
		edges: GraphEdge[];
		order: number;
	}>;
	wires: GraphEdge[];
	wireCensus: GraphEdge[];
	preview: {
		mechanism: string;
		portOrdering: string;
		checkpointPolicy: string;
	};
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown) =>
	createHash("sha256").update(canonical(value)).digest("hex");
export function graphDigest(g: ProjectGraph) {
	return hash({
		build: g.build,
		complete: g.complete,
		coverage: g.coverage,
		dependencies: g.dependencyComplete,
		edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)),
		nodes: [...g.nodes].sort((a, b) => a.path.localeCompare(b.path)),
		path: g.projectPath,
		project: g.projectId,
		revision: g.revision,
		root: g.rootPath,
		session: g.sessionId,
		status: g.status,
	});
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}
export function planRefactor(
	graph: ProjectGraph,
	input: RefactorInput,
	adapters: VerifiedToolingAdapter[] = [],
): RefactorPlan {
	const parsed = refactorInputSchema.parse(input);
	const paths = [...new Set(parsed.paths)].sort();
	const data = { name: parsed.name, paths };
	const blockedReasons: string[] = [];
	const block = (reason: string) => {
		if (!blockedReasons.includes(reason)) blockedReasons.push(reason);
	};
	if (
		!graph.complete ||
		!graph.dependencyComplete ||
		graph.rootPath !== "/" ||
		graph.status !== "fresh" ||
		graph.coverage.truncated ||
		graph.coverage.remaining !== 0
	)
		block("A fresh whole-project complete dependency census is required");
	if (graph.nodes.length > 5000)
		block("Refactor read set exceeds 5000 operators");
	if (graph.build !== "2025.33230" && graph.build !== "202533230")
		block("Only canary-tested build 2025.33230 is supported");
	if (!graph.projectPath.startsWith("/") || !graph.projectPath.endsWith(".toe"))
		block("Project must have an absolute saved .toe path");
	const nodeByPath = new Map(graph.nodes.map((n) => [n.path, n]));
	const parentPath = nodeByPath.get(paths[0])?.parentPath ?? "";
	if (!parentPath || parentPath === "/")
		block(
			"Select siblings inside a project COMP, not root-level project components",
		);
	for (const p of paths) {
		const n = nodeByPath.get(p);
		if (!n) block(`Missing operator ${p}`);
		else if (n.parentPath !== parentPath)
			block("All selected operators must be siblings");
	}
	const containerPath = `${parentPath}/${parsed.name}`;
	if (nodeByPath.has(containerPath)) block("Container name already exists");
	const moved = (p: string) =>
		paths.some((root) => p === root || p.startsWith(`${root}/`));
	const remap = (p: string) =>
		moved(p) ? `${containerPath}${p.slice(parentPath.length)}` : p;
	const trustedAdapters = adapters
		.filter(
			(a) =>
				a.sessionId === graph.sessionId &&
				a.projectId === graph.projectId &&
				Object.entries(a.nodeFingerprints).every(
					([p, f]) => nodeByPath.get(p)?.fingerprint === f,
				),
		)
		.map((a) => structuredClone(a));
	const exempt = (p: string) =>
		!moved(p) &&
		trustedAdapters.some(
			(a) => a.nodeFingerprints[p] === nodeByPath.get(p)?.fingerprint,
		);
	const affectedPaths = graph.nodes
		.filter((n) => moved(n.path))
		.map((n) => n.path)
		.sort();
	for (const n of graph.nodes) {
		if (!moved(n.path)) continue;
		if (n.ownership.length || Object.keys(n.sourceHashes ?? {}).length)
			block(
				`Unsupported ownership/source/runtime cache at ${n.path}: ${n.ownership.join(",")}`,
			);
		if (
			n.flags.lock ||
			n.flags.isPrivate ||
			/cache|replicator|script|execute/i.test(n.opType)
		)
			block(`Unsupported runtime or protected operator ${n.path}`);
		if (
			n.family.toUpperCase() === "COMP" &&
			!/^(base|baseCOMP)$/i.test(n.opType)
		)
			block(`Object/panel/component semantics require adapter: ${n.path}`);
		if (n.parameterReferences === undefined || n.sourceHashes === undefined)
			block(`Dependency metadata missing: ${n.path}`);
	}
	for (const n of graph.nodes)
		if (
			!exempt(n.path) &&
			(n.parameterReferences === undefined || n.sourceHashes === undefined)
		)
			block(`Whole-project dependency metadata missing: ${n.path}`);
	const repairs: RefactorPlan["repairs"] = [];
	for (const n of graph.nodes) {
		if (
			!exempt(n.path) &&
			(Object.keys(n.sourceHashes ?? {}).length ||
				n.ownership.includes("source-code") ||
				n.ownership.includes("runtime-cache"))
		)
			block(`Global opaque source/runtime dependency ${n.path}`);
		for (const ref of n.parameterReferences ?? []) {
			const affects = moved(n.path) || ref.targetPaths.some(moved);
			if (exempt(n.path) && !affects) continue;
			if (
				ref.evidence === "unresolved" ||
				ref.targetPaths.some((p) => /[*?[\]]/.test(p))
			) {
				block(`Unresolved or wildcard dependency ${n.path}:${ref.name}`);
				continue;
			}
			if (!affects) continue;
			if (
				n.ownership.length ||
				/cache|replicator|script|execute/i.test(n.opType)
			) {
				block(
					`Reference owner has unsupported ownership/runtime semantics ${n.path}`,
				);
				continue;
			}
			if (ref.mode !== "constant" || ref.evidence !== "observed") {
				block(`Unsupported ${ref.mode} reference ${n.path}:${ref.name}`);
				continue;
			}
			if (ref.targetPaths.some((p) => !nodeByPath.has(p))) {
				block(`Reference outside dependency census ${n.path}:${ref.name}`);
				continue;
			}
			repairs.push({
				owner: n.path,
				parameter: ref.name,
				targetsAfter: ref.targetPaths.map(remap),
				targetsBefore: [...ref.targetPaths],
			});
		}
	}
	const wires: GraphEdge[] = [];
	const wireCensus = graph.edges
		.filter((e) => e.kind === "wire" || e.kind === "component-wire")
		.map((e) => structuredClone(e));
	const inputs = new Set<string>();
	for (const e of wireCensus) {
		const key = `${e.kind}:${e.target}:${e.inputIndex}`;
		if (inputs.has(key))
			block(
				"Multiple connections on one input require an explicit ordered adapter",
			);
		inputs.add(key);
	}
	const groups = new Map<string, RefactorPlan["ports"][number]>();
	for (const e of graph.edges) {
		if (!moved(e.source) && !moved(e.target)) continue;
		if (e.kind === "containment") continue;
		if (e.evidence !== "observed" || !["wire", "parameter"].includes(e.kind)) {
			block(`Unsupported ${e.kind} edge ${e.id}`);
			continue;
		}
		if (e.kind !== "wire") continue;
		if (
			!Number.isInteger(e.inputIndex) ||
			!Number.isInteger(e.outputIndex) ||
			!nodeByPath.has(e.source) ||
			!nodeByPath.has(e.target)
		) {
			block(`Incomplete boundary wire ${e.id}`);
			continue;
		}
		wires.push(structuredClone(e));
		if (moved(e.source) === moved(e.target)) continue;
		const direction = moved(e.source) ? "out" : "in";
		const key = `${direction}:${e.source}:${e.outputIndex}`;
		const item = groups.get(key) ?? {
			direction,
			edges: [],
			order: 0,
			outputIndex: Number(e.outputIndex),
			source: e.source,
		};
		item.edges.push(structuredClone(e));
		groups.set(key, item);
	}
	const ports = [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, v], order) => ({
			...v,
			edges: v.edges.sort(
				(a, b) =>
					a.target.localeCompare(b.target) ||
					Number(a.inputIndex) - Number(b.inputIndex),
			),
			order,
		}));
	const digest = graphDigest(graph);
	const core = {
		affectedPaths,
		blockedReasons,
		build: graph.build,
		containerPath,
		graphDigest: digest,
		input: data,
		parentPath,
		ports,
		preview: {
			checkpointPolicy:
				"Preserve original; create sibling checkpoint before mutation; save successful result to a second new sibling; failures keep checkpoint, not ACID rollback",
			mechanism: "native COMP.collapseSelected; preserve original OP IDs",
			portOrdering:
				"Preview is deterministic logical grouping; native generated port indices are observed and boundary order verified after collapse",
		},
		projectId: graph.projectId,
		projectPath: graph.projectPath,
		readSet: graph.nodes.map((n) => ({
			fingerprint: n.fingerprint,
			id: n.id,
			path: n.path,
		})),
		repairs,
		revision: graph.revision,
		sessionId: graph.sessionId,
		trustedAdapters,
		wireCensus,
		wires,
	};
	return freeze({ id: `refactor_${hash(core).slice(0, 32)}`, ...core });
}
