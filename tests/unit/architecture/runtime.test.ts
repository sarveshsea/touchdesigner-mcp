import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectGraphOptions } from "../../../src/architecture/graph/collector.js";
import { ArchitectureRuntime } from "../../../src/architecture/service/runtime.js";
import type {
	BridgeExecutor,
	Classification,
	LayoutProposal,
	ProjectGraph,
} from "../../../src/architecture/types.js";

interface RuntimeSnapshot {
	graph: ProjectGraph & { totalNodes: number; offset: number };
	classification: {
		classifications: Classification[];
		layout: LayoutProposal[];
	};
	warnings: string[];
	intervalMs: number;
	diff: unknown;
}

const graph: ProjectGraph = {
	build: "202533230",
	complete: true,
	coverage: { remaining: 0, truncated: false, visited: 0 },
	dependencyComplete: false,
	edges: [],
	nodes: [],
	observedAt: new Date().toISOString(),
	projectId: "a".repeat(64),
	projectPath: "/tmp/test.toe",
	revision: 1,
	rootPath: "/project1",
	schemaVersion: 1,
	sessionId: "session",
	status: "fresh",
	warnings: [],
};
const dirs: string[] = [];
const runtimes: ArchitectureRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	vi.useRealTimers();
	await Promise.all(
		dirs.splice(0).map((p) => rm(p, { force: true, recursive: true })),
	);
});
async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "td-runtime-"));
	dirs.push(dir);
	const collect = vi.fn(
		async (_executor: BridgeExecutor, _options: CollectGraphOptions) =>
			structuredClone(graph),
	);
	const executor = {
		execute: vi.fn(async (): Promise<unknown> => ({ active: false })),
	};
	const runtime = new ArchitectureRuntime(executor, dir, { collect });
	runtimes.push(runtime);
	return { collect, executor, runtime };
}
describe("shared architecture runtime", () => {
	it("coalesces concurrent scans and returns bounded inspector state", async () => {
		const { runtime, collect } = await setup();
		await Promise.all([
			runtime.dispatch("map_td_project", { action: "refresh" }),
			runtime.dispatch("map_td_project", { action: "refresh" }),
		]);
		expect(collect).toHaveBeenCalledTimes(1);
		const state = (await runtime.dispatch(
			"inspector_state",
			{},
		)) as RuntimeSnapshot;
		expect(state.graph.projectId).toBe(graph.projectId);
		await runtime.close();
	});
	it("rejects unknown methods and no-observer watches", async () => {
		const { runtime } = await setup();
		await expect(runtime.dispatch("exec", {})).rejects.toThrow();
		await expect(
			runtime.dispatch("map_td_project", { action: "watch" }),
		).rejects.toThrow(/bundle|observer/i);
		await runtime.close();
	});
	it("does not apply caller supplied plans or unknown transaction inputs", async () => {
		const { runtime } = await setup();
		await expect(
			runtime.dispatch("stage_td_refactor", {
				action: "apply",
				planId: "forged",
			}),
		).rejects.toThrow();
		await expect(
			runtime.dispatch("map_td_project", {
				action: "refresh",
				maxNodes: 50001,
			}),
		).rejects.toThrow();
		await runtime.close();
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const dirtyBatch = (session = "session") => ({
	active: true,
	dirty_revision: 0,
	dropped: 0,
	events: [],
	project_identity: "project",
	remaining: 0,
	session_id: session,
});

describe("runtime lifecycle and paging regressions", () => {
	it("validates request boundaries without invoking the bridge", async () => {
		const { runtime, executor, collect } = await setup();
		for (const [method, params] of [
			["map_td_project", { rootPath: "/project1/../private" }],
			["get_td_operator_catalog", { limit: 201 }],
			["classify_td_network", { classifierOptions: { pins: "all" } }],
			["record_td_memory", { extra: true, record: {} }],
			["inspector_state", { offset: 50001 }],
		] as const)
			await expect(runtime.dispatch(method, params)).rejects.toThrow();
		expect(executor.execute).not.toHaveBeenCalled();
		expect(collect).not.toHaveBeenCalled();
		await runtime.close();
		await expect(runtime.dispatch("inspector_state", {})).rejects.toThrow(
			/closed/,
		);
	});

	it("keeps errors recoverable and reports the latest graph diff", async () => {
		const { runtime, collect } = await setup();
		collect.mockRejectedValueOnce(new Error("offline"));
		await expect(runtime.dispatch("map_td_project", {})).rejects.toThrow(
			"offline",
		);
		await runtime.dispatch("map_td_project", {});
		collect.mockResolvedValueOnce({ ...graph, revision: 2 });
		const result = (await runtime.dispatch("map_td_project", {
			action: "diff",
		})) as RuntimeSnapshot;
		expect(result.graph.revision).toBe(2);
		expect(result.diff).not.toBeNull();
		await runtime.dispatch("inspector_state", {});
		await runtime.close();
	});

	it("bounds cached roots to eight and retains the newest selection", async () => {
		const { runtime, collect } = await setup();
		for (let i = 0; i < 10; i++) {
			collect.mockResolvedValueOnce({ ...graph, rootPath: `/project${i}` });
			await runtime.dispatch("map_td_project", { rootPath: `/project${i}` });
		}
		const old = (await runtime.dispatch("map_td_project", {
			action: "status",
			rootPath: "/project0",
		})) as RuntimeSnapshot;
		expect(old.graph).toBeNull();
		const state = (await runtime.dispatch(
			"inspector_state",
			{},
		)) as RuntimeSnapshot;
		expect(state.graph.rootPath).toBe("/project9");
		await runtime.close();
	});

	it("paginates graph nodes with explicit total and offset", async () => {
		const { runtime, collect } = await setup();
		const nodes = Array.from({ length: 600 }, (_, id) => ({
			family: "TOP",
			fingerprint: "a".repeat(64),
			flags: {},
			id,
			name: `n${id}`,
			nodeX: 0,
			nodeY: 0,
			opType: "nullTOP",
			ownership: [],
			parentPath: "/project1",
			path: `/project1/n${id}`,
			tags: [],
		}));
		collect.mockResolvedValueOnce({ ...graph, nodes });
		await runtime.dispatch("map_td_project", {});
		const state = (await runtime.dispatch("inspector_state", {
			limit: 30,
			offset: 500,
		})) as RuntimeSnapshot;
		expect(state.graph.nodes).toHaveLength(30);
		expect(state.graph.nodes[0].id).toBe(500);
		expect(state.graph.totalNodes).toBe(600);
		expect(state.graph.offset).toBe(500);
		await runtime.close();
	});

	it("does not show classifications from a different graph root", async () => {
		const { runtime, collect } = await setup();
		await runtime.dispatch("classify_td_network", { rootPath: "/project1" });
		collect.mockResolvedValueOnce({ ...graph, rootPath: "/project2" });
		await runtime.dispatch("map_td_project", { rootPath: "/project2" });
		const state = (await runtime.dispatch("inspector_state", {
			rootPath: "/project2",
		})) as RuntimeSnapshot;
		expect(state.classification).toBeNull();
		await runtime.close();
	});

	it("immediately reconciles an empty dirty ledger from a replacement session", async () => {
		vi.useFakeTimers();
		const { runtime, collect, executor } = await setup();
		try {
			executor.execute.mockResolvedValueOnce({ available: true });
			await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 1000,
			});
			executor.execute.mockResolvedValueOnce(dirtyBatch("replacement"));
			collect.mockResolvedValueOnce({ ...graph, sessionId: "replacement" });
			await vi.advanceTimersByTimeAsync(1000);
			expect(collect).toHaveBeenCalledTimes(2);
		} finally {
			await runtime.close();
			vi.useRealTimers();
		}
	});

	it("stopping while a drain is pending leaves no scheduled polling", async () => {
		vi.useFakeTimers();
		const { runtime, executor } = await setup();
		try {
			executor.execute.mockResolvedValueOnce({ available: true });
			await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 1000,
			});
			const pending = deferred<unknown>();
			executor.execute.mockImplementationOnce(() => pending.promise);
			await vi.advanceTimersByTimeAsync(1000);
			executor.execute.mockResolvedValueOnce({ available: true });
			await runtime.dispatch("map_td_project", { action: "stop" });
			pending.resolve(dirtyBatch());
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await runtime.close();
			vi.useRealTimers();
		}
	});

	it("does not let an older watch drain install a second timer after switching roots", async () => {
		vi.useFakeTimers();
		const { runtime, executor, collect } = await setup();
		try {
			executor.execute.mockResolvedValueOnce({ available: true });
			await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 1000,
			});
			const pending = deferred<unknown>();
			executor.execute.mockImplementationOnce(() => pending.promise);
			await vi.advanceTimersByTimeAsync(1000);
			executor.execute.mockResolvedValueOnce({ available: true });
			collect.mockResolvedValueOnce({ ...graph, rootPath: "/project2" });
			await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 2000,
				rootPath: "/project2",
			});
			pending.resolve(dirtyBatch());
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			await runtime.close();
			vi.useRealTimers();
		}
	});

	it("marks bridge loss disconnected and retries with bounded backoff", async () => {
		vi.useFakeTimers();
		const { runtime, executor } = await setup();
		try {
			executor.execute.mockResolvedValueOnce({ available: true });
			await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 1000,
			});
			executor.execute.mockRejectedValueOnce(new Error("offline"));
			await vi.advanceTimersByTimeAsync(1000);
			const status = (await runtime.dispatch("map_td_project", {
				action: "status",
			})) as RuntimeSnapshot;
			expect(status.graph.status).toBe("disconnected");
			expect(status.graph.dependencyComplete).toBe(false);
			expect(status.intervalMs).toBe(2000);
		} finally {
			await runtime.close();
			vi.useRealTimers();
		}
	});
});

