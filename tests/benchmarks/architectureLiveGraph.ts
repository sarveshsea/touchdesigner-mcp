/** Opt-in owned-fixture benchmark. Never import this module to start TD work.
 * TD_LIVE_TESTS=1 node tests/benchmarks/architectureLiveGraph.ts --live --counts=1000,10000
 * Current dist must be built; no project save or unowned-node modification occurs.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { CollectGraphOptions } from "../../src/architecture/graph/index.js";
import type {
	BridgeExecutor,
	ProjectGraph,
} from "../../src/architecture/types.js";
import { buildFixtureScript } from "./architectureLiveFixture.ts";

const optionsSchema = z.object({
	batchSize: z.number().int().min(1).max(100).default(100),
	counts: z
		.array(z.union([z.literal(1000), z.literal(10000)]))
		.min(1)
		.max(2)
		.default([1000, 10000]),
	maxDurationMs: z.number().int().min(1000).max(3600000).default(3600000),
	pageSize: z.number().int().min(1).max(500).default(100),
	parentPath: z
		.string()
		.regex(/^\/(?:[A-Za-z0-9_]+\/?)*$/)
		.max(512)
		.default("/project1"),
});
export type LiveBenchmarkOptions = z.input<typeof optionsSchema> & {
	signal?: AbortSignal;
};
type Dependencies = {
	executor: BridgeExecutor;
	collect: (
		executor: BridgeExecutor,
		options: CollectGraphOptions,
	) => Promise<ProjectGraph>;
};
function decode(input: unknown): Record<string, unknown> {
	let value = input;
	for (let depth = 0; depth < 4; depth++) {
		if (typeof value === "string") {
			if (Buffer.byteLength(value) > 8 * 1024 * 1024)
				throw new Error("BENCHMARK_RESPONSE_TOO_LARGE");
			value = JSON.parse(value);
			continue;
		}
		if (value && typeof value === "object" && "result" in value) {
			value = (value as { result: unknown }).result;
			continue;
		}
		break;
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("BENCHMARK_INVALID_RESPONSE");
	return value as Record<string, unknown>;
}
const finite = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
async function exec(executor: BridgeExecutor, script: string) {
	return decode(await executor.execute(script));
}
export function parseLiveBenchmarkArgs(
	args: string[],
	env: Record<string, string | undefined>,
) {
	if (env.TD_LIVE_TESTS !== "1" || !args.includes("--live"))
		throw new Error("Explicit live benchmark opt-in required");
	const counts = args
		.find((arg) => arg.startsWith("--counts="))
		?.slice(9)
		.split(",")
		.map(Number) ?? [1000, 10000];
	const duration = args.find((arg) => arg.startsWith("--max-duration-ms="));
	const maxDurationMs = duration ? Number(duration.slice(18)) : undefined;
	if (
		args.some(
			(arg) =>
				arg !== "--live" &&
				!arg.startsWith("--counts=") &&
				!arg.startsWith("--max-duration-ms="),
		)
	)
		throw new Error("Unknown benchmark argument");
	return optionsSchema.parse({ counts, maxDurationMs });
}
/** One scenario at a time. Cleanup runs after any setup/collection failure;
 * an ownership failure stops the run and is reported, never overwritten. */
