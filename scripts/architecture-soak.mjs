#!/usr/bin/env node
/** Read-only observation of an already running watch. Never starts/stops watch,
 * drains its ledger, refreshes a graph, cooks operators, or installs TD nodes. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const HELP = `Usage: node scripts/architecture-soak.mjs [options]
  --duration SECONDS         Default 7200; 1..86400
  --sample SECONDS           Read-only TD probe interval, default 2; 1..60
  --status-interval SECONDS  Cached daemon status and RSS interval, default 30; 5..300
  --root OP_PATH             Already watched root, default /project1
  --out DIRECTORY           New private output directory (must not exist)
  --help                    Show help without loading or connecting to the service

Requires npm run build:dist, a connected TD bridge, an installed native observer,
and an already active map_td_project watch for the same root. This runner does
not start watch. It writes samples.jsonl and summary.json, never raw graph/source.
Default output: ~/.touchdesigner-mcp/architecture/soaks/<unique run ID>
SIGINT/SIGTERM finish the current read and write a partial summary.\n`;

export function parseOptions(args) {
	const options = {
		duration: 7200,
		root: "/project1",
		sample: 2,
		statusInterval: 30,
	};
	for (let i = 0; i < args.length; i++) {
		const key = args[i];
		if (key === "--help") return { help: true };
		if (
			![
				"--duration",
				"--sample",
				"--status-interval",
				"--root",
				"--out",
			].includes(key)
		)
			throw new Error("Unknown option; use --help.");
		const value = args[++i];
		if (!value || value.startsWith("--"))
			throw new Error("Missing option value.");
		if (key === "--root") options.root = value;
		else if (key === "--out") options.out = resolve(value);
		else
			options[
				{
					"--duration": "duration",
					"--sample": "sample",
					"--status-interval": "statusInterval",
				}[key]
			] = Number(value);
	}
	for (const [key, min, max] of [
		["duration", 1, 86400],
		["sample", 1, 60],
		["statusInterval", 5, 300],
	])
		if (
			!Number.isFinite(options[key]) ||
			options[key] < min ||
			options[key] > max
		)
			throw new Error(`Invalid ${key}; use --help.`);
	if (!/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(options.root))
		throw new Error("Invalid absolute operator root.");
	return options;
}

/** Fixed log histogram: quantiles are bin upper bounds, <=0.8% multiplicative
 * error on (1+x), unless saturation is reported. Memory is constant per metric. */
export class Metric {
	constructor() {
		this.bins = new Uint32Array(4096);
		this.count = 0;
		this.sum = 0;
		this.min = Number.POSITIVE_INFINITY;
		this.max = Number.NEGATIVE_INFINITY;
		this.saturated = 0;
	}
	add(value, seconds = 0) {
		if (!Number.isFinite(value) || value < 0) return;
		if (!this.count) {
			this.first = value;
			this.firstAt = seconds;
		}
		this.last = value;
		this.lastAt = seconds;
		this.count++;
		this.sum += value;
		this.min = Math.min(this.min, value);
		this.max = Math.max(this.max, value);
		const index = Math.ceil(Math.log1p(value) * 128);
		if (index >= this.bins.length) this.saturated++;
		this.bins[Math.min(index, this.bins.length - 1)]++;
	}
	percentile(q) {
		const threshold = Math.ceil(this.count * q);
		let seen = 0;
		for (let i = 0; i < this.bins.length; i++) {
			seen += this.bins[i];
			if (seen >= threshold) return Math.min(this.max, Math.expm1(i / 128));
		}
		return null;
	}
	summary() {
		if (!this.count) return { count: 0 };
		return {
			count: this.count,
			delta: this.last - this.first,
			endpointGrowthPerHour:
				this.lastAt > this.firstAt
					? ((this.last - this.first) * 3600) / (this.lastAt - this.firstAt)
					: null,
			first: this.first,
			last: this.last,
			max: this.max,
			mean: this.sum / this.count,
			min: this.min,
			p50: this.percentile(0.5),
			p95: this.percentile(0.95),
			p99: this.percentile(0.99),
			saturated: this.saturated,
		};
	}
}
const numberOrNull = (v) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
export function compactStatus(status) {
	const graph = status?.graph;
	return {
		graph: graph
			? {
					complete: graph.complete === true,
					dependencyComplete: graph.dependencyComplete === true,
					edges: numberOrNull(graph.totalEdges) ?? graph.edges?.length ?? 0,
					nodes: numberOrNull(graph.totalNodes) ?? graph.nodes?.length ?? 0,
					remaining: numberOrNull(graph.coverage?.remaining),
					revision: numberOrNull(graph.revision),
					status: ["fresh", "stale", "disconnected", "scanning"].includes(
						graph.status,
					)
						? graph.status
						: "unknown",
					truncated: graph.coverage?.truncated === true,
					visited: numberOrNull(graph.coverage?.visited),
				}
			: null,
		intervalMs: numberOrNull(status?.intervalMs),
		pendingScans: numberOrNull(status?.pendingScans),
		watching: status?.watching === true,
	};
}