import { MemoryStore } from "../../../src/architecture/memory/index.js";
import { RefactorStager } from "../../../src/architecture/refactor/index.js";

const simpleNode = (id: number) => ({
	family: "TOP",
	fingerprint: "a".repeat(64),
	flags: {},
	id,
	name: `n${id}`,
	nodeX: 0,
	nodeY: 0,
	opType: "nullTOP",
	ownership: [],
	parameterReferences: [],
	parentPath: "/project1",
	path: `/project1/n${id}`,
	sourceHashes: {},
	tags: ["role:post"],
});
describe("runtime operation coordination", () => {
	it("paginates classification and layout alongside server-filtered nodes", async () => {
		const { runtime, collect } = await setup();
		collect.mockResolvedValue({
			...graph,
			nodes: Array.from({ length: 600 }, (_, id) => simpleNode(id)),
		});
		await runtime.dispatch("classify_td_network", {});
		const state = (await runtime.dispatch("inspector_state", {
			limit: 20,
			offset: 500,
		})) as RuntimeSnapshot;
		expect(state.classification.classifications).toHaveLength(20);
		expect(state.classification.layout).toHaveLength(20);
		expect(
			state.classification.classifications.map((n: { path: string }) => n.path),
		).toEqual(state.graph.nodes.map((n: { path: string }) => n.path));
		const filtered = (await runtime.dispatch("inspector_state", {
			role: "post",
			search: "n599",
		})) as RuntimeSnapshot;
		expect(filtered.graph.nodes).toHaveLength(1);
		expect(filtered.graph.totalNodes).toBe(1);
		expect(filtered.graph.nodes[0].id).toBe(599);
	});
	it("requests a dependency census after a concurrent shallow scan completes", async () => {
		const { runtime, collect } = await setup();
		const pending = deferred<ProjectGraph>();
		collect.mockImplementationOnce(() => pending.promise);
		const shallow = runtime.dispatch("map_td_project", { rootPath: "/" });
		const plan = runtime.dispatch("plan_td_refactor", {
			name: "wrapped",
			paths: ["/project1/n0"],
		});
		collect.mockResolvedValueOnce({
			...graph,
			dependencyComplete: true,
			nodes: [simpleNode(0)],
			rootPath: "/",
		});
		pending.resolve({ ...graph, rootPath: "/" });
		await shallow;
		await plan;
		expect(collect).toHaveBeenCalledTimes(2);
		expect(collect.mock.calls[1][1]).toMatchObject({
			dependencyAnalysis: true,
			rootPath: "/",
		});
	});
	it("stages only a server-owned plan after a fresh census and exposes status", async () => {
		const { runtime, collect, executor } = await setup();
		collect.mockResolvedValue({
			...graph,
			dependencyComplete: true,
			nodes: [simpleNode(0)],
			rootPath: "/",
		});
		const stage = vi
			.spyOn(RefactorStager.prototype, "stage")
			.mockResolvedValue({ state: "complete" } as never);
		const status = vi
			.spyOn(RefactorStager.prototype, "status")
			.mockResolvedValue({ state: "uncertain" } as never);
		try {
			const plan = (await runtime.dispatch("plan_td_refactor", {
				name: "wrapped",
				paths: ["/project1/n0"],
			})) as { id: string };
			expect(
				await runtime.dispatch("stage_td_refactor", {
					action: "apply",
					planId: plan.id,
				}),
			).toEqual({ state: "complete" });
			expect(collect).toHaveBeenCalledTimes(2);
			expect(stage).toHaveBeenCalledTimes(1);
			expect(
				await runtime.dispatch("stage_td_refactor", {
					action: "status",
					transactionId: plan.id,
				}),
			).toEqual({ state: "uncertain" });
			expect(status).toHaveBeenCalledWith(plan.id);
			expect(executor.execute).not.toHaveBeenCalled();
		} finally {
			stage.mockRestore();
			status.mockRestore();
		}
	});
	it("expires previous-session plans before accepting another apply", async () => {
		const { runtime, collect } = await setup();
		collect.mockResolvedValue({
			...graph,
			dependencyComplete: true,
			nodes: [simpleNode(0)],
			rootPath: "/",
		});
		const plan = (await runtime.dispatch("plan_td_refactor", {
			name: "wrapped",
			paths: ["/project1/n0"],
		})) as { id: string };
		collect.mockResolvedValueOnce({
			...graph,
			rootPath: "/",
			sessionId: "replacement",
		});
		await runtime.dispatch("map_td_project", { rootPath: "/" });
		await expect(
			runtime.dispatch("stage_td_refactor", {
				action: "apply",
				planId: plan.id,
			}),
		).rejects.toThrow(/expired/);
	});
	it("records and queries project memory through validated envelopes", async () => {
		const { runtime } = await setup();
		await runtime.dispatch("record_td_memory", {
			record: {
				action: "record",
				kind: "decision",
				projectId: graph.projectId,
				text: "Keep feedback islands together.",
				title: "Layout decision",
			},
		});
		const result = (await runtime.dispatch("get_td_memory", {
			projectId: graph.projectId,
		})) as { records: Array<{ title: string }> };
		expect(result.records[0].title).toBe("Layout decision");
	});
	it("retains the latest pending snapshot instead of growing a persistence queue", async () => {
		const { runtime, collect } = await setup();
		const pending =
			deferred<Awaited<ReturnType<MemoryStore["observeGraph"]>>>();
		const retained = vi
			.spyOn(MemoryStore.prototype, "observeGraph")
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue({} as never);
		try {
			for (let revision = 1; revision <= 6; revision++) {
				collect.mockResolvedValueOnce({ ...graph, revision });
				await runtime.dispatch("map_td_project", {});
			}
			expect(retained).toHaveBeenCalledTimes(1);
			pending.resolve({} as never);
			await runtime.close();
			expect(retained).toHaveBeenCalledTimes(2);
			expect(retained.mock.calls[1][0].revision).toBe(6);
		} finally {
			pending.resolve({} as never);
			await runtime.close();
			retained.mockRestore();
		}
	});
	it("reports persistence failures without losing the live graph", async () => {
		const { runtime } = await setup();
		const retained = vi
			.spyOn(MemoryStore.prototype, "observeGraph")
			.mockRejectedValue(new Error("disk unavailable"));
		try {
			await runtime.dispatch("map_td_project", {});
			const result = (await runtime.dispatch("map_td_project", {
				action: "status",
			})) as RuntimeSnapshot;
			expect(result.graph.status).toBe("fresh");
			expect(result.warnings.join()).toMatch(/persistence failed/);
		} finally {
			await runtime.close();
			retained.mockRestore();
		}
	});
});

