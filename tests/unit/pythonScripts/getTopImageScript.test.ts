import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildGetTopImageScript } from "../../../src/features/tools/pythonScripts/getTopImageScript.js";

describe("buildGetTopImageScript", () => {
	it("embeds the node path as a Python string literal", () => {
		const script = buildGetTopImageScript({ nodePath: "/project1/text1" });
		expect(script).toContain('node_path = "/project1/text1"');
	});

	it("escapes quotes and backslashes safely via JSON string encoding", () => {
		const script = buildGetTopImageScript({
			nodePath: '/project1/weird"name\\here',
		});
		expect(script).toContain('node_path = "/project1/weird\\"name\\\\here"');
	});

	it("sets max_size to None when maxSize is omitted", () => {
		const script = buildGetTopImageScript({ nodePath: "/project1/top1" });
		expect(script).toContain("max_size = None");
	});

	it("sets max_size to the numeric literal when provided", () => {
		const script = buildGetTopImageScript({
			maxSize: 512,
			nodePath: "/project1/top1",
		});
		expect(script).toContain("max_size = 512");
	});

	it("includes TOP validation, downscale, and cleanup logic", () => {
		const script = buildGetTopImageScript({
			maxSize: 256,
			nodePath: "/project1/top1",
		});
		expect(script).toContain("node.family != 'TOP'");
		// `td.resolutionTOP` (not the bare `resolutionTOP` global) so this also
		// works against TD-side packages predating the #185 namespace injection.
		expect(script).toContain("import td");
		expect(script).toContain("td.resolutionTOP");
		expect(script).toContain("saveByteArray('.jpg')");
		expect(script).toContain("base64.b64encode");
		expect(script).toContain("tmp_top.destroy()");
		// Cleanup must be unconditional so the project is never left dirty.
		expect(script).toContain("finally:");
	});

	it("assigns the base64 string to `result`, the variable the TD executor extracts", () => {
		const script = buildGetTopImageScript({ nodePath: "/project1/top1" });
		expect(script).toMatch(/result = base64\.b64encode/);
	});
});

// Execute the generated Python, including its finally block, against a small TD
// fake. These tests guard ownership rather than a particular naming algorithm.
function captureWithExistingNodes(failure: string | null = null) {
	const script = buildGetTopImageScript({
		maxSize: 256,
		nodePath: "/project1/top1",
	});
	const harness = `import json, sys, types
request = json.load(sys.stdin)
children = {}
destroyed = []
created = []
class Node:
    family = "TOP"
    width = 1024
    height = 512
    def __init__(self, name):
        self.name = name
        self.marker = "untouched"
        self.par = types.SimpleNamespace()
        self.inputConnectors = [types.SimpleNamespace(connect=lambda node: None)]
    def parent(self):
        return parent
    def destroy(self):
        destroyed.append(self.name)
        if children.get(self.name) is self:
            del children[self.name]
    def saveByteArray(self, format):
        if request["failure"] == "capture":
            raise RuntimeError("Capture failed")
        if request["failure"] == "empty":
            return b""
        return b"image bytes"
class Parent:
    def op(self, name):
        return children.get(name)
    def create(self, kind, name):
        if request["failure"] == "creation":
            raise RuntimeError("Creation failed")
        if name in children:
            raise RuntimeError("Name collision")
        node = Node(name)
        children[name] = node
        created.append(node)
        return node
parent = Parent()
source = Node("top1")
existing = [Node("__mcp_tmp_res__top1"), Node("__mcp_tmp_res__top1_1")]
for node in existing:
    children[node.name] = node
sys.modules["td"] = types.SimpleNamespace(resolutionTOP=object())
namespace = {"op": lambda path: source}
error = None
try:
    exec(request["script"], namespace, namespace)
except Exception as exception:
    error = str(exception)
print(json.dumps({
    "existingPreserved": all(children.get(node.name) is node and node.marker == "untouched" for node in existing),
    "destroyed": destroyed,
    "created": [node.name for node in created],
    "remaining": sorted(children),
    "size": [[getattr(node.par, "resolutionw", None), getattr(node.par, "resolutionh", None)] for node in created],
    "result": namespace.get("result"),
    "error": error,
}))
`;
	return JSON.parse(
		execFileSync("python3", ["-c", harness], {
			encoding: "utf8",
			input: JSON.stringify({ failure, script }),
			timeout: 5000,
		}),
	);
}

describe("TOP capture temporary operator ownership", () => {
	it("preserves colliding operators and destroys only its own downscale TOP", () => {
		const result = captureWithExistingNodes();
		expect(result.existingPreserved).toBe(true);
		expect(result.created).toHaveLength(1);
		expect(result.destroyed).toEqual(result.created);
		expect(result.remaining).toEqual([
			"__mcp_tmp_res__top1",
			"__mcp_tmp_res__top1_1",
		]);
		expect(result.size).toEqual([[256, 128]]);
		expect(result.result).toBe(Buffer.from("image bytes").toString("base64"));
		expect(result.error).toBeNull();
	});

	it.each([
		"capture",
		"empty",
	])("cleans only the owned temporary TOP when %s capture fails", (failure) => {
		const result = captureWithExistingNodes(failure);
		expect(result.existingPreserved).toBe(true);
		expect(result.created).toHaveLength(1);
		expect(result.destroyed).toEqual(result.created);
		expect(result.error).toBeTruthy();
		expect(result.result).toBeNull();
	});

	it("does not delete existing operators when creation fails", () => {
		const result = captureWithExistingNodes("creation");
		expect(result.existingPreserved).toBe(true);
		expect(result.created).toEqual([]);
		expect(result.destroyed).toEqual([]);
		expect(result.error).toBe("Creation failed");
	});
});