export function probeScript(root) {
	return `import json, sys, os, math
_a_observer = sys.modules.get('_td_mcp_architecture')
_a_status = _a_observer.status() if _a_observer is not None else {}
_a_root = op(${JSON.stringify(root)})
def _a_number(obj, name):
    try:
        value = float(getattr(obj, name))
        return value if math.isfinite(value) else None
    except Exception:
        return None
_a_result = {'pid': os.getpid(), 'observer': {
    'active': _a_status.get('active', False),
    'pending': _a_status.get('pending'), 'dropped': _a_status.get('dropped'),
    'dirtyRevision': _a_status.get('dirty_revision'), 'watchedCount': _a_status.get('watched_count'),
    'session': _a_status.get('session_id'),
    'rootMatches': _a_status.get('root_path') == ${JSON.stringify(root)}},
    'td': {'timelineFrame': _a_number(absTime, 'frame'), 'timelineSeconds': _a_number(absTime, 'seconds'),
    'rootCpuCookMs': _a_number(_a_root, 'cpuCookTime'),
    'childrenCpuCookMs': _a_number(_a_root, 'childrenCPUCookTime'),
    'childrenGpuCookMs': _a_number(_a_root, 'childrenGPUCookTime'),
    'rootTotalCooks': _a_number(_a_root, 'totalCooks')}}
result=json.dumps(_a_result)`;
}