interface ScanJob {
	jobId: string;
	rootPath: string;
	status: "scanning" | "complete" | "failed";
	visited: number;
	remaining: number | null;
	pages: number;
	elapsedMs: number;
}
interface JobState {
	job: ScanJob | null;
	graph: ProjectGraph | null;
	pendingScans: number;
}
const jobState = async (runtime: ArchitectureRuntime, rootPath = "/project1") =>
	(await runtime.dispatch("map_td_project", {
		action: "status",
		rootPath,
	})) as JobState;

describe("background scan jobs", () => {
	it("acknowledges without waiting, publishes scalar progress, and exposes completion", async () => {
		const { runtime, collect } = await setup();
		const pending = deferred<ProjectGraph>();
		let options: CollectGraphOptions | undefined;
		collect.mockImplementationOnce(async (_, value) => {
			options = value;
			return pending.promise;
		});
		try {
			const ack = (await runtime.dispatch("map_td_project", {
				maxDurationMs: 3600000,
				wait: false,
			})) as { accepted: boolean; job: ScanJob };
			expect(ack.accepted).toBe(true);
			expect(ack.job).toMatchObject({
				pages: 0,
				remaining: null,
				rootPath: "/project1",
				status: "scanning",
				visited: 0,
			});
			expect(ack.job).not.toHaveProperty("nodes");
			expect(options?.maxDurationMs).toBe(3600000);
			options?.onProgress?.({
				elapsedMs: 500,
				pages: 3,
				remaining: 40,
				visited: 17,
			});
			expect((await jobState(runtime)).job).toMatchObject({
				elapsedMs: 500,
				jobId: ack.job.jobId,
				pages: 3,
				remaining: 40,
				visited: 17,
			});
			const inspector = (await runtime.dispatch(
				"inspector_state",
				{},
			)) as JobState;
			expect(inspector.graph).toBeNull();
			expect(inspector.job?.jobId).toBe(ack.job.jobId);
			pending.resolve({ ...graph, nodes: [simpleNode(0)] });
			await vi.waitFor(async () =>
				expect((await jobState(runtime)).job?.status).toBe("complete"),
			);
			expect((await jobState(runtime)).job?.visited).toBe(1);
		} finally {
			pending.resolve(graph);
		}
	});
	it("coalesces repeated background requests and rejects a third active root", async () => {
		const { runtime, collect } = await setup();
		const first = deferred<ProjectGraph>();
		const second = deferred<ProjectGraph>();
		collect
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		try {
			const a = (await runtime.dispatch("map_td_project", { wait: false })) as {
				job: ScanJob;
			};
			const repeated = (await runtime.dispatch("map_td_project", {
				wait: false,
			})) as { job: ScanJob };
			expect(repeated.job.jobId).toBe(a.job.jobId);
			await runtime.dispatch("map_td_project", {
				rootPath: "/project2",
				wait: false,
			});
			await expect(
				runtime.dispatch("map_td_project", {
					rootPath: "/project3",
					wait: false,
				}),
			).rejects.toThrow(/Two.*scans/);
			await expect(
				runtime.dispatch("map_td_project", { rootPath: "/project3" }),
			).rejects.toThrow(/Two.*scans/);
			expect(collect).toHaveBeenCalledTimes(2);
		} finally {
			first.resolve(graph);
			second.resolve({ ...graph, rootPath: "/project2" });
		}
	});
	it("reports rejected and incomplete scans as failed, then permits an explicit retry", async () => {
		const { runtime, collect } = await setup();
		collect.mockRejectedValueOnce(new Error("bridge disconnected"));
		const failed = (await runtime.dispatch("map_td_project", {
			wait: false,
		})) as { job: ScanJob };
		await vi.waitFor(async () =>
			expect((await jobState(runtime)).job?.status).toBe("failed"),
		);
		collect.mockResolvedValueOnce({
			...graph,
			complete: false,
			coverage: { remaining: null, truncated: true, visited: 0 },
			status: "stale",
		});
		const truncated = (await runtime.dispatch("map_td_project", {
			wait: false,
		})) as { job: ScanJob };
		expect(truncated.job.jobId).not.toBe(failed.job.jobId);
		await vi.waitFor(async () =>
			expect((await jobState(runtime)).job?.status).toBe("failed"),
		);
		expect((await jobState(runtime)).job?.remaining).toBeNull();
		await runtime.dispatch("map_td_project", { wait: false });
		await vi.waitFor(async () =>
			expect((await jobState(runtime)).job?.status).toBe("complete"),
		);
	});
	it("aborts and drains active background collection before close resolves", async () => {
		const { runtime, collect } = await setup();
		let signal: AbortSignal | undefined;
		let aborted = false;
		collect.mockImplementationOnce(async (_, options) => {
			signal = options.signal;
			return new Promise<ProjectGraph>((resolve) =>
				options.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve({ ...graph, complete: false, status: "stale" });
					},
					{ once: true },
				),
			);
		});
		await runtime.dispatch("map_td_project", { wait: false });
		await runtime.close();
		expect(signal?.aborted).toBe(true);
		expect(aborted).toBe(true);
		await expect(runtime.dispatch("map_td_project", {})).rejects.toThrow(
			/closed/,
		);
	});
	it("evicts completed jobs even when the oldest job is still active", async () => {
		const { runtime, collect } = await setup();
		const pending = deferred<ProjectGraph>();
		collect.mockImplementationOnce(() => pending.promise);
		try {
			await runtime.dispatch("map_td_project", {
				rootPath: "/long",
				wait: false,
			});
			for (let index = 0; index < 12; index++) {
				const rootPath = `/short${index}`;
				collect.mockResolvedValueOnce({ ...graph, rootPath });
				await runtime.dispatch("map_td_project", { rootPath, wait: false });
				await vi.waitFor(async () =>
					expect((await jobState(runtime, rootPath)).job?.status).toBe(
						"complete",
					),
				);
			}
			const states = await Promise.all(
				["/long", ...Array.from({ length: 12 }, (_, i) => `/short${i}`)].map(
					(root) => jobState(runtime, root),
				),
			);
			expect(
				states.filter((state) => state.job !== null).length,
			).toBeLessThanOrEqual(8);
			expect(states[0].job?.status).toBe("scanning");
		} finally {
			pending.resolve({ ...graph, rootPath: "/long" });
		}
	});
	it("never starts a queued dependency upgrade after shutdown begins", async () => {
		const { runtime, collect } = await setup();
		collect.mockImplementationOnce(
			async (_, options) =>
				new Promise<ProjectGraph>((resolve) =>
					options.signal?.addEventListener(
						"abort",
						() => resolve({ ...graph, complete: false, rootPath: "/" }),
						{ once: true },
					),
				),
		);
		await runtime.dispatch("map_td_project", { rootPath: "/", wait: false });
		const outcome = runtime
			.dispatch("plan_td_refactor", {
				name: "wrapped",
				paths: ["/project1/n0"],
			})
			.then(
				() => "resolved",
				() => "rejected",
			);
		await runtime.close();
		expect(await outcome).toBe("rejected");
		expect(collect).toHaveBeenCalledTimes(1);
	});
});

describe("background watch handoff", () => {
	it("starts polling when watch attaches to an already running refresh job", async () => {
		vi.useFakeTimers();
		const { runtime, collect, executor } = await setup();
		const pending = deferred<ProjectGraph>();
		collect.mockImplementationOnce(() => pending.promise);
		try {
			await runtime.dispatch("map_td_project", { wait: false });
			executor.execute.mockResolvedValueOnce({ available: true });
			const result = (await runtime.dispatch("map_td_project", {
				action: "watch",
				intervalMs: 1000,
				wait: false,
			})) as { watching: boolean };
			expect(result.watching).toBe(true);
			pending.resolve(graph);
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			pending.resolve(graph);
			await runtime.close();
			vi.useRealTimers();
		}
	});
});
