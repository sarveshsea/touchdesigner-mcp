import type {
	Classification,
	GraphNode,
	ProjectGraph,
	Role,
} from "../types.js";
import { dependencyEdges, proposeLayout } from "./layout.js";
import { runRegexRules } from "./regex.js";
import { defaultRulePack, familyRoles } from "./rules.js";
import {
	type ClassifierOptions,
	classifierOptionsSchema,
	type Rule,
	roleSchema,
	rulePackSchema,
} from "./schema.js";

export { defaultRulePack } from "./rules.js";
export type { ClassifierOptions, Rule, RulePack } from "./schema.js";
export {
	classifierOptionsSchema,
	roleSchema,
	roles,
	rulePackSchema,
	ruleSchema,
} from "./schema.js";

type Evidence = Classification["evidence"][number];
function matchesStatic(node: GraphNode, rule: Rule): boolean {
	const match = rule.match;
	return (
		(!match.families ||
			match.families.some(
				(value) => value.toUpperCase() === node.family.toUpperCase(),
			)) &&
		(!match.opTypes ||
			match.opTypes.some(
				(value) => value.toLowerCase() === node.opType.toLowerCase(),
			)) &&
		(!match.tags || match.tags.some((value) => node.tags.includes(value)))
	);
}
function classify(path: string, evidence: Evidence[]): Classification {
	const ordered = [...evidence].sort(
		(a, b) => b.priority - a.priority || a.ruleId.localeCompare(b.ruleId),
	);
	const first = ordered[0];
	if (!first)
		return {
			confidence: 0,
			conflicts: [],
			evidence: [],
			path,
			role: "unknown",
		};
	const ties = new Set(
		ordered
			.filter((item) => item.priority === first.priority)
			.map((item) => item.role),
	);
	const role = ties.size > 1 ? "mixed" : first.role;
	const conflicts = [
		...new Set(
			ordered
				.filter(
					(item) =>
						item.role !== role &&
						(item.priority > 100 || item.source === "regex"),
				)
				.map((item) => item.role),
		),
	];
	const confidence =
		ties.size > 1
			? 0.5
			: first.priority >= 1000
				? 1
				: first.priority >= 950
					? 0.98
					: first.priority >= 700
						? 0.9
						: first.priority >= 400
							? 0.75
							: first.priority >= 300
								? 0.6
								: first.priority > 100
									? 0.35
									: 0.4;
	return { confidence, conflicts, evidence: ordered, path, role };
}
function validateGraph(graph: ProjectGraph): void {
	if (graph.nodes.length > 50000 || graph.edges.length > 500000)
		throw new Error("Classifier graph exceeds 50000 nodes or 500000 edges.");
	const paths = new Set<string>();
	let referenceBudget = 0;
	for (const node of graph.nodes) {
		if (paths.has(node.path))
			throw new Error(`Duplicate node path: ${node.path}`);
		paths.add(node.path);
		if (
			node.path.length > 2048 ||
			node.name.length > 512 ||
			node.parentPath.length > 2048 ||
			node.opType.length > 128 ||
			node.family.length > 64 ||
			node.tags.length > 128 ||
			!Number.isFinite(node.nodeX) ||
			!Number.isFinite(node.nodeY)
		)
			throw new Error("Node exceeds classifier string/tag/coordinate bounds.");
		const references = node.parameterReferences ?? [];
		referenceBudget += references.length;
		if (referenceBudget > 500000)
			throw new Error("Parameter reference budget exceeded (500000).");
		for (const reference of references) {
			referenceBudget += reference.targetPaths.length;
			if (referenceBudget > 500000)
				throw new Error("Parameter reference budget exceeded (500000).");
		}
	}
}
/** Explainable data-only inference; no TD API calls, source evaluation or graph writes. */
export async function classifyNetwork(
	graph: ProjectGraph,
	rawOptions: ClassifierOptions = {},
) {
	validateGraph(graph);
	const options = classifierOptionsSchema.parse(rawOptions);
	const warnings = [...graph.warnings];
	if (!graph.complete || !graph.dependencyComplete)
		warnings.push(
			"Classification/layout uses incomplete graph evidence; missing dependencies may affect grouping.",
		);
	const index = new Map(graph.nodes.map((node, i) => [node.path, i]));
	const evidence: Evidence[][] = graph.nodes.map(() => []);
	const builtin = rulePackSchema.parse(defaultRulePack).rules;
	const custom = options.rulePack?.rules ?? [];
	const regexRules = custom.filter(
		(rule) =>
			rule.match.nameRegex !== undefined || rule.match.pathRegex !== undefined,
	);
	const regex = await runRegexRules(
		regexRules.map((rule) => ({
			id: rule.id,
			nameRegex: rule.match.nameRegex,
			pathRegex: rule.match.pathRegex,
		})),
		graph.nodes,
		options.regexTimeoutMs,
	);
	warnings.push(...regex.warnings);
	for (const [ruleIndex, nodeIndex] of regex.matches) {
		const rule = regexRules[ruleIndex];
		if (matchesStatic(graph.nodes[nodeIndex], rule))
			evidence[nodeIndex].push({
				priority: 110 + rule.priority,
				role: rule.role,
				ruleId: rule.id,
				source: "regex",
			});
	}
	for (const [i, node] of graph.nodes.entries()) {
		const family = familyRoles[node.family.toUpperCase()];
		if (family)
			evidence[i].push({
				priority: ["SOP", "MAT", "POP"].includes(node.family.toUpperCase())
					? 300
					: 100,
				role: family,
				ruleId: `builtin.family.${node.family}`,
				source: "family",
			});
		for (const rule of builtin)
			if (matchesStatic(node, rule))
				evidence[i].push({
					priority: 700,
					role: rule.role,
					ruleId: rule.id,
					source: "operator-type",
				});
		for (const rule of custom)
			if (
				!rule.match.nameRegex &&
				!rule.match.pathRegex &&
				matchesStatic(node, rule)
			)
				evidence[i].push({
					priority: 800 + rule.priority,
					role: rule.role,
					ruleId: rule.id,
					source: "rule",
				});
		for (const tag of node.tags) {
			const value = tag.startsWith("role:")
				? tag.slice(5)
				: tag.startsWith("td-role:")
					? tag.slice(8)
					: null;
			const result = roleSchema.safeParse(value);
			if (result.success)
				evidence[i].push({
					priority: 950,
					role: result.data,
					ruleId: `tag.${tag}`,
					source: "tag",
				});
		}
		if (Object.hasOwn(options.overrides, node.path))
			evidence[i].push({
				priority: 1000,
				role: options.overrides[node.path],
				ruleId: "user.override",
				source: "override",
			});
	}
	const edges = dependencyEdges(graph, index);
	let classifications = graph.nodes.map((node, i) =>
		classify(node.path, evidence[i]),
	);
	for (const [a, b] of edges) {
		if (
			graph.nodes[b].family.toUpperCase() === "CHOP" &&
			classifications[a].role === "audio"
		)
			evidence[b].push({
				priority: 450,
				role: "audio",
				ruleId: "graph.audio-consumer",
				source: "graph",
			});
		if (
			graph.nodes[b].family.toUpperCase() === "TOP" &&
			classifications[a].role === "rendering"
		)
			evidence[b].push({
				priority: 450,
				role: "post",
				ruleId: "graph.render-consumer",
				source: "graph",
			});
	}
	classifications = graph.nodes.map((node, i) =>
		classify(node.path, evidence[i]),
	);
	const children = new Map<string, number[]>();
	for (const [i, node] of graph.nodes.entries()) {
		const current = children.get(node.parentPath) ?? [];
		current.push(i);
		children.set(node.parentPath, current);
	}
	const containers = graph.nodes
		.map((node, i) => ({ i, node }))
		.filter(({ node }) => node.family.toUpperCase() === "COMP")
		.sort(
			(a, b) => b.node.path.split("/").length - a.node.path.split("/").length,
		);
	for (const { node, i } of containers) {
		const roles = new Set<Role>(
			(children.get(node.path) ?? [])
				.map((child) => classifications[child].role)
				.filter((role) => role !== "unknown" && role !== "utilities"),
		);
		if (roles.size) {
			const role = roles.size === 1 ? [...roles][0] : "mixed";
			evidence[i].push({
				priority: 500,
				role,
				ruleId: "graph.component-children",
				source: "graph",
			});
			classifications[i] = classify(node.path, evidence[i]);
		}
	}
	for (const path of Object.keys(options.overrides))
		if (!index.has(path)) warnings.push(`Override target not present: ${path}`);
	for (const path of options.pins)
		if (!index.has(path)) warnings.push(`Pin target not present: ${path}`);
	return {
		classifications,
		layout: proposeLayout(graph, classifications, options, edges),
		warnings,
	};
}
