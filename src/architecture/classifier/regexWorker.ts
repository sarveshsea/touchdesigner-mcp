import { parentPort, workerData } from "node:worker_threads";

interface Rule {
	id: string;
	nameRegex?: string;
	pathRegex?: string;
}
interface Input {
	rules: Rule[];
	nodes: Array<{ name: string; path: string }>;
}
const { rules, nodes } = workerData as Input;
const warnings: string[] = [];
const matches: Array<[number, number]> = [];
for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
	const rule = rules[ruleIndex];
	let name: RegExp | undefined;
	let path: RegExp | undefined;
	try {
		name =
			rule.nameRegex === undefined ? undefined : new RegExp(rule.nameRegex);
		path =
			rule.pathRegex === undefined ? undefined : new RegExp(rule.pathRegex);
	} catch {
		warnings.push(`Regex rule ${rule.id} is invalid and was ignored.`);
		continue;
	}
	for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
		const node = nodes[nodeIndex];
		if ((!name || name.test(node.name)) && (!path || path.test(node.path)))
			matches.push([ruleIndex, nodeIndex]);
		if (matches.length >= 50000) {
			warnings.push(
				"Regex match limit reached (50000); remaining rules were skipped.",
			);
			parentPort?.postMessage({ matches, warnings });
			process.exit(0);
		}
	}
}
parentPort?.postMessage({ matches, warnings });
