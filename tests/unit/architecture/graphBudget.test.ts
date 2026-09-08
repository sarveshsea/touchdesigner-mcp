import { describe, expect, it, vi } from "vitest";
import { collectProjectGraph } from "../../../src/architecture/graph/index.js";

const node = (id = 1, tags: string[] = []) => ({
	family: "COMP",
	fingerprint: String(id),
	flags: {},
	id,
	name: "node",
	nodeX: 0,
	nodeY: 0,
	opType: "baseCOMP",
	ownership: [],
	parentPath: id === 1 ? "/" : "/root",
	path: id === 1 ? "/root" : `/root/n${id}`,
	tags,
});
const report = (
	nodes = [node()],
	edges: unknown[] = [],
	pending: unknown[] = [],
) => ({
	build: "202533230",
	dependencyComplete: true,
	dirtyRevision: 0,
	discovered: [],
	edges,
	missing: [],
	nodes,
	pending,
	projectId: "project",
	projectPath: "/synthetic/test.toe",
	sessionId: "session",
	truncated: false,
	warnings: [],
});
const bytes = (records: unknown[]) =>
	records.reduce<number>(
		(sum, record) => sum + Buffer.byteLength(JSON.stringify(record)),
		0,
	);
describe("aggregate retained graph metadata budget", () => {
	it("rejects invalid budgets before contacting the bridge", async () => {
		const execute = vi.fn();
		for (const maxBytes of [1023, 134217729, Number.POSITIVE_INFINITY])
			await expect(
				collectProjectGraph({ execute }, { maxBytes, rootPath: "/root" }),
			).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
	});
	it("stops at the first oversized node and reports truncation through progress", async () => {
		const execute = vi.fn().mockResolvedValue(
			report(
				[
					node(
						1,
						Array.from({ length: 16 }, () => "x".repeat(128)),
					),
				],
				[],
				[{ path: "/root/n2" }],
			),
		);
		const progress = vi.fn();
		const graph = await collectProjectGraph(
			{ execute },
			{ maxBytes: 1024, onProgress: progress, rootPath: "/root" },
		);
		expect(graph.nodes).toHaveLength(0);
		expect(graph.coverage.truncated).toBe(true);
		expect(graph.dependencyComplete).toBe(false);
		expect(graph.warnings.join(" ")).toContain("metadata byte budget");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(progress).toHaveBeenCalledWith(
			expect.objectContaining({ remaining: null, visited: 0 }),
		);
	});
	it("shares the same byte budget between nodes and edges", async () => {
		const edges = Array.from({ length: 20 }, (_, i) => ({
			evidence: "observed",
			id: `e${i}`,
			kind: "wire",
			reason: "x".repeat(128),
			source: "/root",
			target: "/root",
		}));
		const graph = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(report([node()], edges)) },
			{ maxBytes: 1024, rootPath: "/root" },
		);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.edges.length).toBeGreaterThan(0);
		expect(graph.edges.length).toBeLessThan(20);
		expect(bytes([...graph.nodes, ...graph.edges])).toBeLessThanOrEqual(1024);
		expect(graph.complete).toBe(false);
	});
	it("does not charge unchanged duplicate records twice across pages", async () => {
		const item = node(1, ["x".repeat(128)]);
		const edge = {
			evidence: "observed",
			id: "same-edge",
			kind: "wire",
			source: "/root",
			target: "/root",
		};
		const execute = vi
			.fn()
			.mockResolvedValueOnce(report([item], [edge], [{ path: "/root" }]))
			.mockResolvedValueOnce(report([item], [edge], [{ path: "/root" }]))
			.mockResolvedValueOnce(report([item], [edge]));
		const graph = await collectProjectGraph(
			{ execute },
			{ maxBytes: 1024, rootPath: "/root" },
		);
		expect(graph.complete).toBe(true);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.edges).toHaveLength(1);
	});
	it("accounts for replacement growth and keeps the previously retained record when rejected", async () => {
		const original = node();
		const larger = node(
			1,
			Array.from({ length: 16 }, () => "x".repeat(128)),
		);
		const execute = vi
			.fn()
			.mockResolvedValueOnce(report([original], [], [{ path: "/root" }]))
			.mockResolvedValueOnce(report([larger]));
		const graph = await collectProjectGraph(
			{ execute },
			{ maxBytes: 1024, rootPath: "/root" },
		);
		expect(graph.nodes[0]).toEqual(original);
		expect(graph.coverage.truncated).toBe(true);
	});
	it("reclaims serialized bytes when a replacement becomes smaller", async () => {
		const tags = Array.from({ length: 4 }, () => "x".repeat(128));
		const execute = vi
			.fn()
			.mockResolvedValueOnce(report([node(1, tags)], [], [{ path: "/root" }]))
			.mockResolvedValueOnce(report([node(), node(2, tags)]));
		const graph = await collectProjectGraph(
			{ execute },
			{ maxBytes: 1024, rootPath: "/root" },
		);
		expect(graph.nodes).toHaveLength(2);
		expect(graph.complete).toBe(true);
		expect(bytes(graph.nodes)).toBeLessThanOrEqual(1024);
	});
});
