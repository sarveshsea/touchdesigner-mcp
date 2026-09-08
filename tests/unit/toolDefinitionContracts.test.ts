import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/features/tools/toolDefinitions.js";
import type { TouchDesignerClient } from "../../src/tdClient/touchDesignerClient.js";

// Presenter internals have their own suites. Here their boundary is observable:
// formatting flags must never leak into bridge mutations or query arguments.
const presenters = vi.hoisted(() =>
	Object.fromEntries(
		[
			"formatTdInfo",
			"formatScriptResult",
			"formatNodeList",
			"formatNodeDetails",
			"formatNodeErrors",
			"formatCreateNodeResult",
			"formatUpdateNodeResult",
			"formatDeleteNodeResult",
			"formatExecNodeMethodResult",
			"formatClassList",
			"formatClassDetails",
			"formatModuleHelp",
		].map((name) => [name, vi.fn(() => `formatted:${name}`)]),
	),
);
vi.mock("../../src/features/tools/presenter/index.js", () => presenters);

interface DispatchCase {
	name: string;
	method: string;
	presenter: string;
	params: Record<string, unknown>;
	args: unknown[];
	defaultLimit?: number;
}

const cases: DispatchCase[] = [
	{
		args: [],
		method: "getTdInfo",
		name: "get_td_info",
		params: {},
		presenter: "formatTdInfo",
	},
	{
		args: [{ script: "result = 7" }],
		method: "execPythonScript",
		name: "execute_python_script",
		params: { script: "result = 7" },
		presenter: "formatScriptResult",
	},
	{
		args: [
			{ includeProperties: false, parentPath: "/project1", pattern: "null*" },
		],
		method: "getNodes",
		name: "get_td_nodes",
		params: {
			includeProperties: false,
			parentPath: "/project1",
			pattern: "null*",
		},
		presenter: "formatNodeList",
	},
	{
		args: [{ nodePath: "/project1/title" }],
		method: "getNodeDetail",
		name: "get_td_node_parameters",
		params: { nodePath: "/project1/title" },
		presenter: "formatNodeDetails",
	},
	{
		args: [{ nodePath: "/project1/title" }],
		method: "getNodeErrors",
		name: "get_td_node_errors",
		params: { nodePath: "/project1/title" },
		presenter: "formatNodeErrors",
	},
	{
		args: [{ nodeName: "title", nodeType: "textTOP", parentPath: "/project1" }],
		method: "createNode",
		name: "create_td_node",
		params: { nodeName: "title", nodeType: "textTOP", parentPath: "/project1" },
		presenter: "formatCreateNodeResult",
	},
	{
		args: [{ nodePath: "/project1/title", properties: { text: "Exact text" } }],
		method: "updateNode",
		name: "update_td_node_parameters",
		params: { nodePath: "/project1/title", properties: { text: "Exact text" } },
		presenter: "formatUpdateNodeResult",
	},
	{
		args: [{ nodePath: "/project1/title" }],
		method: "deleteNode",
		name: "delete_td_node",
		params: { nodePath: "/project1/title" },
		presenter: "formatDeleteNodeResult",
	},
	{
		args: [
			{
				args: [true],
				kwargs: { force: true },
				method: "cook",
				nodePath: "/project1/title",
			},
		],
		method: "execNodeMethod",
		name: "exec_node_method",
		params: {
			args: [true],
			kwargs: { force: true },
			method: "cook",
			nodePath: "/project1/title",
		},
		presenter: "formatExecNodeMethodResult",
	},
	{
		args: [],
		defaultLimit: 50,
		method: "getClasses",
		name: "get_td_classes",
		params: {},
		presenter: "formatClassList",
	},
	{
		args: ["textTOP"],
		defaultLimit: 30,
		method: "getClassDetails",
		name: "get_td_class_details",
		params: { className: "textTOP" },
		presenter: "formatClassDetails",
	},
	{
		args: [{ moduleName: "td" }],
		method: "getModuleHelp",
		name: "get_td_module_help",
		params: { moduleName: "td" },
		presenter: "formatModuleHelp",
	},
];

function definition(name: string) {
	const tool = TOOL_DEFINITIONS.find((entry) => entry.name === name);
	if (!tool) throw new Error(`Missing registered tool ${name}`);
	return tool;
}

function context(
	name: string,
	method: string,
	params: Record<string, unknown>,
	response: unknown,
) {
	const dispatch = vi.fn().mockResolvedValue(response);
	return {
		dispatch,
		input: {
			logger: { sendLog: vi.fn() },
			params: definition(name).schema.strict().parse(params),
			tdClient: { [method]: dispatch } as unknown as TouchDesignerClient,
		},
	};
}

beforeEach(() => vi.clearAllMocks());

