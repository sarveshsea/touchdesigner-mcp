import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	buildLayoutNetworkScript,
	layoutNetworkScriptParamsSchema,
} from "../../../src/features/tools/pythonScripts/layoutNetworkScript.js";

function execute(script: string, setup = "") {
	const source = `import json
class Node:
    def __init__(self, path, parent=None, family="TOP"):
        self.path, self._parent, self.family = path, parent, family
        self.nodeX, self.nodeY = 11, 22
        self.selected, self.current, self.display = True, False, True
        self.children, self.writes = [], []
        self.failures = {}
    def parent(self):
        return self._parent
    def __setattr__(self, key, value):
        if key in ("nodeX", "nodeY") and hasattr(self, "writes"):
            self.writes.append([key, value])
            failures = self.failures.get(key, [])
            if value in failures:
                raise RuntimeError("denied " + self.path + "." + key)
            if getattr(self, "ignore_coordinates", False) and value == 260:
                return
        if key in ("nodeX", "nodeY"):
            value = int(value)
        object.__setattr__(self, key, value)
root = Node("/project1", family="COMP")
other = Node("/other", family="COMP")
a = Node("/project1/a", root)
b = Node("/project1/b", root)
foreign = Node("/other/foreign", other)
nested = Node("/project1/a/nested", a)
root.children = [b, a]
nodes = {node.path: node for node in [root, other, a, b, foreign, nested]}
def op(path):
    return nodes.get(path)
${setup}
error = None
try:
    exec(${JSON.stringify(script)}, globals())
except Exception as exc:
    error = str(exc)
print(json.dumps({"result": json.loads(result) if "result" in globals() else None,
    "error": error, "nodes": {key: {"x": node.nodeX if node.nodeX == node.nodeX else None, "y": node.nodeY,
    "writes": node.writes, "selected": node.selected, "current": node.current,
    "display": node.display} for key, node in nodes.items()}}))
`;
	const process = spawnSync("python3", ["-c", source], { encoding: "utf8" });
	expect(process.status, process.stderr).toBe(0);
	return JSON.parse(process.stdout);
}

