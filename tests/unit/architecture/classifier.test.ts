import { describe, expect, it } from "vitest";
import {
	classifierOptionsSchema,
	classifyNetwork,
	rulePackSchema,
} from "../../../src/architecture/classifier/index.js";
import type {
	GraphNode,
	ProjectGraph,
} from "../../../src/architecture/types.js";

const node = (
	name: string,
	family = "TOP",
	opType = "nullTOP",
	extra: Partial<GraphNode> = {},
): GraphNode => ({
	family,
	fingerprint: name,
	flags: {},
	id: name.length,
	name,
	nodeX: 0,
	nodeY: 0,
	opType,
	ownership: [],
	parentPath: "/project1",
	path: `/project1/${name}`,
	tags: [],
	...extra,
});
const graph = (
	nodes: GraphNode[],
	edges: ProjectGraph["edges"] = [],
): ProjectGraph => ({
	build: "2025",
	complete: true,
	coverage: { remaining: 0, truncated: false, visited: nodes.length },
	dependencyComplete: true,
	edges,
	nodes,
	observedAt: "",
	projectId: "test",
	projectPath: "",
	revision: 1,
	rootPath: "/project1",
	schemaVersion: 1,
	sessionId: "test",
	status: "fresh",
	warnings: [],
});
const edge = (
	source: string,
	target: string,
	extra = {},
): ProjectGraph["edges"][number] => ({
	evidence: "observed",
	id: `${source}-${target}`,
	kind: "wire",
	source: `/project1/${source}`,
	target: `/project1/${target}`,
	...extra,
});

describe("explainable graph classification", () => {
	it("honors overrides before tags, types and misleading name expressions", async () => {
		const input = graph([
			node("audio_output", "CHOP", "audioDeviceInCHOP", {
				tags: ["role:post"],
			}),
		]);
		const options = {
			overrides: { "/project1/audio_output": "geometry" as const },
			rulePack: {
				rules: [
					{
						id: "misleading",
						match: { nameRegex: "output" },
						role: "output" as const,
					},
				],
				version: 1 as const,
			},
		};
		const result = await classifyNetwork(input, options);
		expect(result.classifications[0]).toMatchObject({
			confidence: 1,
			role: "geometry",
		});
		expect(result.classifications[0].conflicts).toContain("post");
		expect(result.classifications[0].evidence.map((e) => e.source)).toContain(
			"override",
		);
		expect(
			(
				await classifyNetwork(
					graph([node("output", "CHOP", "audioDeviceInCHOP")]),
					{ rulePack: options.rulePack },
				)
			).classifications[0].role,
		).toBe("audio");
	});
	it("covers all seven families and retains unknown operator types", async () => {
		const result = await classifyNetwork(
			graph([
				node("a", "CHOP", "audioDeviceInCHOP"),
				node("b", "TOP", "renderTOP"),
				node("c", "SOP", "sphereSOP"),
				node("d", "MAT", "pbrMAT"),
				node("e", "POP", "particlePOP"),
				node("f", "DAT", "tableDAT"),
				node("g", "COMP", "buttonCOMP"),
				node("h", "CUSTOM", "mystery"),
			]),
		);
		expect(result.classifications.map((c) => c.role)).toEqual([
			"audio",
			"rendering",
			"geometry",
			"materials",
			"simulation",
			"utilities",
			"ui",
			"unknown",
		]);
	});
	it("infers mixed containers and graph-driven audio processing", async () => {
		const nodes = [
			node("world", "COMP", "baseCOMP"),
			node("world/audio", "CHOP", "audioDeviceInCHOP", {
				parentPath: "/project1/world",
			}),
			node("world/shape", "SOP", "sphereSOP", {
				parentPath: "/project1/world",
			}),
			node("math", "CHOP", "mathCHOP"),
		];
		const result = await classifyNetwork(
			graph(nodes, [edge("world/audio", "math")]),
		);
		expect(result.classifications[0].role).toBe("mixed");
		expect(result.classifications[3].role).toBe("audio");
	});
	it("does not evaluate source text or change input objects", async () => {
		const input = graph([node("safe", "DAT", "textDAT")]);
		const before = JSON.stringify(input);
		await classifyNetwork(input);
		expect(JSON.stringify(input)).toBe(before);
	});
	it("validates bounds, roles and incomplete selector rules", () => {
		expect(
			classifierOptionsSchema.safeParse({ regexTimeoutMs: 100000 }).success,
		).toBe(false);
		expect(
			rulePackSchema.safeParse({
				rules: [{ id: "bad", match: {}, role: "evil" }],
				version: 1,
			}).success,
		).toBe(false);
		expect(
			rulePackSchema.safeParse({
				rules: [{ id: "bad", match: {}, role: "audio" }],
				version: 1,
			}).success,
		).toBe(false);
	});
});