describe.each(cases)("$name dispatch contract", (testCase) => {
	it.each([
		false,
		true,
	])("dispatches once and keeps formatting client-side (explicit=%s)", async (explicit) => {
		const tool = definition(testCase.name);
		const supportsLimit = "limit" in tool.schema.shape;
		const params = {
			...testCase.params,
			...(explicit
				? {
						detailLevel: "detailed",
						responseFormat: "yaml",
						...(supportsLimit ? { limit: 2 } : {}),
					}
				: {}),
		};
		const response = {
			data: { sentinel: "unmodified bridge result" },
			success: true,
		};
		const { input, dispatch } = context(
			testCase.name,
			testCase.method,
			params,
			response,
		);
		const result = await tool.run(input);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(...testCase.args);
		expect(result).toBe(`formatted:${testCase.presenter}`);
		const presenter = presenters[testCase.presenter];
		expect(presenter).toHaveBeenCalledTimes(1);
		const args = presenter.mock.calls[0] as unknown[];
		expect(args[0]).toBe(
			testCase.name === "execute_python_script" ? response : response.data,
		);
		expect(args.at(-1)).toMatchObject({
			detailLevel: explicit ? "detailed" : "summary",
			responseFormat: explicit ? "yaml" : undefined,
		});
		if (supportsLimit)
			expect(args.at(-1)).toHaveProperty(
				"limit",
				explicit ? 2 : testCase.defaultLimit,
			);
		if (testCase.name === "execute_python_script")
			expect(args[1]).toBe("result = 7");
		if (testCase.name === "exec_node_method")
			expect(args[1]).toEqual(testCase.params);
	});

	it("propagates bridge errors unchanged without formatting a success", async () => {
		const error = new Error(`Bridge rejected ${testCase.name}`);
		const { input, dispatch } = context(
			testCase.name,
			testCase.method,
			testCase.params,
			{ error, success: false },
		);
		await expect(definition(testCase.name).run(input)).rejects.toBe(error);
		expect(dispatch).toHaveBeenCalledTimes(1);
		for (const presenter of Object.values(presenters))
			expect(presenter).not.toHaveBeenCalled();
	});

	it("does not retry a rejected transport request", async () => {
		const error = new Error("Timeout: execution status is unknown");
		const { input, dispatch } = context(
			testCase.name,
			testCase.method,
			testCase.params,
			null,
		);
		dispatch.mockRejectedValue(error);
		await expect(definition(testCase.name).run(input)).rejects.toBe(error);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});

it("node property requests select detailed output unless the operator explicitly chooses otherwise", async () => {
	for (const detailLevel of [undefined, "minimal"]) {
		const { input } = context(
			"get_td_nodes",
			"getNodes",
			{ detailLevel, includeProperties: true, parentPath: "/project1" },
			{ data: { nodes: [] }, success: true },
		);
		await definition("get_td_nodes").run(input);
		expect(presenters.formatNodeList).toHaveBeenLastCalledWith(
			{ nodes: [] },
			expect.objectContaining({ detailLevel: detailLevel ?? "detailed" }),
		);
	}
});

describe.each([
	"get_td_network_snapshot",
	"layout_td_network",
])("%s report boundary", (name) => {
	it.each([
		undefined,
		null,
		7,
		{},
		"x".repeat(4 * 1024 * 1024 + 1),
	])("rejects invalid or oversized raw report %#", async (raw) => {
		const { input, dispatch } = context(
			name,
			"execPythonScript",
			{ parentPath: "/project1" },
			{ data: { result: raw }, success: true },
		);
		await expect(definition(name).run(input)).rejects.toThrow(
			"Invalid or oversized authoring report",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it.each([
		"null",
		"[]",
		"7",
		"true",
		'"text"',
	])("rejects non-object JSON report %s", async (raw) => {
		const { input } = context(
			name,
			"execPythonScript",
			{ parentPath: "/project1" },
			{ data: { result: raw }, success: true },
		);
		await expect(definition(name).run(input)).rejects.toThrow(
			"Expected an authoring report object",
		);
	});

	it.each([
		{ success: true },
		{ data: null, success: true },
	])("rejects malformed bridge envelopes %#", async (response) => {
		const { input } = context(
			name,
			"execPythonScript",
			{ parentPath: "/project1" },
			response,
		);
		await expect(definition(name).run(input)).rejects.toThrow();
	});
});

describe("TOP capture envelope", () => {
	it.each([
		undefined,
		null,
		"",
		123,
		{},
	])("rejects missing/empty/non-string image data %#", async (raw) => {
		const { input, dispatch } = context(
			"get_top_image",
			"execPythonScript",
			{ nodePath: "/project1/image" },
			{ data: { result: raw }, success: true },
		);
		await expect(definition("get_top_image").run(input)).rejects.toThrow(
			"expected a base64 string",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ success: true },
		{ data: null, success: true },
	])("rejects malformed capture envelopes %#", async (response) => {
		const { input } = context(
			"get_top_image",
			"execPythonScript",
			{ nodePath: "/project1/image" },
			response,
		);
		await expect(definition("get_top_image").run(input)).rejects.toThrow();
	});

	it("returns native-resolution image and caption without leaking bridge stdout", async () => {
		const { input, dispatch } = context(
			"get_top_image",
			"execPythonScript",
			{ nodePath: "/project1/image" },
			{ data: { result: "aW1hZ2U=", stdout: "not an image" }, success: true },
		);
		expect(await definition("get_top_image").run(input)).toEqual({
			content: [
				{ data: "aW1hZ2U=", mimeType: "image/jpeg", type: "image" },
				{ text: "Captured TOP image from /project1/image.", type: "text" },
			],
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});
