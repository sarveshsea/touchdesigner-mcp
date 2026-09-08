import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { classifyNetwork } from "../../../src/architecture/classifier/index.js";
import type { ProjectGraph } from "../../../src/architecture/types.js";

describe("iterative classifier scale receipts", () => {
	it.each([
		1000, 10000, 50000,
	])("handles %i nodes with feedback islands and pinned annotations", async (count) => {
		const graph: ProjectGraph = {
			build: "fixture",
			complete: true,
			coverage: { remaining: 0, truncated: false, visited: count },
			dependencyComplete: true,
			edges: Array.from({ length: count - 1 }, (_, i) => ({
				evidence: "observed",
				id: `e${i}`,
				kind: "wire",
				source: `/project1/n${i}`,
				target: `/project1/n${i + 1}`,
			})).flatMap((item, i) =>
				i % 100 === 1
					? [
							item,
							{
								...item,
								id: `${item.id}-feedback`,
								source: item.target,
								target: item.source,
							},
						]
					: [item],
			),
			nodes: Array.from({ length: count }, (_, i) => ({
				family: i % 50 === 0 ? "COMP" : "TOP",
				fingerprint: `${i}`,
				flags: {},
				id: i,
				name: `n${i}`,
				nodeX: i % 50 === 0 ? 123 : 0,
				nodeY: 0,
				opType: i % 50 === 0 ? "annotateCOMP" : "nullTOP",
				ownership: [],
				parentPath: "/project1",
				path: `/project1/n${i}`,
				tags: [],
			})),
			observedAt: "",
			projectId: "benchmark",
			projectPath: "",
			revision: 1,
			rootPath: "/project1",
			schemaVersion: 1,
			sessionId: "fixture",
			status: "fresh",
			warnings: [],
		};
		const start = performance.now();
		const before = process.memoryUsage().heapUsed;
		const result = await classifyNetwork(graph);
		const elapsedMs = performance.now() - start;
		expect(result.classifications).toHaveLength(count);
		expect(result.layout).toHaveLength(count);
		expect(result.layout[0]).toMatchObject({ pinned: true, x: 123 });
		expect(result.layout[1].group).toBe(result.layout[2].group);
		expect(
			result.layout.every(
				(item) => Number.isFinite(item.x) && Number.isFinite(item.y),
			),
		).toBe(true);
		expect(elapsedMs).toBeLessThan(15000);
		console.info(
			JSON.stringify({
				benchmark: "classifier",
				elapsedMs: Math.round(elapsedMs),
				heapDeltaMiB: Math.round(
					(process.memoryUsage().heapUsed - before) / 1048576,
				),
				nodes: count,
			}),
		);
	}, 20000);
});
