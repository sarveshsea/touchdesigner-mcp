import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getOperatorCatalog } from "../catalog/index.js";
import {
	classifierOptionsSchema,
	classifyNetwork,
} from "../classifier/index.js";
import {
	collectProjectGraph,
	drainGraphDirtyEvents,
	graphDiff,
	markGraphDirty,
} from "../graph/index.js";
import { MemoryStore } from "../memory/index.js";
import {
	planRefactor,
	type RefactorPlan,
	RefactorStager,
	refactorInputSchema,
} from "../refactor/index.js";
import type { BridgeExecutor, ProjectGraph } from "../types.js";

const rootSchema = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/)
	.default("/project1");
const responseFields = {
	limit: z.number().int().min(1).max(500).default(200),
	offset: z.number().int().min(0).max(50000).default(0),
	summaryOnly: z.boolean().default(false),
};
const mapSchema = z.strictObject({
	...responseFields,
	action: z
		.enum(["refresh", "watch", "stop", "status", "diff"])
		.default("refresh"),
	dependencyAnalysis: z.boolean().default(false),
	intervalMs: z.number().int().min(1000).max(60000).default(2000),
	maxDurationMs: z.number().int().min(1).max(3600000).default(60000),
	maxNodes: z.number().int().min(1).max(50000).default(10000),
	pageSize: z.number().int().min(1).max(500).default(100),
	rootPath: rootSchema,
	wait: z.boolean().default(true),
});
const stageSchema = z.discriminatedUnion("action", [
	z.strictObject({
		action: z.literal("apply"),
		planId: z.string().regex(/^refactor_[a-f0-9]{32}$/),
	}),
	z.strictObject({
		action: z.literal("status"),
		transactionId: z.string().regex(/^refactor_[a-f0-9]{32}$/),
	}),
]);
type ScanOptions = z.infer<typeof mapSchema>;
function graphPage(
	graph: ProjectGraph,
	options: { summaryOnly: boolean; offset: number; limit: number },
) {
	const nodes = options.summaryOnly
		? []
		: graph.nodes.slice(options.offset, options.offset + options.limit);
	const paths = new Set(nodes.map((node) => node.path));
	const relevant = options.summaryOnly
		? []
		: graph.edges.filter(
				(edge) => paths.has(edge.source) || paths.has(edge.target),
			);
	return {
		...graph,
		edges: relevant.slice(0, 4000),
		edgesTruncated: relevant.length > 4000,
		limit: options.limit,
		nextOffset:
			options.offset + nodes.length < graph.nodes.length && !options.summaryOnly
				? options.offset + nodes.length
				: null,
		nodes,
		offset: options.offset,
		totalEdges: graph.edges.length,
		totalNodes: graph.nodes.length,
	};
}
/** One process owns graphs and transactions. Network reads yield in the collector;
 * persistence and classification never run in TD's frame callbacks. */
export class ArchitectureRuntime {
	private jobs = new Map<
		string,
		{
			jobId: string;
			rootPath: string;
			status: "scanning" | "complete" | "failed";
			visited: number;
			remaining: number | null;
			pages: number;
			elapsedMs: number;
		}
	>();
	private controllers = new Map<string, AbortController>();
	private graphs = new Map<string, ProjectGraph>();
	private previous = new Map<string, ProjectGraph>();
	private scans = new Map<string, Promise<ProjectGraph>>();
	private plans = new Map<string, RefactorPlan>();
	private watchOptions: ScanOptions | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastReconcile = 0;
	private backoff = 2000;
	private closed = false;
	private watchGeneration = 0;
	private retainedGraph: ProjectGraph | null = null;
	private writingMemory = false;
	private persistence: Promise<unknown> = Promise.resolve();
	private latestRoot = "/project1";
	private classifiedRoot: string | null = null;
	private classifications: Awaited<ReturnType<typeof classifyNetwork>> | null =
		null;
	private transaction: unknown = null;