async function rssBytes(pid) {
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	try {
		const { stdout } = await runFile("ps", ["-o", "rss=", "-p", String(pid)], {
			maxBuffer: 1024,
			timeout: 2500,
		});
		return /^\s*\d+\s*$/.test(stdout) ? Number(stdout.trim()) * 1024 : null;
	} catch {
		return null;
	}
}
async function daemonPid(directory) {
	let file;
	try {
		file = await open(
			join(directory, "service.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const info = await file.stat();
		if (
			!info.isFile() ||
			info.size > 8192 ||
			info.mode & 0o077 ||
			(process.getuid && info.uid !== process.getuid())
		)
			return null;
		const value = JSON.parse(await file.readFile("utf8"));
		return Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
	} catch {
		return null;
	} finally {
		await file?.close();
	}
}
async function newPrivateDirectory(directory) {
	await mkdir(directory, { mode: 0o700, recursive: true });
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.mode & 0o077 ||
		(process.getuid && info.uid !== process.getuid())
	)
		throw new Error(
			"Output parent must be a private directory owned by the current user.",
		);
}

export async function runSoak(options) {
	const [{ callArchitecture }, { architectureExecutor }] = await Promise.all([
		import("../dist/architecture/service/client.js"),
		import("../dist/architecture/daemon.js"),
	]);
	const executor = architectureExecutor();
	const initial = await callArchitecture("map_td_project", {
		action: "status",
		rootPath: options.root,
	});
	if (initial?.watching !== true)
		throw new Error(
			"Start watch for the requested root before running the soak.",
		);
	const state = resolve(
		process.env.TD_ARCHITECTURE_STATE_DIR ??
			join(homedir(), ".touchdesigner-mcp", "architecture"),
	);
	const runId = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
	if (!options.out) await newPrivateDirectory(join(state, "soaks"));
	const directory = options.out ?? join(state, "soaks", runId);
	await mkdir(directory, { mode: 0o700 }); // Existing output is never overwritten.
	const file = await open(join(directory, "samples.jsonl"), "wx", 0o600);
	process.stdout.write(
		`Observing existing watch; private receipts: ${directory}\n`,
	);
	const started = performance.now();
	const startedAt = new Date().toISOString();
	const metrics = new Map();
	const errors = {
		observerInactive: 0,
		probe: 0,
		rssUnavailable: 0,
		status: 0,
		watchInactive: 0,
	};
	let stopped = false;
	let wake;
	let samples = 0;
	let statusSamples = 0;
	let session = null;
	let sessionChanges = 0;
	let revision = null;
	let observedRevisionChanges = 0;
	let nextStatus = 0;
	let nextProbe = 0;
	let skippedProbeDeadlines = 0;
	const stop = () => {
		stopped = true;
		wake?.();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	const elapsed = () => (performance.now() - started) / 1000;
	const add = (name, value) => {
		if (!Number.isFinite(value) || value === null) return;
		if (!metrics.has(name)) metrics.set(name, new Metric());
		metrics.get(name).add(value, elapsed());
	};
	const log = (row) =>
		file.write(`${JSON.stringify({ elapsedSeconds: elapsed(), ...row })}\n`);
	let final;
	try {
		await log({
			requestedDurationSeconds: options.duration,
			runId,
			sampleSeconds: options.sample,
			schemaVersion: 1,
			statusIntervalSeconds: options.statusInterval,
			type: "start",
		});
		while (!stopped && elapsed() < options.duration) {
			const row = { type: "sample" };
			const probeStart = performance.now();
			try {
				const probe = await executor.execute(probeScript(options.root));
				row.probeRpcMs = performance.now() - probeStart;
				add("probeRpcMs", row.probeRpcMs);
				const observer = probe.observer ?? {};
				if (session !== null && session !== observer.session) sessionChanges++;
				session = observer.session;
				row.observer = {
					active: observer.active === true,
					dirtyRevision: numberOrNull(observer.dirtyRevision),
					dropped: numberOrNull(observer.dropped),
					pending: numberOrNull(observer.pending),
					rootMatches: observer.rootMatches === true,
					watchedCount: numberOrNull(observer.watchedCount),
				};
				if (!row.observer.active || !row.observer.rootMatches)
					errors.observerInactive++;
				for (const key of ["pending", "dropped", "watchedCount"])
					add(`observer.${key}`, row.observer[key]);
				row.td = {};
				for (const key of [
					"timelineFrame",
					"timelineSeconds",
					"rootCpuCookMs",
					"childrenCpuCookMs",
					"childrenGpuCookMs",
					"rootTotalCooks",
				]) {
					row.td[key] = numberOrNull(probe.td?.[key]);
					if (key.endsWith("Ms")) add(`td.${key}`, row.td[key]);
				}
				if (elapsed() >= nextStatus) {
					const statusStart = performance.now();
					try {
						row.service = compactStatus(
							await callArchitecture("map_td_project", {
								action: "status",
								rootPath: options.root,
							}),
						);
						row.statusRpcMs = performance.now() - statusStart;
						add("statusRpcMs", row.statusRpcMs);
						statusSamples++;
						if (!row.service.watching) errors.watchInactive++;
						for (const key of ["pendingScans", "intervalMs"])
							add(`service.${key}`, row.service[key]);
						for (const key of ["nodes", "edges"])
							add(`graph.${key}`, row.service.graph?.[key]);
						const nextRevision = row.service.graph?.revision;
						if (revision !== null && nextRevision !== revision)
							observedRevisionChanges++;
						revision = nextRevision;
					} catch {
						errors.status++;
						row.statusError = "status_read_failed";
					}
					const servicePid = await daemonPid(state);
					const [tdRss, serviceRss] = await Promise.all([
						rssBytes(probe.pid),
						rssBytes(servicePid),
					]);
					row.memory = {
						daemonRssBytes: serviceRss,
						runnerRssBytes: process.memoryUsage().rss,
						tdRssBytes: tdRss,
					};
					for (const [key, value] of Object.entries(row.memory)) {
						if (value === null) errors.rssUnavailable++;
						else add(`memory.${key}`, value);
					}
					nextStatus = elapsed() + options.statusInterval;
				}
			} catch {
				errors.probe++;
				row.probeError = "bridge_read_failed";
			}
			add("runnerRssBytes", process.memoryUsage().rss);
			samples++;
			await log(row);
			nextProbe += options.sample;
			if (nextProbe < elapsed()) {
				const missed = Math.ceil((elapsed() - nextProbe) / options.sample);
				skippedProbeDeadlines += missed;
				nextProbe += missed * options.sample;
			}
			await new Promise((resolveWait) => {
				const timer = setTimeout(
					resolveWait,
					Math.max(0, Math.min(nextProbe, options.duration) - elapsed()) * 1000,
				);
				wake = () => {
					clearTimeout(timer);
					resolveWait();
				};
				if (stopped) wake();
			});
			wake = null;
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		final = {
			completedRequestedDuration: !stopped && elapsed() >= options.duration,
			elapsedSeconds: elapsed(),
			endedAt: new Date().toISOString(),
			errors,
			measurementLimits: [
				"Quantiles are fixed histogram upper bounds, not exact order statistics.",
				"TD cook times are sampled last-cook counters, not per-frame frame-time distributions or a 60 fps acceptance test.",
				"Timeline counters are not measured render FPS. Graph revision changes are observations, not an exact completed-scan count.",
				"Queue growth is endpoint delta and rate plus maximum, not a leak diagnosis; session resets can reduce counters.",
				"RSS includes process allocations and driver effects; this run cannot identify individual resource leaks.",
				"Sampling performs read-only bridge requests and cached full-graph status reads; it adds measurement overhead.",
			],
			metrics: Object.fromEntries(
				[...metrics].map(([key, metric]) => [key, metric.summary()]),
			),
			observedRevisionChanges,
			requestedDurationSeconds: options.duration,
			runId,
			samples,
			schemaVersion: 1,
			sessionChanges,
			skippedProbeDeadlines,
			startedAt,
			statusSamples,
		};
		await file.sync();
		await file.close();
		const summary = await open(join(directory, "summary.json"), "wx", 0o600);
		try {
			await summary.writeFile(`${JSON.stringify(final, null, 2)}\n`);
			await summary.sync();
		} finally {
			await summary.close();
		}
	}
	process.stdout.write(
		`Soak ${final.completedRequestedDuration ? "complete" : "interrupted"}: ${directory}\n`,
	);
	return final;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const options = parseOptions(process.argv.slice(2));
		if (options.help) process.stdout.write(HELP);
		else await runSoak(options);
	} catch (error) {
		// Avoid printing raw bridge errors, graph paths, or service credentials.
		process.stderr.write(
			`Architecture soak failed. ${error instanceof Error && /^(Unknown|Missing|Invalid|Start watch|Output parent)/.test(error.message) ? error.message : "Check the build, existing watch, bridge, and private output directory."}\n`,
		);
		process.exitCode = 1;
	}
}
