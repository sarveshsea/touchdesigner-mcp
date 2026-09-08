import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "../../src/core/constants.js";
import { TOOL_DEFINITIONS } from "../../src/features/tools/toolDefinitions.js";
import type { TouchDesignerClient } from "../../src/tdClient/touchDesignerClient.js";

const callArchitecture = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../src/architecture/service/client.js", () => ({
	callArchitecture,
}));
const names = [
	"get_td_operator_catalog",
	"map_td_project",
	"classify_td_network",
	"plan_td_refactor",
	"stage_td_refactor",
	"get_td_memory",
	"record_td_memory",
];
function tool(name: string) {
	const t = TOOL_DEFINITIONS.find((t) => t.name === name);
	if (!t) throw new Error(`Missing ${name}`);
	return t;
}
beforeEach(() => callArchitecture.mockClear());
describe("architecture public tools", () => {
	it("adds exactly seven tools while preserving the prior sixteen", () => {
		expect(Object.values(TOOL_NAMES)).toHaveLength(23);
		for (const name of names)
			expect(TOOL_DEFINITIONS.filter((t) => t.name === name)).toHaveLength(1);
	});
	it("rejects docRoot and unknown input properties", () => {
		expect(
			tool("get_td_operator_catalog").schema.safeParse({ docRoot: "/private" })
				.success,
		).toBe(false);
		for (const name of names)
			expect(tool(name).schema.safeParse({ unexpected: true }).success).toBe(
				false,
			);
	});
	it("uses bounded map defaults and rejects invalid actions", () => {
		const schema = tool("map_td_project").schema;
		expect(schema.parse({})).toMatchObject({
			action: "refresh",
			dependencyAnalysis: false,
			rootPath: "/project1",
		});
		for (const p of [
			{ action: "destroy" },
			{ maxNodes: 50001 },
			{ pageSize: 501 },
			{ rootPath: "relative" },
		])
			expect(schema.safeParse(p).success).toBe(false);
	});
	it("validates classifier options and refactor selection using shared contracts", () => {
		expect(
			tool("classify_td_network").schema.safeParse({
				classifierOptions: { columnGap: 1 },
			}).success,
		).toBe(false);
		expect(
			tool("plan_td_refactor").schema.safeParse({
				name: "GROUP",
				paths: ["/project1/a"],
			}).success,
		).toBe(true);
		expect(
			tool("plan_td_refactor").schema.safeParse({
				name: "../GROUP",
				paths: ["/project1/a"],
			}).success,
		).toBe(false);
	});
	it("requires the correct staging identifier for each action", () => {
		const schema = tool("stage_td_refactor").schema;
		expect(
			schema.safeParse({
				action: "apply",
				planId: `refactor_${"a".repeat(32)}`,
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				action: "status",
				transactionId: `refactor_${"a".repeat(32)}`,
			}).success,
		).toBe(true);
		for (const p of [
			{ action: "apply" },
			{ action: "status" },
			{ action: "status", planId: `refactor_${"a".repeat(32)}` },
		])
			expect(schema.safeParse(p).success).toBe(false);
	});
	it("wraps the strict memory action schema and prohibits implicit personal promotion", () => {
		const schema = tool("record_td_memory").schema;
		const record = {
			action: "record",
			kind: "decision",
			projectId: "a".repeat(32),
			text: "Keep bounded particles",
			title: "Render choice",
		};
		expect(schema.safeParse({ record }).success).toBe(true);
		expect(
			schema.safeParse({ record: { ...record, scope: "personal" } }).success,
		).toBe(false);
		expect(
			tool("get_td_memory").schema.safeParse({
				limit: 51,
				projectId: "a".repeat(32),
			}).success,
		).toBe(false);
	});
	it("dispatches service method names and parsed defaults, not Python execution", async () => {
		const t = tool("map_td_project");
		const result = await t.run({
			logger: { sendLog() {} },
			params: {},
			tdClient: {} as TouchDesignerClient,
		});
		expect(JSON.parse(result as string)).toEqual({ ok: true });
		expect(callArchitecture).toHaveBeenCalledWith(
			"map_td_project",
			expect.objectContaining({ action: "refresh", rootPath: "/project1" }),
		);
	});
});