	private warnings: string[] = [];
	private memory: MemoryStore;
	private stager: RefactorStager;
	constructor(
		private executor: BridgeExecutor,
		stateRoot: string,
		private dependencies: { collect?: typeof collectProjectGraph } = {},
	) {
		this.memory = new MemoryStore(stateRoot);
		this.stager = new RefactorStager(executor, stateRoot);
	}
	async close() {
		this.closed = true;
		this.watchGeneration++;
		this.watchOptions = null;
		if (this.timer) clearTimeout(this.timer);
		for (const controller of this.controllers.values()) controller.abort();
		await Promise.allSettled([...this.scans.values()]);
		await this.persistence;
	}
	private async refresh(options: ScanOptions): Promise<ProjectGraph> {
		if (this.closed) throw new Error("Architecture service is closed");
		const pending = this.scans.get(options.rootPath);
		if (pending) {
			const result = await pending;
			if (this.closed) throw new Error("Architecture service is closed");
			if (!options.dependencyAnalysis || result.dependencyComplete)
				return result;
			return this.refresh(options);
		}
		if (this.scans.size >= 2)
			throw new Error(
				"Two architecture scans are already active; inspect status",
			);
		const controller = new AbortController();
		this.controllers.set(options.rootPath, controller);
		const task = (async () => {
			const prior = this.graphs.get(options.rootPath);
			const graph = await (this.dependencies.collect ?? collectProjectGraph)(
				this.executor,
				{
					...options,
					onProgress: (progress) => {
						const job = this.jobs.get(options.rootPath);
						if (job) this.jobs.set(options.rootPath, { ...job, ...progress });
					},
					previous: prior,
					signal: controller.signal,
				},
			);
			if (
				prior &&
				(prior.projectId !== graph.projectId ||
					prior.sessionId !== graph.sessionId)
			) {
				this.plans.clear();
				this.previous.clear();
				this.classifications = null;
			}
			if (prior) this.previous.set(options.rootPath, prior);
			this.graphs.set(options.rootPath, graph);
			if (this.graphs.size > 8) {
				const oldest = this.graphs.keys().next().value;
				if (oldest && oldest !== options.rootPath) {
					this.graphs.delete(oldest);
					this.previous.delete(oldest);
				}
			}
			if (graph.status === "fresh" && graph.projectId !== "unknown")
				this.retain(graph);
			if (this.watchOptions?.rootPath === options.rootPath) {
				const paths = graph.nodes.slice(0, 5000).map((node) => node.path);
				await this.executor.execute(`import sys,json
m=sys.modules.get('_td_mcp_architecture')
if m is not None and getattr(m,'active',False) and getattr(m,'root_path','')==${JSON.stringify(options.rootPath)}:
    m.watch(${JSON.stringify(paths)})
result=json.dumps({'ok':True})`);
				if (graph.nodes.length > 5000)
					this.warnings = [
						"Event coverage limited to5000 operators; remaining nodes use30-second reconciliation",
					];
			}
			this.lastReconcile = Date.now();
			return graph;
		})();
		this.scans.set(options.rootPath, task);
		try {
			return await task;
		} finally {
			this.scans.delete(options.rootPath);
			this.controllers.delete(options.rootPath);
		}
	}
	private background(options: ScanOptions) {
		const existing = this.jobs.get(options.rootPath);
		if (existing?.status === "scanning") {
			const generation = this.watchGeneration;
			if (this.watchOptions?.rootPath === options.rootPath)
				void this.scans
					.get(options.rootPath)
					?.finally(() => {
						if (generation === this.watchGeneration) this.schedule(generation);
					})
					.catch(() => undefined);
			return { accepted: true, job: existing };
		}
		if (this.scans.size >= 2)
			throw new Error(
				"Two architecture scans are already active; inspect status",
			);
		const job = {
			elapsedMs: 0,
			jobId: randomUUID(),
			pages: 0,
			remaining: null,
			rootPath: options.rootPath,
			status: "scanning" as const,
			visited: 0,
		};
		this.latestRoot = options.rootPath;
		this.jobs.set(options.rootPath, job);
		if (this.jobs.size > 8) {
			const terminal = [...this.jobs.entries()].find(
				([, entry]) => entry.status !== "scanning",
			);
			if (terminal) this.jobs.delete(terminal[0]);
		}
		const generation = this.watchGeneration;
		void this.refresh(options)
			.then((graph) => {
				const current = this.jobs.get(options.rootPath);
				if (current?.jobId === job.jobId)
					this.jobs.set(options.rootPath, {
						...current,
						remaining: graph.coverage.remaining,
						status: graph.complete ? "complete" : "failed",
						visited: graph.nodes.length,
					});
			})
			.catch(() => {
				const current = this.jobs.get(options.rootPath);
				if (current?.jobId === job.jobId)
					this.jobs.set(options.rootPath, { ...current, status: "failed" });
			})
			.finally(() => {
				if (
					this.watchOptions?.rootPath === options.rootPath &&
					generation === this.watchGeneration
				)
					this.schedule(generation);
			});
		return { accepted: true, job };
	}

	private retain(graph: ProjectGraph) {
		this.retainedGraph = graph;
		if (this.writingMemory) return;
		this.writingMemory = true;
		this.persistence = (async () => {
			while (this.retainedGraph) {
				const next = this.retainedGraph;
				this.retainedGraph = null;
				try {
					await this.memory.observeGraph(next);
				} catch {
					this.warnings = [
						"Project memory persistence failed; live graph remains available",
					];
				}
			}
		})().finally(() => {
			this.writingMemory = false;
		});
	}

