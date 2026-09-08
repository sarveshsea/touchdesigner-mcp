import { describe, expect, it, vi } from "vitest";
import {
	collectProjectGraph,
	type GraphScanProgress,
} from "../../../src/architecture/graph/index.js";

const page = (child = false) => ({
	build: "202533230",
	dependencyComplete: true,
	dirtyRevision: 0,
	discovered: child ? [] : [{ path: "/root/child" }],
	edges: [],
	missing: [],
	nodes: [
		{
			family: "COMP",
			fingerprint: child ? "2" : "1",
			flags: {},
			id: child ? 2 : 1,
			name: child ? "child" : "root",
			nodeX: 0,
			nodeY: 0,
			opType: "baseCOMP",
			ownership: [],
			parentPath: child ? "/root" : "/",
			path: child ? "/root/child" : "/root",
			tags: [],
		},
	],
	pending: [],
	projectId: "p",
	projectPath: "/synthetic/test.toe",
	sessionId: "s",
	truncated: false,
	warnings: [],
});
describe("long-lived in-memory graph scans", () => {
	it("accepts an explicit one-hour budget without changing the default boundary", async () => {
		const execute = vi.fn().mockResolvedValue({ ...page(), discovered: [] });
		expect(
			(
				await collectProjectGraph(
					{ execute },
					{ maxDurationMs: 3600000, rootPath: "/root" },
				)
			).complete,
		).toBe(true);
		await expect(
			collectProjectGraph(
				{ execute },
				{ maxDurationMs: 3600001, rootPath: "/root" },
			),
		).rejects.toThrow();
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("publishes immutable scalar progress once per accepted page", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(page())
			.mockResolvedValueOnce(page(true));
		const updates: GraphScanProgress[] = [];
		const graph = await collectProjectGraph(
			{ execute },
			{ onProgress: (progress) => updates.push(progress), rootPath: "/root" },
		);
		expect(graph.complete).toBe(true);
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ pages: 1, remaining: 1, visited: 1 });
		expect(updates[1]).toMatchObject({ pages: 2, remaining: 0, visited: 2 });
		expect(Object.keys(updates[0]).sort()).toEqual([
			"elapsedMs",
			"pages",
			"remaining",
			"visited",
		]);
		expect(Object.isFrozen(updates[0])).toBe(true);
		expect(updates[1].elapsedMs).toBeGreaterThanOrEqual(updates[0].elapsedMs);
	});
	it("reports unknown remaining coverage when capacity truncates the frontier", async () => {
		const progress = vi.fn();
		await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(page()) },
			{ maxNodes: 1, onProgress: progress, rootPath: "/root" },
		);
		expect(progress).toHaveBeenCalledWith(
			expect.objectContaining({ remaining: null, visited: 1 }),
		);
	});
	it("isolates a failed progress consumer without leaking its message or losing the scan", async () => {
		const progress = vi.fn(() => {
			throw new Error("private publisher detail");
		});
		const execute = vi
			.fn()
			.mockResolvedValueOnce(page())
			.mockResolvedValueOnce(page(true));
		const graph = await collectProjectGraph(
			{ execute },
			{ onProgress: progress, rootPath: "/root" },
		);
		expect(graph.complete).toBe(true);
		expect(progress).toHaveBeenCalledTimes(1);
		expect(graph.warnings.join(" ")).toContain("Progress listener failed");
		expect(JSON.stringify(graph)).not.toContain("private publisher detail");
	});
	it("cancels in-flight waiting without dispatching another page", async () => {
		const controller = new AbortController();
		const execute = vi.fn(() => {
			queueMicrotask(() => controller.abort());
			return new Promise(() => {});
		});
		const graph = await collectProjectGraph(
			{ execute },
			{ maxDurationMs: 3600000, rootPath: "/root", signal: controller.signal },
		);
		expect(graph.status).toBe("stale");
		expect(graph.coverage.truncated).toBe(true);
		expect(graph.warnings.join(" ")).toContain("cancelled");
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("retains accepted pages when cancelled from progress", async () => {
		const controller = new AbortController();
		const execute = vi.fn().mockResolvedValue(page());
		const graph = await collectProjectGraph(
			{ execute },
			{
				onProgress: () => controller.abort(),
				rootPath: "/root",
				signal: controller.signal,
			},
		);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.complete).toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
