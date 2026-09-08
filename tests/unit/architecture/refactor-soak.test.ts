import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	compactStatus,
	Metric,
	parseOptions,
	probeScript,
} from "../../../scripts/architecture-soak.mjs";
import { architectureExecutor } from "../../../src/architecture/daemon.js";

describe("read-only soak receipts", () => {
	it("honors the actual execution bridge result-variable contract", async () => {
		const executor = architectureExecutor({
			execPythonScript: async ({ script }: { script: string }) => {
				const harness = `import json,sys\nfrom types import SimpleNamespace\nns={'op':lambda p:SimpleNamespace(cpuCookTime=1.2,childrenCPUCookTime=2.3,childrenGPUCookTime=3.4,totalCooks=5),'absTime':SimpleNamespace(frame=60,seconds=1)}\nexec(sys.stdin.read(),ns)\nprint(json.dumps({'success':True,'data':{'result':ns.get('result')}}))`;
				const run = spawnSync("python3", ["-c", harness], {
					encoding: "utf8",
					input: script,
				});
				if (run.status !== 0) throw new Error(run.stderr);
				return JSON.parse(run.stdout);
			},
		} as never);
		const result = (await executor.execute(probeScript("/project1"))) as {
			td: { rootCpuCookMs: number };
			observer: { active: boolean };
		};
		expect(result.td.rootCpuCookMs).toBe(1.2);
		expect(result.observer.active).toBe(false);
	});
	it("retains aggregate census totals and never persists graph source/path metadata", () => {
		const result = compactStatus({
			graph: {
				edges: [],
				nodes: [],
				projectPath: "PRIVATE",
				source: "SECRET",
				status: "fresh",
				totalEdges: 902,
				totalNodes: 753,
			},
			watching: true,
		});
		expect(result.graph.nodes).toBe(753);
		expect(result.graph.edges).toBe(902);
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET/);
	});
	it("bounds options and histogram memory with conservative quantiles", () => {
		expect(parseOptions([]).duration).toBe(7200);
		for (const args of [
			["--duration", "0"],
			["--sample", "NaN"],
			["--root", "/x;bad"],
		])
			expect(() => parseOptions(args)).toThrow();
		const metric = new Metric();
		for (let i = 0; i < 10000; i++) metric.add(i, i);
		expect(metric.bins.length).toBe(4096);
		const result = metric.summary();
		for (const [q, name] of [
			[0.5, "p50"],
			[0.95, "p95"],
			[0.99, "p99"],
		] as const) {
			const exact = Math.ceil(q * 10000) - 1;
			expect(result[name]).toBeGreaterThanOrEqual(exact);
			expect(result[name]).toBeLessThanOrEqual(
				Math.expm1(Math.log1p(exact) + 1 / 128),
			);
		}
		for (const mutation of [
			".cook(",
			".create(",
			".drain(",
			".start(",
			".stop(",
			".destroy(",
		])
			expect(probeScript("/project1")).not.toContain(mutation);
	});
});
