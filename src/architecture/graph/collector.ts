import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import type {
	BridgeExecutor,
	GraphEdge,
	GraphNode,
	ProjectGraph,
} from "../types.js";
import { graphDiff } from "./diff.js";
import { buildGraphPageScript, type GraphWorkItem } from "./pageScript.js";
import { decodeBridgeResult, graphPageSchema } from "./schema.js";

const optionsSchema = z.object({
	dependencyAnalysis: z.boolean().default(false),
	maxBytes: z.number().int().min(1024).max(134217728).default(134217728),
	maxDurationMs: z.number().int().min(1).max(3600000).default(60000),
	maxNodes: z.number().int().min(1).max(50000).default(10000),
	pageSize: z.number().int().min(1).max(500).default(100),
	rootPath: z
		.string()
		.min(1)
		.max(2048)
		.refine((p) => p.startsWith("/") && !p.includes("\0")),
});
/** Scalar-only progress. Remaining counts discovered work items, not all
 * undiscovered operators; it may grow, and is null after coverage truncation. */
export type GraphScanProgress = Readonly<{
	visited: number;
	remaining: number | null;
	pages: number;
	elapsedMs: number;
}>;
export type CollectGraphOptions = z.input<typeof optionsSchema> & {
	previous?: ProjectGraph;
	signal?: AbortSignal;
	onProgress?: (progress: GraphScanProgress) => void;
};

class GraphDeadlineError extends Error {}
class GraphCancelledError extends Error {}