describe("layoutNetworkScript", () => {
	it("defaults to a deterministic complete dry-run with no writes", () => {
		const output = execute(
			buildLayoutNetworkScript({ parentPath: "/project1" }),
		);
		expect(output.error).toBeNull();
		expect(output.result.dryRun).toBe(true);
		expect(output.result.changes).toEqual([
			{ after: { x: 0, y: 0 }, before: { x: 11, y: 22 }, path: "/project1/a" },
			{
				after: { x: 260, y: 0 },
				before: { x: 11, y: 22 },
				path: "/project1/b",
			},
		]);
		expect(output.nodes["/project1/a"].writes).toEqual([]);
		expect(output.nodes["/project1/b"].writes).toEqual([]);
	});

	it("applies explicit grid coordinates and leaves selection/current/display untouched", () => {
		const output = execute(
			buildLayoutNetworkScript({
				columns: 1,
				dryRun: false,
				nodePaths: ["/project1/b", "/project1/a"],
				originX: -30,
				originY: 50,
				parentPath: "/project1",
				spacingX: 300,
				spacingY: 200,
			}),
		);
		expect(output.error).toBeNull();
		expect(output.nodes["/project1/a"]).toMatchObject({
			current: false,
			display: true,
			selected: true,
			x: -30,
			y: 50,
		});
		expect(output.nodes["/project1/b"]).toMatchObject({
			current: false,
			display: true,
			selected: true,
			x: -30,
			y: -150,
		});
		expect(output.nodes["/project1"].writes).toEqual([]);
	});

	it.each([
		"/other/foreign",
		"/project1/a/nested",
		"/project1/missing",
		"/project1",
	])("rejects the complete plan before writing when a path is not a direct child: %s", (path) => {
		const output = execute(
			buildLayoutNetworkScript({
				dryRun: false,
				nodePaths: ["/project1/a", path],
				parentPath: "/project1",
			}),
		);
		expect(output.error).toBeTruthy();
		expect(output.nodes["/project1/a"].writes).toEqual([]);
	});

	it.each([
		"root.family = 'TOP'",
		"nodes.pop('/project1')",
	])("requires a real parent COMP: %s", (setup) => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			setup,
		);
		expect(output.error).toBeTruthy();
		expect(output.nodes["/project1/a"].writes).toEqual([]);
	});

	it("rejects all-child overflow instead of mutating a partial subset", () => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			"root.children = [Node('/project1/n' + str(i), root) for i in range(201)]",
		);
		expect(output.error).toContain("200");
		expect(output.nodes["/project1/a"].writes).toEqual([]);
	});

	it("rolls back both coordinates, including the node whose second write fails", () => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			"b.failures = {'nodeY': [0]}",
		);
		expect(output.error).toContain("/project1/b");
		expect(output.error).toContain("restorationErrors");
		expect(output.nodes["/project1/a"]).toMatchObject({ x: 11, y: 22 });
		expect(output.nodes["/project1/b"]).toMatchObject({ x: 11, y: 22 });
	});

	it("reports exact restoration failure and still attempts every other coordinate", () => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			"b.failures = {'nodeY': [0]}\na.failures = {'nodeX': [11]}",
		);
		expect(output.error).toContain('"path": "/project1/a"');
		expect(output.error).toContain('"coordinate": "nodeX"');
		expect(output.error).toContain("denied /project1/a.nodeX");
		expect(output.nodes["/project1/a"]).toMatchObject({ x: 0, y: 22 });
		expect(output.nodes["/project1/b"]).toMatchObject({ x: 11, y: 22 });
	});

	it("accepts all 200 direct children but never reads descendants", () => {
		const output = execute(
			buildLayoutNetworkScript({ parentPath: "/project1" }),
			"root.children = [Node('/project1/n' + str(i), root) for i in range(200)]",
		);
		expect(output.error).toBeNull();
		expect(output.result.count).toBe(200);
	});

	it("detects a setter that silently ignores a requested coordinate", () => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			"b.ignore_coordinates = True",
		);
		expect(output.error).toContain("nodeX");
		expect(output.nodes["/project1/a"]).toMatchObject({ x: 11, y: 22 });
		expect(output.nodes["/project1/b"]).toMatchObject({ x: 11, y: 22 });
	});

	it("accepts integer origin limits and keeps all computed coordinates finite", () => {
		const output = execute(
			buildLayoutNetworkScript({
				columns: 1,
				dryRun: false,
				originX: 1_000_000,
				originY: -1_000_000,
				parentPath: "/project1",
				spacingY: 1000,
			}),
		);
		expect(output.error).toBeNull();
		expect(output.nodes["/project1/a"]).toMatchObject({
			x: 1_000_000,
			y: -1_000_000,
		});
		expect(output.nodes["/project1/b"]).toMatchObject({
			x: 1_000_000,
			y: -1_001_000,
		});
		for (const change of output.result.changes) {
			expect(Number.isSafeInteger(change.after.x)).toBe(true);
			expect(Number.isSafeInteger(change.after.y)).toBe(true);
		}
	});

	it("supports an empty explicit selection without altering anything", () => {
		const output = execute(
			buildLayoutNetworkScript({
				dryRun: false,
				nodePaths: [],
				parentPath: "/project1",
			}),
		);
		expect(output.result.changes).toEqual([]);
		expect(output.nodes["/project1/a"].writes).toEqual([]);
	});

	it("preflights nonfinite source coordinates before any writes", () => {
		const output = execute(
			buildLayoutNetworkScript({ dryRun: false, parentPath: "/project1" }),
			"object.__setattr__(b, 'nodeX', float('nan'))\nb.writes = []",
		);
		expect(output.error).toContain("finite");
		expect(output.nodes["/project1/a"].writes).toEqual([]);
	});

	it("supports the actual TouchDesigner root COMP path", () => {
		const output = execute(
			buildLayoutNetworkScript({ nodePaths: [], parentPath: "/" }),
			"nodes['/'] = Node('/', family='COMP')",
		);
		expect(output.error).toBeNull();
		expect(output.result.parentPath).toBe("/");
	});

	it.each([
		{ parentPath: "/project1/../other" },
		{ parentPath: "project1" },
		{ parentPath: '/project1/";raise Exception("injected")#' },
		{ parentPath: "/project1\n" },
		{ columns: 0, parentPath: "/project1" },
		{ columns: 13, parentPath: "/project1" },
		{ parentPath: "/project1", spacingX: 179 },
		{ parentPath: "/project1", spacingY: 1001 },
		{ originX: Number.POSITIVE_INFINITY, parentPath: "/project1" },
		{ originX: 1.5, parentPath: "/project1" },
		{ originY: -1.5, parentPath: "/project1" },
		{ originX: 1_000_001, parentPath: "/project1" },
		{ originX: -1_000_001, parentPath: "/project1" },
		{ originY: 1_000_001, parentPath: "/project1" },
		{ originY: -1_000_001, parentPath: "/project1" },
		{ dryRun: "false", parentPath: "/project1" },
		{ nodePaths: ["/project1/a", "/project1/a"], parentPath: "/project1" },
		{
			nodePaths: Array.from({ length: 201 }, (_, i) => `/project1/n${i}`),
			parentPath: "/project1",
		},
	])("rejects malformed or unbounded parameters: %j", (params) => {
		expect(layoutNetworkScriptParamsSchema.safeParse(params).success).toBe(
			false,
		);
		expect(() => buildLayoutNetworkScript(params as never)).toThrow();
	});
});