	private async observer(action: "start" | "stop", rootPath: string) {
		const raw = await this.executor.execute(
			`import sys,json\nm=sys.modules.get('_td_mcp_architecture')\nif m is None or not callable(getattr(m,'${action}',None)):\n    result=json.dumps({'available':False})\nelse:\n    m.${action}(${action === "start" ? JSON.stringify(rootPath) : ""})\n    result=json.dumps({'available':True})`,
		);
		const value = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!value || !(value as { available?: boolean }).available)
			throw new Error(
				"Updated inspector/observer bundle is required for live watch",
			);
	}
	private schedule(generation = this.watchGeneration) {
		if (
			this.closed ||
			!this.watchOptions ||
			generation !== this.watchGeneration
		)
			return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.tick(generation);
		}, this.backoff);
		this.timer.unref();
	}
	private async tick(generation = this.watchGeneration) {
		const options = this.watchOptions;
		if (!options || this.closed || generation !== this.watchGeneration) return;
		try {
			const batch = await drainGraphDirtyEvents(this.executor);
			if (generation !== this.watchGeneration) return;
			const prior = this.graphs.get(options.rootPath);
			if (prior)
				this.graphs.set(options.rootPath, markGraphDirty(prior, batch));
			if (batch.active === false) throw new Error("Observer unavailable");
			if (
				batch.events.length ||
				batch.remaining ||
				batch.dropped ||
				(prior && prior.sessionId !== batch.session_id) ||
				Date.now() - this.lastReconcile >= 30000
			) {
				const started = Date.now();
				const graph = await this.refresh(options);
				if (generation !== this.watchGeneration) return;
				if (graph.status === "disconnected")
					throw new Error("Bridge disconnected");
				this.backoff = Math.max(
					options.intervalMs,
					Math.min(30000, (Date.now() - started) * 4),
				);
			} else this.backoff = options.intervalMs;
		} catch {
			if (generation !== this.watchGeneration) return;
			const prior = this.graphs.get(options.rootPath);
			if (prior)
				this.graphs.set(options.rootPath, {
					...prior,
					dependencyComplete: false,
					status: "disconnected",
				});
			this.backoff = Math.min(30000, this.backoff * 2);
		}
		this.schedule(generation);
	}
	private async map(params: Record<string, unknown>) {
		const options = mapSchema.parse(params);
		if (["refresh", "watch", "diff"].includes(options.action))
			this.latestRoot = options.rootPath;
		if (options.action === "status")
			return {
				graph: this.graphs.has(options.rootPath)
					? graphPage(
							this.graphs.get(options.rootPath) as ProjectGraph,
							options,
						)
					: null,
				intervalMs: this.backoff,
				job: this.jobs.get(options.rootPath) ?? null,
				pendingScans: this.scans.size,
				warnings: this.warnings,
				watching: this.watchOptions?.rootPath === options.rootPath,
			};
		if (options.action === "stop") {
			this.watchGeneration++;
			if (this.timer) clearTimeout(this.timer);
			this.watchOptions = null;
			await this.observer("stop", options.rootPath);
			return { watching: false };
		}
		if (options.action === "watch") {
			this.watchGeneration++;
			await this.observer("start", options.rootPath);
			if (this.timer) clearTimeout(this.timer);
			this.watchOptions = options;
			this.backoff = options.intervalMs;
			if (!options.wait) return { ...this.background(options), watching: true };
			const graph = await this.refresh(options);
			this.schedule();
			return { graph: graphPage(graph, options), watching: true };
		}
		if (!options.wait) return this.background(options);
		const graph = await this.refresh(options);
		if (options.action === "diff") {
			const before = this.previous.get(options.rootPath);
			const diff = before ? graphDiff(before, graph) : null;
			const fields = [
				"added",
				"removed",
				"changed",
				"edgesAdded",
				"edgesRemoved",
			] as const;
			const totals = diff
				? Object.fromEntries(fields.map((key) => [key, diff[key].length]))
				: null;
			const bounded = diff
				? {
						...diff,
						...Object.fromEntries(
							fields.map((key) => [
								key,
								options.summaryOnly
									? []
									: diff[key].slice(
											options.offset,
											options.offset + options.limit,
										),
							]),
						),
						limit: options.limit,
						offset: options.offset,
						totals,
					}
				: null;
			return { diff: bounded, graph: graphPage(graph, options) };
		}
		return graphPage(graph, options);
	}
	async dispatch(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		if (this.closed) throw new Error("Architecture service is closed");
		switch (method) {
			case "get_td_operator_catalog": {
				const options = z
					.strictObject({
						family: z.string().max(80).optional(),
						limit: z.number().int().min(1).max(200).optional(),
						offset: z.number().int().min(0).max(8192).optional(),
						query: z.string().max(160).optional(),
					})
					.parse(params);
				return getOperatorCatalog(this.executor, {
					...options,
					...(process.env.TD_ARCHITECTURE_DOC_ROOT
						? { docRoot: process.env.TD_ARCHITECTURE_DOC_ROOT }
						: {}),
				});
			}
			case "map_td_project":
				return this.map(params);
			case "classify_td_network": {
				const options = z
					.strictObject({
						...responseFields,
						classifierOptions: classifierOptionsSchema.optional(),
						rootPath: rootSchema,
					})
					.parse(params);
				const graph = await this.refresh(
					mapSchema.parse({ rootPath: options.rootPath }),
				);
				this.latestRoot = options.rootPath;
				this.classifiedRoot = options.rootPath;
				this.classifications = await classifyNetwork(
					graph,
					options.classifierOptions,
				);
				return {
					...this.classifications,
					classifications: options.summaryOnly
						? []
						: this.classifications.classifications.slice(
								options.offset,
								options.offset + options.limit,
							),
					layout: options.summaryOnly
						? []
						: this.classifications.layout.slice(
								options.offset,
								options.offset + options.limit,
							),
					limit: options.limit,
					nextOffset:
						!options.summaryOnly &&
						options.offset + options.limit <
							this.classifications.classifications.length
							? options.offset + options.limit
							: null,
					offset: options.offset,
					revision: graph.revision,
					totalClassifications: this.classifications.classifications.length,
				};
			}
			case "plan_td_refactor": {
				const input = refactorInputSchema.parse(params);
				this.latestRoot = "/";
				const graph = await this.refresh(
					mapSchema.parse({ dependencyAnalysis: true, rootPath: "/" }),
				);
				const plan = planRefactor(graph, input);
				this.plans.set(plan.id, plan);
				if (this.plans.size > 64) {
					const oldest = this.plans.keys().next().value;
					if (oldest) this.plans.delete(oldest);
				}
				return plan;
			}
			case "stage_td_refactor": {
				const input = stageSchema.parse(params);
				if (input.action === "status")
					return this.stager.status(input.transactionId);
				const plan = this.plans.get(input.planId);
				if (!plan)
					throw new Error("Unknown or expired plan: generate a new preview");
				const graph = await this.refresh(
					mapSchema.parse({ dependencyAnalysis: true, rootPath: "/" }),
				);
				this.transaction = await this.stager.stage(plan, graph);
				return this.transaction;
			}
			case "get_td_memory":
				return this.memory.query(params);
			case "record_td_memory": {
				const input = z.strictObject({ record: z.unknown() }).parse(params);
				return this.memory.record(input.record);
			}
			case "inspector_state": {
				const input = z
					.strictObject({
						limit: z.number().int().min(1).max(500).default(18),
						offset: z.number().int().min(0).max(50000).default(0),
						role: z.string().max(40).default("all"),
						rootPath: z
							.string()
							.max(2048)
							.regex(/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/)
							.optional(),
						search: z.string().max(160).default(""),
					})
					.parse(params);
				const graph = this.graphs.get(input.rootPath ?? this.latestRoot);
				const currentClassification =
					this.classifiedRoot === graph?.rootPath ? this.classifications : null;
				const roles = new Map(
					currentClassification?.classifications.map((item) => [
						item.path,
						item.role,
					]) ?? [],
				);
				const matches =
					graph?.nodes.filter(
						(node) =>
							(!input.search ||
								node.path.toLowerCase().includes(input.search.toLowerCase())) &&
							(input.role === "all" ||
								(roles.get(node.path) ?? "unknown") === input.role),
					) ?? [];
				const nodes = matches.slice(input.offset, input.offset + input.limit);
				const paths = new Set(nodes.map((node) => node.path));
				return {
					classification: currentClassification
						? {
								...currentClassification,
								classifications: currentClassification.classifications.filter(
									(item) => paths.has(item.path),
								),
								layout: currentClassification.layout.filter((item) =>
									paths.has(item.path),
								),
							}
						: null,
					graph: graph
						? {
								...graph,
								edges: graph.edges
									.filter(
										(edge) => paths.has(edge.source) || paths.has(edge.target),
									)
									.slice(0, 200),
								limit: input.limit,
								nodes,
								offset: input.offset,
								totalNodes: matches.length,
							}
						: null,
					job: this.jobs.get(input.rootPath ?? this.latestRoot) ?? null,
					memory:
						graph && graph.projectId !== "unknown"
							? await this.memory.query({
									limit: 50,
									projectId: graph.projectId,
								})
							: { records: [] },
					transaction: this.transaction,
					warnings: this.warnings,
				};
			}
			default:
				throw new Error("Unknown architecture method");
		}
	}
}