async function executeWithinBudget(
	executor: BridgeExecutor,
	script: string,
	remainingMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	if (signal?.aborted) throw new GraphCancelledError("Graph scan cancelled");
	const aborted = new Promise<never>((_, reject) => {
		if (signal) {
			onAbort = () => reject(new GraphCancelledError("Graph scan cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		return await Promise.race([
			aborted,
			executor.execute(script),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new GraphDeadlineError("Graph deadline exceeded")),
					Math.max(1, remainingMs),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** Bounded paginated census, yielding between every bridge call. Edges use
 * producer→consumer, containment parent→child. Completeness is scope-specific;
 * dependency closure additionally requires '/' and opt-in source analysis.
 * Without the optional observer, freshness means last successful observation,
 * not an atomic snapshot or guaranteed event coverage.
 * The live queue exists only for this invocation in daemon memory. Awaiting it
 * preserves progress; daemon restart invalidates the job. There is no disk
 * checkpoint/resume guarantee. Progress listeners must be quick synchronous
 * consumers; they receive one frozen scalar payload per accepted page.
 * maxBytes limits summed UTF-8 JSON bytes of retained node/edge records, not
 * physical heap/RSS (which includes map overhead and one bounded bridge page).
 */
export async function collectProjectGraph(
	executor: BridgeExecutor,
	options: CollectGraphOptions,
): Promise<ProjectGraph> {
	const parsed = optionsSchema.parse(options);
	const previous =
		options.previous?.rootPath === parsed.rootPath
			? options.previous
			: undefined;
	const started = Date.now();
	let onProgress = options.onProgress;
	const queue: GraphWorkItem[] = [{ path: parsed.rootPath }];
	const scheduled = new Set([parsed.rootPath]);
	const nodes = new Map<number, GraphNode>();
	const edges = new Map<string, GraphEdge>();
	const warnings = new Set<string>();
	let identity:
		| {
				sessionId: string;
				projectId: string;
				projectPath: string;
				build: string;
		  }
		| undefined;
	let dependencyComplete = parsed.dependencyAnalysis && parsed.rootPath === "/";
	let truncated = false;
	let stale = false;
	let disconnected = false;
	let metadataBytes = 0;
	let metadataLimited = false;
	function retainMetadata(
		record: GraphNode | GraphEdge,
		previousRecord?: GraphNode | GraphEdge,
	): boolean {
		const size = Buffer.byteLength(JSON.stringify(record), "utf8");
		const previousSize = previousRecord
			? Buffer.byteLength(JSON.stringify(previousRecord), "utf8")
			: 0;
		const nextBytes = metadataBytes - previousSize + size;
		if (nextBytes > parsed.maxBytes) {
			metadataLimited = true;
			truncated = true;
			dependencyComplete = false;
			warnings.add(
				"Retained graph metadata byte budget exceeded; census truncated",
			);
			return false;
		}
		metadataBytes = nextBytes;
		return true;
	}
	let startDirty: number | null | undefined;
	let pages = 0;
	if (parsed.rootPath !== "/")
		warnings.add(
			"Dependency closure excludes inbound references outside the selected root",
		);
	if (!parsed.dependencyAnalysis)
		warnings.add("Source dependency analysis was not requested");
	while (queue.length) {
		if (
			options.signal?.aborted ||
			++pages > parsed.maxNodes * 2 + 10 ||
			Date.now() - started >= parsed.maxDurationMs
		) {
			truncated = true;
			stale = true;
			warnings.add("Scan interrupted at its time or cancellation budget");
			break;
		}
		const items = queue.splice(0, parsed.pageSize);
		try {
			const report = graphPageSchema.parse(
				decodeBridgeResult(
					await executeWithinBudget(
						executor,
						buildGraphPageScript({
							dependencyAnalysis: parsed.dependencyAnalysis,
							items,
							pageSize: parsed.pageSize,
							rootPath: parsed.rootPath,
						}),
						parsed.maxDurationMs - (Date.now() - started),
						options.signal,
					),
				),
			);
			if (
				identity &&
				(identity.sessionId !== report.sessionId ||
					identity.projectId !== report.projectId)
			) {
				stale = true;
				warnings.add(
					"Project or bridge session changed during scan; collected pages were not merged",
				);
				break;
			}
			identity ??= {
				build: report.build,
				projectId: report.projectId,
				projectPath: report.projectPath,
				sessionId: report.sessionId,
			};
			if (startDirty === undefined) startDirty = report.dirtyRevision;
			if (
				startDirty !== report.dirtyRevision ||
				(report.endDirtyRevision !== undefined &&
					report.endDirtyRevision !== startDirty)
			)
				stale = true;
			dependencyComplete &&= report.dependencyComplete;
			truncated ||= report.truncated;
			if (report.missing.length) {
				stale = true;
				warnings.add("Operators disappeared during scan");
			}
			for (const warning of report.warnings)
				if (warnings.size < 100) warnings.add(warning);
			for (const node of report.nodes) {
				if (
					node.path !== parsed.rootPath &&
					!node.path.startsWith(
						parsed.rootPath === "/" ? "/" : `${parsed.rootPath}/`,
					)
				)
					throw new Error("Out of scope node");
				if (!nodes.has(node.id) && nodes.size >= parsed.maxNodes) {
					truncated = true;
					continue;
				}
				if (nodes.has(node.id) && nodes.get(node.id)?.path !== node.path) {
					stale = true;
					warnings.add("Operator identity moved during collection");
				}
				if (!retainMetadata(node, nodes.get(node.id))) break;
				nodes.set(node.id, node);
			}
			for (const edge of report.edges) {
				if (metadataLimited) break;
				if (edges.size >= Math.min(500000, parsed.maxNodes * 32)) {
					truncated = true;
					break;
				}
				if (!retainMetadata(edge, edges.get(edge.id))) break;
				edges.set(edge.id, edge);
			}
			for (const pending of report.pending) {
				if (metadataLimited) break;
				if (
					pending.path !== parsed.rootPath &&
					!pending.path.startsWith(
						parsed.rootPath === "/" ? "/" : `${parsed.rootPath}/`,
					)
				)
					throw new Error("Out of scope work item");
				if (queue.length >= parsed.maxNodes + 500) {
					truncated = true;
					break;
				}
				queue.push(pending);
			}
			for (const child of report.discovered) {
				if (metadataLimited) break;
				if (
					child.path !== parsed.rootPath &&
					!child.path.startsWith(
						parsed.rootPath === "/" ? "/" : `${parsed.rootPath}/`,
					)
				)
					throw new Error("Out of scope child");
				if (scheduled.has(child.path)) continue;
				if (scheduled.size >= parsed.maxNodes) {
					truncated = true;
					continue;
				}
				scheduled.add(child.path);
				queue.push(child);
			}
			// Once capacity is reached, child-only continuations cannot add useful nodes.
			if (scheduled.size >= parsed.maxNodes) {
				for (let i = queue.length - 1; i >= 0; i--)
					if (queue[i].expandOnly) {
						queue.splice(i, 1);
						truncated = true;
					}
			}
		} catch (error) {
			if (error instanceof GraphCancelledError) {
				truncated = true;
				stale = true;
				warnings.add(
					"Graph scan cancelled; accepted pages retained as incomplete",
				);
				break;
			}
			if (error instanceof GraphDeadlineError) {
				truncated = true;
				stale = true;
				warnings.add(
					"Scan time budget exhausted; full census remains incomplete",
				);
				break;
			}
			disconnected = true;
			warnings.add("Graph bridge call failed or returned an invalid report");
			break;
		}
		if (onProgress) {
			try {
				onProgress(
					Object.freeze({
						elapsedMs: Math.max(0, Date.now() - started),
						pages,
						remaining: truncated ? null : queue.length,
						visited: nodes.size,
					}),
				);
			} catch {
				onProgress = undefined;
				warnings.add(
					"Progress listener failed and was disabled; graph collection continued",
				);
			}
		}
		if (metadataLimited) break;
		await setImmediate();
	}
	if (!identity && previous) {
		return {
			...previous,
			complete: false,
			coverage: {
				...previous.coverage,
				remaining: null,
				truncated: previous.coverage.truncated || truncated,
			},
			dependencyComplete: false,
			status: disconnected ? "disconnected" : "stale",
			warnings: [...previous.warnings, ...warnings].slice(-100),
		};
	}
	if (startDirty === null)
		warnings.add(
			"Observer unavailable: scan consistency relies on bounded reconciliation, not an atomic snapshot",
		);
	const complete = !truncated && !stale && !disconnected && queue.length === 0;
	const graph: ProjectGraph = {
		schemaVersion: 1,
		...(identity ?? {
			build: "unknown",
			projectId: "unknown",
			projectPath: "",
			sessionId: "unknown",
		}),
		complete,
		coverage: {
			remaining: complete ? 0 : null,
			truncated,
			visited: nodes.size,
		},
		dependencyComplete: complete && dependencyComplete,
		edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
		nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path)),
		observedAt: new Date().toISOString(),
		revision: (previous?.revision ?? 0) + 1,
		rootPath: parsed.rootPath,
		status: disconnected ? "disconnected" : stale ? "stale" : "fresh",
		warnings: [...warnings],
	};
	if (previous) {
		const delta = graphDiff(previous, graph);
		const metadata = (value: ProjectGraph) =>
			JSON.stringify([
				value.build,
				value.projectPath,
				value.status,
				value.complete,
				value.dependencyComplete,
				value.coverage,
			]);
		if (
			!delta.invalidated &&
			!delta.added.length &&
			!delta.removed.length &&
			!delta.changed.length &&
			!delta.edgesAdded.length &&
			!delta.edgesRemoved.length &&
			metadata(previous) === metadata(graph)
		)
			return { ...graph, revision: previous.revision };
	}
	return graph;
}
