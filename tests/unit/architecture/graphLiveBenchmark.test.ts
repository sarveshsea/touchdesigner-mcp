import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureScript } from "../../benchmarks/architectureLiveFixture.ts";
import {
	parseLiveBenchmarkArgs,
	runLiveArchitectureBenchmark,
} from "../../benchmarks/architectureLiveGraph.ts";

const owner = "a".repeat(32);
const pythonFixture = `
import types
nodes={}
class Port:
 def connect(self,node): pass
class Node:
 def __init__(self,path):
  self.path=path;self.id=len(nodes)+1;self.children=[];self.storage={};self.par=types.SimpleNamespace(chop=None);self.inputConnectors=[Port()];self.cpuCookTime=0;self.childrenCPUCookTime=0;self.totalCooks=0;self.cpuMemory=0;self.gpuMemory=0;nodes[path]=self
 def create(self,kind,name):
  n=Node(self.path+'/'+name);n.parentNode=self;n.kind=kind;self.children.append(n);return n
 def store(self,k,v): self.storage[k]=v
 def fetch(self,k,default=None): return self.storage.get(k,default)
 def op(self,name): return nodes.get(self.path+'/'+name)
 def destroy(self):
  assert not self.children,'cleanup must be batched'
  self.parentNode.children.remove(self);nodes.pop(self.path)
def op(path): return nodes.get(path)
parent=Node('/project1')
td=types.SimpleNamespace(baseCOMP='base',constantCHOP='constant',nullCHOP='null',selectCHOP='select',textDAT='text',passive=lambda n:n)
`;
function python(scripts: string[], extra = "") {
	const command = `${pythonFixture}\n${extra}\n${scripts.map((script) => `exec(${JSON.stringify(script)})\nprint(result)`).join("\n")}`;
	return execFileSync("python3", ["-c", command], {
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	})
		.trim()
		.split("\n")
		.map((row) => JSON.parse(row));
}
const params = { batchSize: 4, count: 1000, owner, parentPath: "/project1" };
describe("owned live benchmark fixture scripts", () => {
	it("creates and removes only its owned nodes in bounded batches", () => {
		const outputs = python([
			buildFixtureScript({ ...params, action: "create" }),
			buildFixtureScript({ ...params, action: "populate", offset: 0 }),
			buildFixtureScript({ ...params, action: "sample" }),
			buildFixtureScript({ ...params, action: "cleanup" }),
			buildFixtureScript({ ...params, action: "cleanup" }),
		]);
		expect(outputs[1].created).toBe(4);
		expect(outputs[2].sampledOperators).toBe(5);
		expect(outputs[3].removed).toBe(4);
		expect(outputs[4].done).toBe(true);
	});
	it("refuses to replace a pre-existing fixture path", () => {
		expect(() =>
			python([
				buildFixtureScript({ ...params, action: "create" }),
				buildFixtureScript({ ...params, action: "create" }),
			]),
		).toThrow();
	});
	it("refuses cleanup when ownership or expected identity changes", () => {
		expect(() =>
			python([
				buildFixtureScript({ ...params, action: "create" }),
				buildFixtureScript({ ...params, action: "cleanup", rootId: 999 }),
			]),
		).toThrow();
		expect(() =>
			python([
				buildFixtureScript({ ...params, action: "create" }),
				`r=op('/project1/__td_mcp_live_bench_${owner}');r.store('td_mcp_benchmark_owner','other')\n${buildFixtureScript({ ...params, action: "cleanup" })}`,
			]),
		).toThrow();
	});
	it("protects a foreign child added under the fixture", () => {
		expect(() =>
			python([
				buildFixtureScript({ ...params, action: "create" }),
				`op('/project1/__td_mcp_live_bench_${owner}').create(td.baseCOMP,'foreign')\n${buildFixtureScript({ ...params, action: "cleanup" })}`,
			]),
		).toThrow();
	});
});
function executor() {
	const actions: string[] = [];
	return {
		actions,
		execute: vi.fn(async (script: string) => {
			const encoded = script.match(
				/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/,
			)?.[1];
			const request = JSON.parse(
				Buffer.from(encoded ?? "", "base64").toString("utf8"),
			);
			actions.push(request.action);
			if (request.action === "create") return { rootId: 5 };
			if (request.action === "populate")
				return {
					created: Math.min(
						request.batchSize,
						request.count - 1 - request.offset,
					),
					nextOffset: Math.min(
						request.offset + request.batchSize,
						request.count - 1,
					),
				};
			if (request.action === "sample")
				return {
					fixtureCookingDisabled: true,
					rootChildrenCpuCookMs: 0,
					rootCpuCookMs: 0,
					sampledCpuBytes: 0,
					sampledCpuCookMsSum: 0,
					sampledGpuBytes: 0,
					sampledOperators: 33,
					sampledTotalCooks: 0,
				};
			return { done: true, remaining: 0, removed: 0 };
		}),
	};
}
describe("live benchmark orchestration", () => {
	it("does not create a fixture when already cancelled", async () => {
		const bridge = executor();
		const controller = new AbortController();
		controller.abort();
		const receipt = await runLiveArchitectureBenchmark(
			{ collect: vi.fn(), executor: bridge },
			{ counts: [1000], signal: controller.signal },
		);
		expect(receipt.results).toEqual([]);
		expect(bridge.execute).not.toHaveBeenCalled();
	});
	it("rejects a stale census even when its node count is complete", async () => {
		const receipt = await runLiveArchitectureBenchmark(
			{
				collect: vi.fn().mockResolvedValue({
					build: "202533230",
					complete: true,
					dependencyComplete: false,
					edges: [],
					nodes: Array.from({ length: 1000 }, () => ({})),
					status: "stale",
				}),
				executor: executor(),
			},
			{ counts: [1000] },
		);
		expect(receipt.results[0].failureCode).toBe("collection_incomplete");
		expect(receipt.results[0].cleanupComplete).toBe(true);
	});
	it("requires explicit CLI live opt-in and rejects unsupported counts", () => {
		expect(() => parseLiveBenchmarkArgs([], {})).toThrow();
		expect(() =>
			parseLiveBenchmarkArgs(["--live", "--counts=50000"], {
				TD_LIVE_TESTS: "1",
			}),
		).toThrow();
		expect(
			parseLiveBenchmarkArgs(["--live", "--counts=1000"], {
				TD_LIVE_TESTS: "1",
			}).counts,
		).toEqual([1000]);
		expect(
			parseLiveBenchmarkArgs(["--live", "--max-duration-ms=300000"], {
				TD_LIVE_TESTS: "1",
			}).maxDurationMs,
		).toBe(300000);
		expect(() =>
			parseLiveBenchmarkArgs(["--live", "--max-duration-ms=9000000"], {
				TD_LIVE_TESTS: "1",
			}),
		).toThrow();
	});
	it("cleans up after collection failure and emits no private paths", async () => {
		const bridge = executor();
		const receipt = await runLiveArchitectureBenchmark(
			{
				collect: vi.fn().mockRejectedValue(new Error("/private/token")),
				executor: bridge,
			},
			{ counts: [1000] },
		);
		expect(bridge.actions.at(-1)).toBe("cleanup");
		expect(receipt.results[0].cleanupComplete).toBe(true);
		expect(receipt.results[0].status).toBe("failed");
		expect(JSON.stringify(receipt)).not.toContain("/private");
		expect(JSON.stringify(receipt)).not.toContain("/project1");
	});
	it("collects aggregate timings without interpreting them as FPS", async () => {
		const bridge = executor();
		const collect = vi.fn(async (_executor, _options) => ({
			build: "202533230",
			complete: true,
			coverage: { truncated: false },
			dependencyComplete: false,
			edges: [],
			nodes: Array.from({ length: 1000 }, () => ({})),
			status: "fresh",
		}));
		const receipt = await runLiveArchitectureBenchmark(
			{ collect, executor: bridge },
			{ counts: [1000] },
		);
		expect(receipt.results[0].status).toBe("passed");
		expect(receipt.results[0].observedNodes).toBe(1000);
		expect(receipt.liveTouchDesignerMeasured).toBe(true);
		expect(receipt.fpsMeasured).toBe(false);
	});
});
