import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ToolMetadata } from "../../src/features/tools/metadata/touchDesignerToolMetadata.js";
import {
	formatClassDetails,
	formatClassList,
} from "../../src/features/tools/presenter/classListFormatter.js";
import { formatModuleHelp } from "../../src/features/tools/presenter/moduleHelpFormatter.js";
import { formatNodeDetails } from "../../src/features/tools/presenter/nodeDetailsFormatter.js";
import { formatNodeErrors } from "../../src/features/tools/presenter/nodeErrorsFormatter.js";
import {
	formatCreateNodeResult,
	formatDeleteNodeResult,
	formatExecNodeMethodResult,
	formatTdInfo,
	formatUpdateNodeResult,
} from "../../src/features/tools/presenter/operationFormatter.js";
import { presentStructuredData } from "../../src/features/tools/presenter/presenter.js";
import { formatToolMetadata } from "../../src/features/tools/presenter/toolMetadataFormatter.js";

const node = {
	id: 8,
	name: "OUT",
	opType: "nullTOP",
	path: "/project1/OUT",
	properties: { height: 720, width: 1280 },
};
const classDetails = {
	description: "Texture operators",
	methods: [
		{
			description: "Cook once\nLong explanation",
			name: "cook",
			signature: "cook(force=False)",
		},
		{ name: "reset" },
	],
	name: "TOP",
	properties: [
		{ name: "width", type: "int", value: null },
		{ name: "height", type: "" },
	],
	type: "class" as const,
};
const classes = {
	classes: [
		{ description: "Texture", name: "TOP", type: "class" as const },
		{ name: "CHOP", type: "class" as const },
	],
	modules: ["tdu"],
};
const metadata: ToolMetadata = {
	category: "system",
	description: "Inspect the bridge",
	example: "  await getTdInfo();  ",
	functionName: "getTdInfo",
	modulePath: "./servers/td/getTdInfo.ts",
	notes: "Local only",
	parameters: [
		{ description: "Root path", name: "path", required: true, type: "string" },
		{ name: "limit", required: false, type: "number" },
	],
	returns: "Info",
	tool: "get_td_info",
};
const otherMetadata: ToolMetadata = {
	...metadata,
	functionName: "getTdNodes",
	modulePath: "./servers/td/getTdNodes.ts",
	notes: undefined,
	parameters: [],
	tool: "get_td_nodes",
};
const errors = {
	errorCount: 2,
	errors: [
		{
			message: "Shader compile failed",
			nodeName: "a",
			nodePath: "/project1/a",
			opType: "glslTOP",
		},
		{
			message: "Missing input",
			nodeName: "b",
			nodePath: "/project1/b",
			opType: "nullTOP",
		},
	],
	hasErrors: true,
	nodeName: "project1",
	nodePath: "/project1",
	opType: "baseCOMP",
};

