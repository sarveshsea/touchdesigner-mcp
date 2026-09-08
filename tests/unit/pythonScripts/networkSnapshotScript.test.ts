import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	buildNetworkSnapshotScript,
	networkSnapshotParamsSchema,
} from "../../../src/features/tools/pythonScripts/networkSnapshotScript.js";

function runSnapshot(
	params: Parameters<typeof buildNetworkSnapshotScript>[0],
	fixture: Record<string, unknown> = {},
) {
	const encoded = Buffer.from(JSON.stringify(fixture)).toString("base64");
	const harness = `import json, base64
from types import SimpleNamespace
fixture = json.loads(base64.b64decode("${encoded}"))
class Node:
    count = 0
    def __init__(self, path):
        Node.count += 1
        self.id = Node.count
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self.family = "COMP"
        self.type = "base"
        self.nodeX, self.nodeY = 10, -20
        self.nodeWidth, self.nodeHeight = 150, 100
        self.allowCooking = False
        self.bypass, self.lock, self.viewer = False, True, False
        self.children, self.inputConnectors = [], []
    def __setattr__(self, key, value):
        if getattr(self, "frozen", False):
            raise AssertionError("operator mutation attempted")
        object.__setattr__(self, key, value)
    @property
    def par(self): raise AssertionError("parameter access forbidden")
    @property
    def text(self): raise AssertionError("DAT text access forbidden")
    def cook(self, *a, **kw): raise AssertionError("force cook forbidden")
    def errors(self, recurse=False):
        assert recurse is False
        if fixture.get("diagnosticString"):
            return "E" * 600
        return ["E"*600] * fixture.get("diagnostics", 0)
    def warnings(self, recurse=False):
        assert recurse is False
        return ["direct warning"]
root = Node(fixture.get("rootPath", "/project1"))
a, b, grandchild = Node(root.path+"/a"), Node(root.path+"/b"), Node(root.path+"/a/deep")
root.children = [a, b]
a.children = [grandchild]
b.inputConnectors = [SimpleNamespace(index=0, connections=[SimpleNamespace(owner=a, index=2)])]
if fixture.get("componentWire"):
    b.inputCOMPConnectors = [SimpleNamespace(connections=[SimpleNamespace(owner=a)])]
if fixture.get("nonfinite"):
    a.nodeX = float("nan")
if fixture.get("wide"):
    root.children = [Node(root.path+"/node"+str(i)) for i in range(fixture["wide"])]
if fixture.get("cycle"):
    grandchild.children = [root]
if fixture.get("wires"):
    b.inputConnectors = [SimpleNamespace(index=0, connections=[SimpleNamespace(owner=a, index=i) for i in range(fixture["wires"])])]
nodes = [root, a, b, grandchild]+root.children
for node in {item.id: item for item in nodes}.values(): node.frozen = True
def op(path):
    assert path == fixture.get("requestedPath", root.path), "path changed in transit"
    return None if fixture.get("missing") else root
`;
	const output = execFileSync(
		"python3",
		["-c", `${harness}\n${buildNetworkSnapshotScript(params)}\nprint(result)`],
		{ encoding: "utf8", maxBuffer: 2_000_000, timeout: 10_000 },
	);
	return JSON.parse(output);
}

