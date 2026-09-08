import { Worker } from "node:worker_threads";

let activeWorkers = 0;

export interface RegexRule {
	id: string;
	nameRegex?: string;
	pathRegex?: string;
}
export interface RegexResult {
	matches: Array<[number, number]>;
	warnings: string[];
}
/** No user expression is compiled or executed in the MCP/TouchDesigner thread. */
export async function runRegexRules(
	rules: RegexRule[],
	nodes: Array<{ name: string; path: string }>,
	timeoutMs = 500,
): Promise<RegexResult> {
	const warnings: string[] = [];
	const selected: RegexRule[] = [];
	const indexes: number[] = [];
	for (const [index, rule] of rules.entries()) {
		if (index >= 32) {
			warnings.push("Regex rule limit reached (32).");
			break;
		}
		if (
			(rule.nameRegex?.length ?? 0) > 256 ||
			(rule.pathRegex?.length ?? 0) > 256
		) {
			warnings.push(
				`Regex rule ${rule.id} has an oversized pattern and was ignored.`,
			);
			continue;
		}
		selected.push(rule);
		indexes.push(index);
	}
	if (selected.length === 0 || nodes.length === 0)
		return { matches: [], warnings };
	if (activeWorkers >= 2)
		return {
			matches: [],
			warnings: [
				...warnings,
				"Regex workers busy (limit 2); regex evidence was skipped.",
			],
		};
	const bounded: Array<{ name: string; path: string }> = [];
	let size = 0;
	for (const node of nodes) {
		const item = {
			name: node.name.slice(0, 512),
			path: node.path.slice(0, 2048),
		};
		size += item.name.length + item.path.length;
		if (bounded.length >= 50000 || size > 8_000_000) {
			warnings.push(
				"Regex input budget reached; remaining nodes were skipped.",
			);
			break;
		}
		bounded.push(item);
	}
	const budget = Number.isFinite(timeoutMs)
		? Math.min(2000, Math.max(25, timeoutMs))
		: 500;
	return new Promise((resolve) => {
		const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		activeWorkers++;
		let worker: Worker;
		try {
			worker = new Worker(
				new URL(`./regexWorker${extension}`, import.meta.url),
				{
					resourceLimits: {
						maxOldGenerationSizeMb: 64,
						maxYoungGenerationSizeMb: 16,
						stackSizeMb: 4,
					},
					workerData: { nodes: bounded, rules: selected },
				},
			);
		} catch {
			activeWorkers--;
			resolve({
				matches: [],
				warnings: [
					...warnings,
					"Regex worker could not start; regex evidence was discarded.",
				],
			});
			return;
		}
		let done = false;
		const finish = (result: RegexResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			void worker.terminate().then(
				() => {
					activeWorkers--;
					resolve({
						matches: result.matches.map(([rule, node]) => [
							indexes[rule],
							node,
						]),
						warnings: [...warnings, ...result.warnings],
					});
				},
				() => {
					activeWorkers--;
					resolve({
						matches: [],
						warnings: [
							...warnings,
							...result.warnings,
							"Regex worker cleanup failed; evidence was discarded.",
						],
					});
				},
			);
		};
		const timer = setTimeout(
			() =>
				finish({
					matches: [],
					warnings: [
						`Regex timeout (${budget}ms); regex evidence was discarded.`,
					],
				}),
			budget,
		);
		worker.once("message", (result: RegexResult) => finish(result));
		worker.once("error", () =>
			finish({
				matches: [],
				warnings: ["Regex worker failed; regex evidence was discarded."],
			}),
		);
		worker.once("exit", (code) => {
			if (!done)
				finish({
					matches: [],
					warnings: [`Regex worker exited (${code}) before completing.`],
				});
		});
	});
}