describe("node parameter presentation", () => {
	it("distinguishes missing data from a node with no properties", () => {
		expect(formatNodeDetails(undefined)).toBe("No node details available.");
		expect(formatNodeDetails({ ...node, properties: {} })).toContain(
			"No properties found.",
		);
	});
	it("limits names and values while preserving total and omitted counts", () => {
		const minimal = JSON.parse(
			formatNodeDetails(node, {
				detailLevel: "minimal",
				limit: 1,
				responseFormat: "json",
			}),
		);
		expect(minimal).toMatchObject({
			displayed: 1,
			omittedCount: 1,
			properties: [{ name: "height", value: "" }],
			total: 2,
			truncated: true,
		});
		const summary = formatNodeDetails(node, { limit: 1 });
		expect(summary).toContain("720");
		expect(summary).toContain("1 more properties omitted");
		expect(summary).not.toContain("1280");
	});
	it("renders nulls, long text, collections and primitives with bounded previews", () => {
		const properties = {
			absent: undefined,
			bool: false,
			empty: [],
			large: [1, 2, 3, 4],
			long: "x".repeat(80),
			nil: null,
			number: 3,
			object: { a: 1 },
			short: "ok",
			small: [1, 2],
			symbol: Symbol("status"),
		};
		const output = JSON.parse(
			formatNodeDetails({ ...node, properties }, { responseFormat: "json" }),
		);
		expect(
			Object.fromEntries(
				output.properties.map((p: { name: string; value: string }) => [
					p.name,
					p.value,
				]),
			),
		).toEqual({
			absent: "(none)",
			bool: "false",
			empty: "[]",
			large: "[1, 2, 3, ... +1]",
			long: `"${"x".repeat(50)}..."`,
			nil: "(none)",
			number: "3",
			object: "{1 keys}",
			short: '"ok"',
			small: "[1, 2]",
			symbol: "Symbol(status)",
		});
	});
	it("keeps full payloads in detailed JSON and YAML", () => {
		expect(
			JSON.parse(
				formatNodeDetails(node, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual(node);
		expect(
			parseYaml(formatNodeDetails(node, { detailLevel: "detailed" })),
		).toEqual(node);
	});
});

describe("Python class documentation", () => {
	it("returns clear empty responses", () => {
		expect(formatClassList(undefined)).toContain("No classes");
		expect(formatClassList({})).toContain("No classes");
		expect(formatClassDetails(undefined)).toContain("No class details");
	});
	it("presents class/module counts and preserves detailed data", () => {
		for (const detailLevel of ["minimal", "summary"] as const) {
			const output = formatClassList(classes, { detailLevel, limit: 1 });
			expect(output).toContain("TouchDesigner Classes (2)");
			expect(output).toContain("Modules (1)");
			expect(output).toContain("tdu");
		}
		expect(formatClassList({ modules: ["tdu"] })).toContain("tdu");
		expect(
			formatClassList({ classes: classes.classes }, { detailLevel: "minimal" }),
		).toContain("TOP");
		expect(
			JSON.parse(
				formatClassList(classes, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual(classes);
	});
	it("minimal class output exposes member totals without member details", () => {
		const data = JSON.parse(
			formatClassDetails(classDetails, {
				detailLevel: "minimal",
				responseFormat: "json",
			}),
		);
		expect(data).toMatchObject({
			methods: [],
			methodsTotal: 2,
			properties: [],
			propertiesTotal: 2,
		});
	});
	it("summarizes signatures and the first documentation line, with explicit limits", () => {
		const limited = formatClassDetails(classDetails, { limit: 1 });
		expect(limited).toContain("cook(force&#x3D;False)");
		expect(limited).toContain("Cook once");
		expect(limited).not.toContain("Long explanation");
		expect(limited).toContain("Additional members omitted");
		expect(limited).not.toContain("reset()");
		const full = formatClassDetails(classDetails);
		expect(full).toContain("reset()");
		expect(full).toContain("height");
		expect(full).not.toContain("omitted");
	});
	it("handles empty classes and detailed machine-readable documentation", () => {
		expect(
			formatClassDetails({
				methods: [],
				name: "Empty",
				properties: [],
				type: "class",
			}),
		).toContain("Methods (0 / 0)");
		expect(
			JSON.parse(
				formatClassDetails(classDetails, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual(classDetails);
		expect(
			parseYaml(formatClassDetails(classDetails, { detailLevel: "detailed" })),
		).toEqual(classDetails);
	});
});

describe("tool metadata manifests", () => {
	it("reports unmatched filters and zero tools", () => {
		expect(formatToolMetadata([])).toContain("No tools matched");
		expect(
			JSON.parse(
				formatToolMetadata([], { filter: "unknown", responseFormat: "json" }),
			),
		).toMatchObject({ filter: "unknown", totalTools: 0 });
	});
	it("sorts without modifying input and builds a shared directory tree", () => {
		const input = [otherMetadata, metadata];
		const output = formatToolMetadata(input, { detailLevel: "minimal" });
		expect(output).toContain("servers/td/");
		expect(output).toContain("├── getTdInfo.ts");
		expect(output).toContain("└── getTdNodes.ts");
		expect(input).toEqual([otherMetadata, metadata]);
		expect(
			formatToolMetadata(
				[metadata, { ...otherMetadata, modulePath: "other/nodes.ts" }],
				{ detailLevel: "minimal" },
			),
		).toContain("Filesystem blueprint:\n./");
	});
	it("distinguishes required, optional and absent parameters", () => {
		const summary = formatToolMetadata([metadata, otherMetadata]);
		expect(summary).toContain("path (string) — Root path");
		expect(summary).toContain("limit? (number)");
		expect(summary).toContain("(no parameters)");
		expect(summary).toContain("Returns: Info");
	});
	it("preserves structured metadata and renders detailed payload fences", () => {
		const data = JSON.parse(
			formatToolMetadata([otherMetadata, metadata], {
				detailLevel: "detailed",
				responseFormat: "json",
			}),
		);
		expect(
			data.map((entry: { functionName: string }) => entry.functionName),
		).toEqual(["getTdInfo", "getTdNodes"]);
		expect(data[0]).toMatchObject({
			notes: "Local only",
			parameters: metadata.parameters,
		});
		const markdown = formatToolMetadata([metadata, otherMetadata], {
			detailLevel: "detailed",
			responseFormat: "markdown",
		});
		expect(markdown).toContain("```yaml");
		expect(markdown).toContain("Local only");
	});
});

describe("operator errors and operation receipts", () => {
	it("distinguishes unavailable reports, clean nodes and actual errors", () => {
		expect(formatNodeErrors(undefined)).toContain("No node error information");
		for (const override of [
			{ errors: [] },
			{ hasErrors: false },
			{ errorCount: 0 },
		])
			expect(formatNodeErrors({ ...errors, ...override })).toContain(
				"no reported errors",
			);
		const minimal = formatNodeErrors(errors, {
			detailLevel: "minimal",
			limit: 1,
		});
		expect(minimal).toContain("Shader compile failed");
		expect(minimal).not.toContain("Missing input");
		expect(minimal).toContain("1 more errors omitted");
		expect(formatNodeErrors(errors)).toContain(
			"(glslTOP): Shader compile failed",
		);
		expect(
			JSON.parse(
				formatNodeErrors(errors, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual(errors);
		expect(
			parseYaml(formatNodeErrors(errors, { detailLevel: "detailed" })),
		).toEqual(errors);
	});
	it("shows runtime and API versions independently, tolerating missing OS info", () => {
		const info = {
			mcpApiVersion: "1.5.0",
			osName: "macOS",
			osVersion: "15",
			version: "2025.33230",
		};
		expect(
			JSON.parse(formatTdInfo(info, { responseFormat: "json" })),
		).toMatchObject({
			"API Server Version": "1.5.0",
			"Operating System": "macOS 15",
		});
		expect(formatTdInfo({ ...info, osVersion: undefined })).toContain("macOS");
		expect(formatTdInfo({ ...info, osName: undefined })).toContain("Unknown");
		expect(formatTdInfo(undefined)).toContain("not available");
	});
	it("handles incomplete create/delete metadata without pretending success", () => {
		expect(formatCreateNodeResult(undefined)).toContain("no metadata returned");
		expect(formatCreateNodeResult({ result: node })).toContain(
			"Properties detected: 2",
		);
		expect(
			formatCreateNodeResult({ result: node }, { detailLevel: "minimal" }),
		).not.toContain("Properties detected");
		expect(formatCreateNodeResult({ result: {} } as never)).toContain(
			"(path unknown)",
		);
		expect(formatDeleteNodeResult({ deleted: true, node })).toContain(
			"Deleted 'OUT'",
		);
		expect(formatDeleteNodeResult(undefined)).toContain(
			"Deletion status unknown",
		);
		expect(
			JSON.parse(
				formatDeleteNodeResult(
					{ deleted: true, node },
					{ detailLevel: "detailed", responseFormat: "json" },
				),
			),
		).toMatchObject({ deleted: true });
	});
	it("reports parameter update failures and preserves detailed results", () => {
		const update = {
			failed: ["ty"],
			message: "Partial update",
			updated: ["tx"],
		};
		expect(formatUpdateNodeResult(update)).toContain("1 failed");
		expect(
			formatUpdateNodeResult(update, { detailLevel: "minimal" }),
		).not.toContain("failed");
		expect(formatUpdateNodeResult(undefined)).toContain(
			"Updated 0 parameter(s)",
		);
		expect(
			formatUpdateNodeResult({ failed: [], updated: ["tx"] }),
		).not.toContain("failed");
		expect(
			JSON.parse(
				formatUpdateNodeResult(update, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual(update);
	});
	it.each([
		[undefined, "(no result)"],
		[null, "null"],
		[true, "true"],
		[3, "3"],
		["ok", "ok"],
		[[1, 2], "Array[2]"],
		[{ a: 1 }, "Object{1 keys}"],
		[Symbol("ok"), "Symbol(ok)"],
		["x".repeat(150), `${"x".repeat(117)}...`],
	])("summarizes method return %s", (result, preview) => {
		expect(
			formatExecNodeMethodResult(
				{ result },
				{ method: "cook", nodePath: node.path },
			),
		).toContain(`Result: ${preview}`);
	});
	it("includes positional/keyword arguments and full detailed method data", () => {
		const context = {
			args: ["image.png", 4],
			kwargs: { quality: 80 },
			method: "save",
			nodePath: node.path,
		};
		expect(formatExecNodeMethodResult({ result: true }, context)).toContain(
			"save('image.png', 4, quality=80)",
		);
		expect(
			JSON.parse(
				formatExecNodeMethodResult({ result: true }, context, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual({ ...context, result: true });
	});
});

const help =
	"class TOP(OP)\n|  Texture operator\n|  Produces pixels\n\n|  Method resolution order:\n|      TOP\n|      OP\n\nMethods:\n|  Methods defined here:\n|   cook(force=False)\n|   cook(force=False)\n|   reset()\n|  Data descriptors:\n|   width\n|   width\n|   height\n|  Other section:\nnot a member\n";
describe("module help and structured presentation", () => {
	it("extracts unique methods, properties, class description and MRO", () => {
		const result = JSON.parse(
			formatModuleHelp(
				{ helpText: help, moduleName: "td.TOP" },
				{ responseFormat: "json" },
			),
		);
		expect(result.members).toEqual({
			methods: ["cook", "reset"],
			properties: ["width", "height"],
		});
		expect(result.classInfo).toMatchObject({
			definition: "TOP(OP)",
			description: "Texture operator Produces pixels",
			methodResolutionOrder: ["TOP", "OP"],
		});
		expect(
			formatModuleHelp(
				{ helpText: help, moduleName: "td.TOP" },
				{ detailLevel: "minimal" },
			),
		).toContain("Methods (2): cook, reset");
	});
	it("handles absent/plain documentation and preserves detailed help", () => {
		expect(formatModuleHelp(undefined)).toContain("No help information");
		expect(formatModuleHelp({ helpText: "", moduleName: "tdu" })).toContain(
			"No help information",
		);
		expect(
			formatModuleHelp({ helpText: " Simple utility. ", moduleName: "tdu" }),
		).toContain("Simple utility.");
		const data = { helpText: help, moduleName: "tdu" };
		expect(
			JSON.parse(
				formatModuleHelp(data, {
					detailLevel: "detailed",
					responseFormat: "json",
				}),
			),
		).toEqual({ ...data, length: help.length });
		expect(
			formatModuleHelp(data, {
				detailLevel: "detailed",
				responseFormat: "markdown",
			}),
		).toContain("Help for tdu");
	});
	it("bounds long previews with and without natural paragraph boundaries", () => {
		for (const text of [
			"x".repeat(700),
			`${"x".repeat(400)}\n${"y".repeat(300)}`,
		]) {
			const result = JSON.parse(
				formatModuleHelp(
					{ helpText: text, moduleName: "tdu" },
					{ responseFormat: "json" },
				),
			);
			expect(result.helpPreview.length).toBeLessThanOrEqual(503);
			expect(result.fullLength).toBe(text.length);
			expect(result.helpPreview).toMatch(/\.\.\.$/);
		}
	});
	it("supports property/attribute headings and caps repeated section summaries", () => {
		const text = `|  Attributes:\n|   a\n|  Properties:\n|   b\n${Array.from({ length: 12 }, (_, i) => `SECTION ${String.fromCharCode(65 + i)}`).join("\n")}`;
		const result = JSON.parse(
			formatModuleHelp(
				{ helpText: text, moduleName: "td" },
				{ responseFormat: "json" },
			),
		);
		expect(result.members.properties).toEqual(["a", "b"]);
		expect(result.sections.length).toBe(10);
	});
	it("presents structured JSON/YAML and uses text when no payload exists", () => {
		expect(
			JSON.parse(
				presentStructuredData(
					{
						context: { connected: true },
						detailLevel: "minimal",
						text: "Ready",
					},
					"json",
				),
			),
		).toEqual({ connected: true, mode: "minimal", text: "Ready" });
		expect(
			parseYaml(
				presentStructuredData({ structured: { count: 2 }, text: "unused" }),
			),
		).toEqual({ count: 2 });
		expect(presentStructuredData({ text: "" }, "markdown")).toContain(
			"Response",
		);
		expect(
			presentStructuredData(
				{ detailLevel: "detailed", structured: "raw value", text: "" },
				"markdown",
			),
		).toContain("raw value");
		expect(
			presentStructuredData(
				{
					context: { payloadFormat: "json", title: "Custom" },
					detailLevel: "detailed",
					structured: { count: 2 },
					text: "",
				},
				"markdown",
			),
		).toContain('"count": 2');
		expect(
			presentStructuredData(
				{ template: "not-a-real-template", text: "fallback" },
				"markdown",
			),
		).toContain("fallback");
	});
});