describe("buildNetworkSnapshotScript", () => {
	it("reads metadata breadth-first and preserves connector indices without cooking", () => {
		const report = runSnapshot({ parentPath: "/project1" });
		expect(report.ok).toBe(true);
		expect(report.nodes.map((node: { name: string }) => node.name)).toEqual([
			"project1",
			"a",
			"b",
			"deep",
		]);
		expect(report.nodes[1]).toMatchObject({
			family: "COMP",
			flags: { allowCooking: false, lock: true },
			nodeHeight: 100,
			nodeWidth: 150,
			nodeX: 10,
			nodeY: -20,
			type: "base",
		});
		expect(report.connections[0]).toMatchObject({
			inputIndex: 0,
			outputIndex: 2,
			sourcePath: "/project1/a",
			targetPath: "/project1/b",
		});
		expect(report.limits).toMatchObject({ maxDepth: 2, maxNodes: 100 });
	});

	it("bounds traversal at depth zero and counts only omitted direct references", () => {
		const report = runSnapshot({ maxDepth: 0, parentPath: "/project1" });
		expect(report.nodes).toHaveLength(1);
		expect(report.truncation.depthLimitedChildReferences).toBe(2);
		expect(report.truncated).toBe(true);
	});

	it("never enqueues beyond the node capacity and avoids cycles", () => {
		const wide = runSnapshot(
			{ maxNodes: 3, parentPath: "/project1" },
			{ wide: 80 },
		);
		expect(wide.nodes).toHaveLength(3);
		expect(wide.truncation.nodeLimitedChildReferences).toBe(78);
		const cycle = runSnapshot(
			{ maxDepth: 8, parentPath: "/project1" },
			{ cycle: true },
		);
		expect(cycle.nodes).toHaveLength(4);
	});

	it("clips direct diagnostic messages and wire fanout to declared limits", () => {
		const report = runSnapshot(
			{ maxNodes: 4, parentPath: "/project1" },
			{ diagnostics: 15, wires: 150 },
		);
		expect(report.nodes[0].errors).toHaveLength(
			report.limits.diagnosticsPerKind,
		);
		expect(report.nodes[0].errors[0]).toHaveLength(
			report.limits.diagnosticChars,
		);
		expect(report.connections.length).toBeLessThanOrEqual(
			report.limits.maxConnections,
		);
		expect(report.truncation.diagnosticMessages).toBeGreaterThan(0);
		expect(report.truncation.connections).toBeGreaterThan(0);
	});

	it("transmits quotes, escapes, Unicode and Python-like payloads as data", () => {
		const path = '/project1/"\\\n雪\u2028; __import__("os").system("false") #';
		const report = runSnapshot({ parentPath: path }, { rootPath: path });
		expect(report.parentPath).toBe(path);
		expect(report.nodes[0].path).toBe(path);
	});

	it("returns a structured missing-root result", () => {
		const report = runSnapshot({ parentPath: "/project1" }, { missing: true });
		expect(report.ok).toBe(false);
		expect(report.error.code).toBe("PARENT_NOT_FOUND");
		expect(report.nodes).toEqual([]);
	});

	it("includes component hierarchy wires and handles unavailable indices", () => {
		const report = runSnapshot(
			{ parentPath: "/project1" },
			{ componentWire: true },
		);
		expect(report.connections).toHaveLength(2);
		expect(report.connections[1]).toMatchObject({
			inputIndex: 0,
			kind: "component",
			outputIndex: null,
			sourcePath: "/project1/a",
			targetPath: "/project1/b",
		});
	});

	it("emits JSON-safe missing geometry rather than NaN", () => {
		const report = runSnapshot(
			{ parentPath: "/project1" },
			{ nonfinite: true },
		);
		expect(report.nodes[1].nodeX).toBeNull();
	});

	it("supports TD's string diagnostic return type with bounded text", () => {
		const report = runSnapshot(
			{ parentPath: "/project1" },
			{ diagnosticString: true },
		);
		expect(report.nodes[0].errors).toEqual(["E".repeat(256)]);
		expect(report.truncation.clippedStrings).toBe(4);
	});

	it.each([
		{ parentPath: "" },
		{ maxDepth: -1, parentPath: "/a" },
		{ maxDepth: 9, parentPath: "/a" },
		{ maxDepth: 1.5, parentPath: "/a" },
		{ maxNodes: 0, parentPath: "/a" },
		{ maxNodes: 501, parentPath: "/a" },
		{ maxNodes: Number.NaN, parentPath: "/a" },
		{ parentPath: "x".repeat(2049) },
	])("rejects invalid builder input before Python execution: %j", (params) => {
		expect(() => buildNetworkSnapshotScript(params)).toThrow();
	});

	it("exports the same validated public schema used by the builder", () => {
		expect(networkSnapshotParamsSchema.parse({ parentPath: "/" })).toEqual({
			maxDepth: 2,
			maxNodes: 100,
			parentPath: "/",
		});
	});
});