describe("architecture service dispatch contract", () => {
	const cases: [string, Record<string, unknown>][] = [
		["get_td_operator_catalog", { family: "POP", limit: 10 }],
		["map_td_project", { action: "status" }],
		[
			"classify_td_network",
			{ classifierOptions: { pins: ["/project1/OUT"] }, rootPath: "/project1" },
		],
		["plan_td_refactor", { name: "SOURCE", paths: ["/project1/noise1"] }],
		[
			"stage_td_refactor",
			{ action: "status", transactionId: `refactor_${"a".repeat(32)}` },
		],
		["get_td_memory", { projectId: "a".repeat(32) }],
		[
			"record_td_memory",
			{
				record: {
					action: "retire",
					id: "b".repeat(32),
					projectId: "a".repeat(32),
				},
			},
		],
	];
	for (const [name, params] of cases)
		it(`routes ${name} without changing its method`, async () => {
			const t = tool(name);
			const result = await t.run({
				logger: { sendLog() {} },
				params,
				tdClient: {} as TouchDesignerClient,
			});
			expect(JSON.parse(result as string)).toEqual({ ok: true });
			expect(callArchitecture).toHaveBeenCalledWith(
				name,
				t.schema.parse(params),
			);
		});
	it("validates raw run inputs before a request and propagates service failures", async () => {
		const t = tool("get_td_operator_catalog");
		const context = {
			logger: { sendLog() {} },
			tdClient: {} as TouchDesignerClient,
		};
		await expect(
			t.run({ ...context, params: { docRoot: "/private" } }),
		).rejects.toThrow();
		expect(callArchitecture).not.toHaveBeenCalled();
		callArchitecture.mockRejectedValueOnce(new Error("Service unavailable"));
		await expect(t.run({ ...context, params: {} })).rejects.toThrow(
			"Service unavailable",
		);
	});
});

describe("bounded map and classification response controls", () => {
	for (const name of ["map_td_project", "classify_td_network"]) {
		it(`${name} defaults to a 200-item page and accepts summary-only requests`, () => {
			const schema = tool(name).schema;
			expect(schema.parse({})).toMatchObject({
				limit: 200,
				offset: 0,
				summaryOnly: false,
			});
			expect(
				schema.parse({ limit: 500, offset: 50000, summaryOnly: true }),
			).toMatchObject({ limit: 500, offset: 50000, summaryOnly: true });
			for (const params of [
				{ limit: 0 },
				{ limit: 501 },
				{ offset: -1 },
				{ offset: 50001 },
				{ offset: 0.5 },
				{ summaryOnly: "yes" },
			])
				expect(schema.safeParse(params).success).toBe(false);
		});
		it(`${name} sends page bounds and summary selection to the service`, async () => {
			const t = tool(name);
			await t.run({
				logger: { sendLog() {} },
				params: { limit: 50, offset: 400, summaryOnly: true },
				tdClient: {} as TouchDesignerClient,
			});
			expect(callArchitecture).toHaveBeenCalledWith(
				name,
				expect.objectContaining({ limit: 50, offset: 400, summaryOnly: true }),
			);
		});
	}
	it("bounds map status responses with the same public page contract", () => {
		expect(
			tool("map_td_project").schema.parse({ action: "status" }),
		).toMatchObject({
			action: "status",
			limit: 200,
			offset: 0,
			summaryOnly: false,
		});
	});
});

describe("background map refresh contract", () => {
	it("waits by default and permits a bounded one-hour background dependency census", () => {
		const schema = tool("map_td_project").schema;
		expect(schema.parse({})).toMatchObject({
			maxDurationMs: 60000,
			wait: true,
		});
		expect(
			schema.parse({
				action: "refresh",
				dependencyAnalysis: true,
				maxDurationMs: 3600000,
				rootPath: "/",
				wait: false,
			}),
		).toMatchObject({ maxDurationMs: 3600000, wait: false });
		expect(schema.safeParse({ maxDurationMs: 3600001 }).success).toBe(false);
		expect(schema.safeParse({ wait: "false" }).success).toBe(false);
	});
	it("forwards background scheduling without creating an additional public tool", async () => {
		const t = tool("map_td_project");
		await t.run({
			logger: { sendLog() {} },
			params: {
				action: "refresh",
				dependencyAnalysis: true,
				maxDurationMs: 3600000,
				rootPath: "/",
				wait: false,
			},
			tdClient: {} as TouchDesignerClient,
		});
		expect(callArchitecture).toHaveBeenCalledWith(
			"map_td_project",
			expect.objectContaining({ maxDurationMs: 3600000, wait: false }),
		);
		expect(Object.values(TOOL_NAMES)).toHaveLength(23);
	});
});