describe("coordinate proposals", () => {
	it("places dependency chains left to right, keeping feedback nodes together", async () => {
		const result = await classifyNetwork(
			graph(
				[node("a"), node("b"), node("c"), node("d")],
				[edge("a", "b"), edge("b", "c"), edge("c", "b"), edge("c", "d")],
			),
		);
		const [a, b, c, d] = result.layout;
		expect(a.x).toBeLessThan(b.x);
		expect(b.group).toBe(c.group);
		expect(b.x).toBe(c.x);
		expect(d.x).toBeGreaterThan(c.x);
	});
	it("preserves explicit pins, annotation positions and dock ownership", async () => {
		const nodes = [
			node("pin", "TOP", "nullTOP", { nodeX: 33, nodeY: 44 }),
			node("note", "COMP", "annotateCOMP", { nodeX: 22, nodeY: 55 }),
			node("dock", "DAT", "textDAT", {
				nodeX: 8,
				nodeY: 9,
				ownership: ["/project1/material"],
			}),
		];
		const result = await classifyNetwork(graph(nodes), {
			pins: ["/project1/pin"],
		});
		expect(result.layout.map((l) => [l.x, l.y, l.pinned])).toEqual([
			[33, 44, true],
			[22, 55, true],
			[8, 9, true],
		]);
	});
	it("places source material before its consumer without moving between parents", async () => {
		const nodes = [
			node("mat", "MAT", "pbrMAT"),
			node("geo", "COMP", "geometryCOMP", {
				parameterReferences: [
					{
						evidence: "observed",
						mode: "constant",
						name: "material",
						targetPaths: ["/project1/mat"],
					},
				],
			}),
		];
		const { layout } = await classifyNetwork(graph(nodes));
		expect(layout[0].x).toBeLessThan(layout[1].x);
		expect(layout.map((l) => l.path)).toEqual(nodes.map((n) => n.path));
	});
	it("handles a deep nonrecursive dependency chain", async () => {
		const count = 10000;
		const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`));
		const edges = Array.from({ length: count - 1 }, (_, i) =>
			edge(`n${i}`, `n${i + 1}`),
		);
		const result = await classifyNetwork(graph(nodes, edges));
		expect(result.layout).toHaveLength(count);
		expect(result.layout[count - 1].x).toBeGreaterThan(result.layout[0].x);
	}, 10000);
});

describe("classifier evidence boundaries", () => {
	it("resolves equal-priority contradictory tags to mixed with disclosed conflicts", async () => {
		const result = await classifyNetwork(
			graph([
				node("a", "TOP", "nullTOP", {
					tags: ["role:audio", "td-role:geometry", "nonsense"],
				}),
			]),
		);
		expect(result.classifications[0]).toMatchObject({
			confidence: 0.5,
			role: "mixed",
		});
		expect(result.classifications[0].conflicts).toEqual(
			expect.arrayContaining(["audio", "geometry"]),
		);
	});
	it("supports static rulepack families/types/tags and graph postprocessing evidence", async () => {
		const input = graph(
			[
				node("render", "TOP", "renderTOP"),
				node("pass"),
				node("override", "DAT", "tableDAT", { tags: ["notes"] }),
			],
			[edge("render", "pass")],
		);
		const result = await classifyNetwork(input, {
			rulePack: {
				rules: [
					{
						id: "notes",
						match: {
							families: ["DAT"],
							opTypes: ["tableDAT"],
							tags: ["notes"],
						},
						role: "documentation",
					},
				],
				version: 1,
			},
		});
		expect(result.classifications[1].role).toBe("post");
		expect(result.classifications[2].role).toBe("documentation");
	});
	it("discloses incomplete evidence and missing requested targets", async () => {
		const result = await classifyNetwork(
			{ ...graph([node("a")]), complete: false },
			{ overrides: { "/absent": "unknown" }, pins: ["/absent"] },
		);
		expect(result.warnings).toHaveLength(3);
	});
	it("rejects oversized/duplicate graphs and invalid source coordinates", async () => {
		await expect(
			classifyNetwork(graph(Array(50001).fill(node("a")))),
		).rejects.toThrow("50000");
		await expect(
			classifyNetwork(graph([node("a"), node("a")])),
		).rejects.toThrow("Duplicate");
		await expect(
			classifyNetwork(
				graph([node("a", "TOP", "nullTOP", { nodeX: Number.NaN })]),
			),
		).rejects.toThrow("bounds");
	});
	it("classifies nested homogeneous and empty containers without recursion", async () => {
		const input = graph([
			node("outer", "COMP", "baseCOMP"),
			node("outer/inner", "COMP", "baseCOMP", {
				parentPath: "/project1/outer",
			}),
			node("outer/inner/audio", "CHOP", "audioDeviceInCHOP", {
				parentPath: "/project1/outer/inner",
			}),
			node("empty", "COMP", "baseCOMP"),
		]);
		const result = await classifyNetwork(input);
		expect(result.classifications.map((item) => item.role)).toEqual([
			"audio",
			"audio",
			"audio",
			"utilities",
		]);
	});
	it("keeps unresolved edges out of feedback classification and groups actual self-loops", async () => {
		const result = await classifyNetwork(
			graph(
				[node("a"), node("b")],
				[
					edge("a", "a"),
					edge("b", "b", { evidence: "unresolved" }),
					edge("missing", "b"),
				],
			),
		);
		expect(result.layout[0].group).toMatch(/^feedback:/);
		expect(result.layout[1].group).not.toMatch(/^feedback:/);
	});
	it("keeps source DAT/MAT dependencies and same-parent coordinate islands", async () => {
		const result = await classifyNetwork(
			graph(
				[
					node("src", "DAT", "textDAT", { ownership: ["source-code"] }),
					node("mat", "MAT", "glslMAT"),
					node("other", "TOP", "nullTOP", { parentPath: "/different" }),
				],
				[edge("src", "mat", { kind: "parameter" }), edge("mat", "other")],
			),
		);
		expect(result.layout[0].pinned).toBe(false);
		expect(result.layout[0].x).toBeLessThan(result.layout[1].x);
		expect(result.layout[2].x).toBe(0);
	});
	it("retains strongly typed families when a misleading filename rule matches", async () => {
		const result = await classifyNetwork(
			graph([node("audio", "MAT", "customMAT")]),
			{
				rulePack: {
					rules: [
						{ id: "name", match: { pathRegex: "audio$" }, role: "audio" },
					],
					version: 1,
				},
			},
		);
		expect(result.classifications[0].role).toBe("materials");
	});
});

describe("layout hierarchy and pinned islands", () => {
	it("retains cross-parent feedback identity without reparenting", async () => {
		const input = graph(
			[node("a"), node("b", "TOP", "nullTOP", { parentPath: "/another" })],
			[edge("a", "b"), edge("b", "a")],
		);
		const result = await classifyNetwork(input);
		expect(result.layout[0].group).toBe(result.layout[1].group);
		expect(result.layout[0].group).toMatch(/^feedback:/);
	});
	it("preserves mixed user pins and reserves annotation bounding boxes", async () => {
		const result = await classifyNetwork(
			graph([
				node("note", "COMP", "annotateCOMP", { nodeHeight: 400, nodeY: -200 }),
				node("moving", "TOP", "nullTOP", { nodeHeight: 100, nodeWidth: 200 }),
				node("docked", "DAT", "textDAT", {
					flags: { docked: true },
					nodeY: -50,
				}),
				node("tag", "TOP", "nullTOP", { tags: ["layout:pin"] }),
			]),
		);
		expect(result.layout[1].y + 100).toBeLessThan(-200);
		expect(result.layout[2].pinned).toBe(true);
		expect(result.layout[3].pinned).toBe(true);
	});
});

describe("reference expansion bounds", () => {
	it("rejects excessive unresolved references before visiting their targets", async () => {
		const input = graph([
			node("a", "TOP", "nullTOP", {
				parameterReferences: [
					{
						evidence: "unresolved",
						mode: "constant",
						name: "target",
						targetPaths: Array(500001).fill("/missing"),
					},
				],
			}),
		]);
		await expect(classifyNetwork(input)).rejects.toThrow("reference budget");
	});
	it("reports deterministic schema decisions for every supported role", async () => {
		const { roles } = await import(
			"../../../src/architecture/classifier/index.js"
		);
		const nodes = roles.map((role) =>
			node(role, "TOP", "nullTOP", { tags: [`role:${role}`] }),
		);
		const result = await classifyNetwork(graph(nodes));
		expect(result.classifications.map((item) => item.role)).toEqual([...roles]);
		expect(
			result.classifications.every((item) => item.confidence === 0.98),
		).toBe(true);
	});
});
