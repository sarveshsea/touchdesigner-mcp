/** Synthetic CPU benchmark, not live TD performance evidence.
 * Run: npm run build:dist && node tests/benchmarks/architectureGraph.ts
 * JSON stdout contains aggregate timing/counts only; no project/source data.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const palette = [
	"audiodeviceinCHOP",
	"analyzeCHOP",
	"sphereSOP",
	"particlePOP",
	"pbrMAT",
	"renderTOP",
	"levelTOP",
	"textDAT",
	"nullTOP",
	"annotateCOMP",
];
function syntheticNode(index: number) {
	const opType = index === 0 ? "baseCOMP" : palette[index % palette.length];
	const family =
		opType.match(/(?:COMP|CHOP|SOP|POP|MAT|TOP|DAT)$/)?.[0] ?? "COMP";
	const path = index === 0 ? "/" : `/node_${index}`;
	return {
		family,
		fingerprint: hash(`${index}:${opType}`),
		flags: {},
		id: index,
		name: index === 0 ? "root" : `node_${index}`,
		nodeX: index % 50,
		nodeY: 0,
		opType,
		ownership: [],
		parameterReferences: [],
		parentPath: "/",
		path,
		sourceHashes: {},
		tags: [],
	};
}
function syntheticBridge(count: number) {
	let calls = 0;
	const execute = async (script: string) => {
		calls++;
		const encoded = script.match(
			/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/,
		)?.[1];
		if (!encoded) throw new Error("Unsupported graph page script");
		const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		const nodes = [];
		const edges = [];
		const discovered = [];
		const pending = [];
		for (const item of request.items) {
			const index =
				item.path === "/" ? 0 : Number(item.path.slice("/node_".length));
			if (!item.expandOnly) {
				const node = syntheticNode(index);
				nodes.push(node);
				if (index > 0) {
					edges.push({
						evidence: "observed",
						id: `containment-${index}`,
						kind: "containment",
						source: "/",
						target: node.path,
					});
					if (index > 1)
						edges.push({
							evidence: "observed",
							id: `wire-${index}`,
							inputIndex: 0,
							kind: "wire",
							outputIndex: 0,
							source: `/node_${index - 1}`,
							target: node.path,
						});
					if (index > 1 && index % 100 === 2)
						edges.push({
							evidence: "observed",
							id: `feedback-${index}`,
							inputIndex: 1,
							kind: "wire",
							outputIndex: 0,
							source: node.path,
							target: `/node_${index - 1}`,
						});
				}
			}
			if (index === 0) {
				const offset = item.offset ?? 0;
				const next = Math.min(
					count - 1,
					offset + request.pageSize - discovered.length,
				);
				for (let child = offset + 1; child <= next; child++)
					discovered.push({ path: `/node_${child}` });
				if (next < count - 1)
					pending.push({ expandOnly: true, offset: next, path: "/" });
			}
		}
		return JSON.stringify({
			build: "202533230",
			dependencyComplete: true,
			dirtyRevision: 0,
			discovered,
			edges,
			endDirtyRevision: 0,
			missing: [],
			nodes,
			pending,
			projectId: hash("synthetic-project"),
			projectPath: "/synthetic/benchmark.toe",
			sessionId: "synthetic-session",
			truncated: false,
			warnings: [],
		});
	};
	return {
		get calls() {
			return calls;
		},
		execute,
	};
}
export async function runArchitectureBenchmarks() {
	const { collectProjectGraph, graphDiff } = await import(
		new URL("../../dist/architecture/graph/index.js", import.meta.url).href
	);
	const { classifyNetwork } = await import(
		new URL("../../dist/architecture/classifier/index.js", import.meta.url).href
	);
	const results = [];
	for (const count of [1000, 10000, 50000]) {
		const bridge = syntheticBridge(count);
		const memoryBefore = process.memoryUsage().heapUsed;
		const start = performance.now();
		const graph = await collectProjectGraph(bridge, {
			dependencyAnalysis: true,
			maxDurationMs: 300000,
			maxNodes: count,
			pageSize: 100,
			rootPath: "/",
		});
		const collected = performance.now();
		const classification = await classifyNetwork(graph);
		const classified = performance.now();
		const revised = {
			...graph,
			nodes: graph.nodes.map((node: { id: number; fingerprint: string }) =>
				node.id === count - 1
					? { ...node, fingerprint: hash("changed-node") }
					: node,
			),
			revision: graph.revision + 1,
		};
		const delta = graphDiff(graph, revised);
		const finished = performance.now();
		if (delta.changed.length !== 1 || delta.invalidated)
			throw new Error("Graph diff invariant failed");
		if (
			!graph.complete ||
			graph.nodes.length !== count ||
			classification.classifications.length !== count ||
			classification.layout.length !== count
		)
			throw new Error("Synthetic benchmark completeness invariant failed");
		results.push({
			bridgeCalls: bridge.calls,
			classifyMs: Math.round(classified - collected),
			collectMs: Math.round(collected - start),
			complete: graph.complete,
			dependencyComplete: graph.dependencyComplete,
			diffMs: Math.round(finished - classified),
			edges: graph.edges.length,
			heapDeltaMiB: Math.round(
				(process.memoryUsage().heapUsed - memoryBefore) / 1048576,
			),
			nodes: count,
			rssMiB: Math.round(process.memoryUsage().rss / 1048576),
			totalMs: Math.round(finished - start),
		});
	}
	return {
		arch: process.arch,
		generatedAt: new Date().toISOString(),
		kind: "synthetic-cpu-paginated-graph-classifier",
		liveTouchDesignerMeasured: false,
		nodeVersion: process.version,
		platform: process.platform,
		pythonBridgeExecutionMeasured: false,
		results,
		schemaVersion: 1,
	};
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runArchitectureBenchmarks()
		.then((result) =>
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
		)
		.catch(() => {
			process.stderr.write(
				"Architecture benchmark failed; build current sources before running.\n",
			);
			process.exitCode = 1;
		});
}