export async function runLiveArchitectureBenchmark(
	dependencies: Dependencies,
	input: LiveBenchmarkOptions = {},
) {
	const options = optionsSchema.parse(input);
	const results = [];
	for (const count of options.counts) {
		if (input.signal?.aborted) break;
		const owner = randomBytes(16).toString("hex");
		const rootPath = `${options.parentPath.replace(/\/$/, "")}/__td_mcp_live_bench_${owner}`;
		const fixture = {
			batchSize: options.batchSize,
			count,
			owner,
			parentPath: options.parentPath,
		};
		const started = performance.now();
		let rootId: number | null = null;
		let created = false;
		let phase = "setup";
		let cleanupComplete = false;
		let cleanupCalls = 0;
		let collectionCalls = 0;
		let bridgeMs = 0;
		let pythonMs = 0;
		let pythonSamples = 0;
		let collectionMs: number | null = null;
		let observedNodes = 0;
		let observedEdges = 0;
		let complete = false;
		let dependencyComplete = false;
		let graphStatus = "unavailable";
		let build = "unknown";
		let diagnosticBefore: Record<string, unknown> | null = null;
		let diagnosticAfter: Record<string, unknown> | null = null;
		let failure: string | null = null;
		try {
			const setup = await exec(
				dependencies.executor,
				buildFixtureScript({ ...fixture, action: "create" }),
			);
			created = true;
			rootId = z.number().int().nonnegative().parse(setup.rootId);
			for (let offset = 0; offset < count - 1; ) {
				if (
					input.signal?.aborted ||
					performance.now() - started >= options.maxDurationMs
				)
					throw new Error("BENCHMARK_INTERRUPTED");
				const response = await exec(
					dependencies.executor,
					buildFixtureScript({
						...fixture,
						action: "populate",
						offset,
						rootId,
					}),
				);
				const next = z
					.number()
					.int()
					.min(offset + 1)
					.max(Math.min(offset + options.batchSize, count - 1))
					.parse(response.nextOffset);
				offset = next;
			}
			diagnosticBefore = await exec(
				dependencies.executor,
				buildFixtureScript({ ...fixture, action: "sample", rootId }),
			);
			phase = "collection";
			const collectionStarted = performance.now();
			const measured = {
				execute: async (script: string) => {
					const start = performance.now();
					const value = await dependencies.executor.execute(script);
					bridgeMs += performance.now() - start;
					collectionCalls++;
					const parsed = decode(value);
					const stats = parsed.scanStats;
					if (stats && typeof stats === "object") {
						const time = finite((stats as { pythonMs?: unknown }).pythonMs);
						if (time !== null) {
							pythonMs += time;
							pythonSamples++;
						}
					}
					return value;
				},
			};
			const graph = await dependencies.collect(measured, {
				dependencyAnalysis: false,
				maxDurationMs: Math.max(
					1,
					Math.floor(options.maxDurationMs - (performance.now() - started)),
				),
				maxNodes: count,
				pageSize: options.pageSize,
				rootPath,
				signal: input.signal,
			});
			collectionMs = performance.now() - collectionStarted;
			observedNodes = graph.nodes.length;
			observedEdges = graph.edges.length;
			complete = graph.complete;
			dependencyComplete = graph.dependencyComplete;
			graphStatus = graph.status;
			build = /^\d{4}\.?\d{1,10}$/.test(graph.build) ? graph.build : "unknown";
			diagnosticAfter = await exec(
				dependencies.executor,
				buildFixtureScript({ ...fixture, action: "sample", rootId }),
			);
			if (!complete || observedNodes !== count || graphStatus !== "fresh")
				failure = "collection_incomplete";
		} catch {
			failure = phase === "setup" ? "setup_failed" : "collection_failed";
		} finally {
			const cleanupStarted = performance.now();
			for (
				let attempt = 0;
				attempt < Math.ceil(count / options.batchSize) * 4 + 8 &&
				performance.now() - cleanupStarted < 300000;
				attempt++
			) {
				try {
					const response = await exec(
						dependencies.executor,
						buildFixtureScript({ ...fixture, action: "cleanup", rootId }),
					);
					cleanupCalls++;
					if (response.done === true) {
						cleanupComplete = true;
						break;
					}
					if (response.done !== false) break;
				} catch {
					break;
				}
			}
		}
		const diagnostics = (sample: Record<string, unknown> | null) =>
			sample
				? {
						fixtureCookingDisabled: sample.fixtureCookingDisabled === true,
						rootChildrenCpuCookMs: finite(sample.rootChildrenCpuCookMs),
						rootCpuCookMs: finite(sample.rootCpuCookMs),
						sampledCpuBytes: finite(sample.sampledCpuBytes),
						sampledCpuCookMsSum: finite(sample.sampledCpuCookMsSum),
						sampledGpuBytes: finite(sample.sampledGpuBytes),
						sampledOperators: finite(sample.sampledOperators),
						sampledTotalCooks: finite(sample.sampledTotalCooks),
					}
				: null;
		results.push({
			bridgeRoundTripMs: Math.round(bridgeMs),
			build,
			cleanupCalls,
			cleanupComplete,
			collectionCalls,
			collectionMs: collectionMs === null ? null : Math.round(collectionMs),
			complete,
			dependencyComplete,
			diagnosticAfter: diagnostics(diagnosticAfter),
			diagnosticBefore: diagnostics(diagnosticBefore),
			failureCode: !cleanupComplete ? "cleanup_failed" : failure,
			fixtureCreated: created,
			graphStatus,
			observedEdges,
			observedNodes,
			pythonScanMs: pythonSamples ? Math.round(pythonMs) : null,
			pythonTimingSamples: pythonSamples,
			requestedNodes: count,
			status: failure || !cleanupComplete ? "failed" : "passed",
			totalMs: Math.round(performance.now() - started),
		});
		if (failure || !cleanupComplete || input.signal?.aborted) break;
	}
	return {
		fixtureCookingDisabled: true,
		fpsMeasured: false,
		generatedAt: new Date().toISOString(),
		kind: "live-owned-fixture-graph-census",
		limits: {
			batchSize: options.batchSize,
			dependencyClosure: "not_certified_for_enclosing_project",
			maxDurationMs: options.maxDurationMs,
			maxMetadataBytes: 134217728,
			pageSize: options.pageSize,
			scope: "owned_fixture_only",
		},
		liveTouchDesignerMeasured: true,
		projectSaved: false,
		results,
		schemaVersion: 1,
	};
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	(async () => {
		const options = parseLiveBenchmarkArgs(process.argv.slice(2), process.env);
		const { TouchDesignerClient } = await import(
			new URL("../../dist/tdClient/touchDesignerClient.js", import.meta.url)
				.href
		);
		const { collectProjectGraph } = await import(
			new URL("../../dist/architecture/graph/index.js", import.meta.url).href
		);
		const td = new TouchDesignerClient();
		const executor = {
			execute: async (script: string) => {
				const response = await td.execPythonScript({ script });
				if (!response.success) throw new Error("BENCHMARK_BRIDGE_FAILED");
				return response.data;
			},
		};
		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.once("SIGINT", cancel);
		process.once("SIGTERM", cancel);
		let receipt: Awaited<ReturnType<typeof runLiveArchitectureBenchmark>>;
		try {
			receipt = await runLiveArchitectureBenchmark(
				{ collect: collectProjectGraph, executor },
				{ ...options, signal: controller.signal },
			);
		} finally {
			process.removeListener("SIGINT", cancel);
			process.removeListener("SIGTERM", cancel);
		}
		if (controller.signal.aborted) process.exitCode = 1;
		process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
		if (receipt.results.some((result) => result.status !== "passed"))
			process.exitCode = 1;
	})().catch(() => {
		process.stderr.write(
			"Live benchmark did not complete. Verify explicit opt-in and a current build; no private error detail is printed.\n",
		);
		process.exitCode = 1;
	});
}
