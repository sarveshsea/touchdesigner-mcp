import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	buildGraphPageScript,
	collectProjectGraph,
	graphDiff,
} from "../../../src/architecture/graph/index.js";

const fixture = `
class Par:
 def __init__(self,name,val='',mode='CONSTANT',isOP=False,expr=''):
  self.name=name; self.val=val; self.mode='ParMode.'+mode; self.isOP=isOP; self.expr=expr; self.bindExpr=''
 def eval(self): raise AssertionError('arbitrary eval')
 def evalOPs(self):
  assert self.mode=='ParMode.CONSTANT', 'expression eval forbidden'
  return [nodes['/project/b']] if self.val in ('b','/project/b') else []
class Node:
 def __init__(self,path,id,children=(),pars=(),type='baseCOMP'):
  self.path=path; self.id=id; self.name=path.split('/')[-1]; self.family='COMP'; self.type=type
  self.children=list(children); self._pars=pars; self.tags=[]; self.nodeX=0; self.nodeY=0
  self.inputConnectors=[]; self.inputCOMPConnectors=[]
 def pars(self): return self._pars
 def parent(self): return nodes.get(self.path.rsplit('/',1)[0])
 def op(self,path): return nodes.get(path if path.startswith('/') else self.path+'/'+path)
 def cook(self,*a,**k): raise AssertionError('cook forbidden')
a=Node('/project/a',2,pars=[Par('source','b',isOP=True),Par('dynamic',mode='EXPRESSION',expr="op('other')")])
b=Node('/project/b',3)
root=Node('/project',1,[a,b])
nodes={n.path:n for n in [root,a,b]}
def op(path):
 import posixpath
 return nodes.get(posixpath.normpath(path))
class Project: name='test.toe'; folder='/tmp'
project=Project()
class App: build=202530000
app=App()
`;
function python(scripts: string[], setup = "") {
	const out = execFileSync(
		"python3",
		[
			"-c",
			fixture +
				"\n" +
				setup +
				"\n" +
				scripts
					.map((s) => `exec(${JSON.stringify(s)})\nprint(result)`)
					.join("\n"),
		],
		{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
	);
	return out
		.trim()
		.split("\n")
		.map((s) => JSON.parse(s));
}
const page = (
	items: Parameters<typeof buildGraphPageScript>[0]["items"] = [
		{ path: "/project" },
	],
) =>
	buildGraphPageScript({
		dependencyAnalysis: true,
		items,
		pageSize: 100,
		rootPath: "/project",
	});

describe("bounded graph bridge script", () => {
	it("reads nodes and exact references without evaluation or forced cooks", () => {
		const [report] = python([
			page([
				{ path: "/project" },
				{ path: "/project/a" },
				{ path: "/project/b" },
			]),
		]);
		expect(report.nodes).toHaveLength(3);
		expect(report.nodes[1].parameterReferences).toContainEqual(
			expect.objectContaining({
				evidence: "observed",
				name: "source",
				targetPaths: ["/project/b"],
			}),
		);
		expect(report.edges).toContainEqual(
			expect.objectContaining({ evidence: "unresolved", kind: "expression" }),
		);
		expect(JSON.stringify(report)).not.toContain("op('other')");
		expect(report.dependencyComplete).toBe(true);
	});
	it("bounds wide child expansion and returns resumable offsets", () => {
		const [report] = python(
			[
				buildGraphPageScript({
					dependencyAnalysis: false,
					items: [{ path: "/project" }],
					pageSize: 2,
					rootPath: "/project",
				}),
			],
			"root.children=[Node('/project/n'+str(i),100+i) for i in range(10)]",
		);
		expect(report.discovered).toHaveLength(2);
		expect(report.pending).toContainEqual({
			expandOnly: true,
			offset: 2,
			path: "/project",
		});
	});
	it("preserves process session while invalidating project identity on reopen", () => {
		const reports = python([page(), page()]);
		expect(reports[0].sessionId).toBe(reports[1].sessionId);
		expect(reports[0].projectId).toBe(reports[1].projectId);
	});
	it("encodes hostile paths as data and reports missing roots", () => {
		const [report] = python([
			page([{ path: "/project/missing'\\nraise Exception('injected')" }]),
		]);
		expect(report.missing).toHaveLength(1);
		expect(() =>
			python([
				buildGraphPageScript({
					dependencyAnalysis: false,
					items: [],
					pageSize: 1,
					rootPath: "/missing",
				}),
			]),
		).toThrow();
	});
	it("reports generated ownership and constant wildcard references as unresolved", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a._pars=[Par('clone','../b',isOP=True),Par('wild','../*',isOP=True)]; a.type='replicatorCOMP'",
		);
		expect(report.nodes[0].ownership).toEqual(
			expect.arrayContaining(["clone", "replicator"]),
		);
		expect(
			report.nodes[0].parameterReferences.find(
				(p: { name: string }) => p.name === "wild",
			).evidence,
		).toBe("unresolved");
	});
});

const node = (path: string, id: number) => ({
	family: "COMP",
	fingerprint: String(id),
	flags: {},
	id,
	name: path.split("/").pop(),
	nodeX: 0,
	nodeY: 0,
	opType: "baseCOMP",
	ownership: [],
	parameterReferences: [],
	parentPath: path.slice(0, path.lastIndexOf("/")),
	path,
	sourceHashes: {},
	tags: [],
});
const response = (overrides = {}) => ({
	build: "202530000",
	dependencyComplete: true,
	dirtyRevision: null,
	discovered: [],
	edges: [],
	missing: [],
	nodes: [node("/project", 1)],
	pending: [],
	projectId: "project",
	projectPath: "/tmp/test.toe",
	sessionId: "session",
	truncated: false,
	warnings: [],
	...overrides,
});
describe("graph collection and identity", () => {
	it("collects paginated structure and yields between bridge calls", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(response({ discovered: [{ path: "/project/a" }] }))
			.mockResolvedValueOnce(response({ nodes: [node("/project/a", 2)] }));
		const graph = await collectProjectGraph(
			{ execute },
			{ dependencyAnalysis: true, rootPath: "/project" },
		);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(graph.nodes).toHaveLength(2);
		expect(graph.complete).toBe(true);
	});
	it("marks the graph truncated at its capacity", async () => {
		const graph = await collectProjectGraph(
			{
				execute: vi
					.fn()
					.mockResolvedValue(
						response({ discovered: [{ path: "/project/a" }] }),
					),
			},
			{ maxNodes: 1, rootPath: "/project" },
		);
		expect(graph.complete).toBe(false);
		expect(graph.coverage.truncated).toBe(true);
	});
	it("does not merge nodes across a changed bridge session", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(response({ discovered: [{ path: "/project/a" }] }))
			.mockResolvedValueOnce(
				response({ nodes: [node("/project/a", 2)], sessionId: "new" }),
			);
		const graph = await collectProjectGraph(
			{ execute },
			{ rootPath: "/project" },
		);
		expect(graph.status).toBe("stale");
		expect(graph.complete).toBe(false);
		expect(graph.nodes).toHaveLength(1);
	});
	it("retains the previous graph as disconnected without claiming freshness", async () => {
		const old = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(response()) },
			{ rootPath: "/project" },
		);
		const next = await collectProjectGraph(
			{ execute: vi.fn().mockRejectedValue(new Error("token=SECRET")) },
			{ previous: old, rootPath: "/project" },
		);
		expect(next.status).toBe("disconnected");
		expect(next.observedAt).toBe(old.observedAt);
		expect(JSON.stringify(next)).not.toContain("SECRET");
		expect(old.status).toBe("fresh");
	});
	it("rejects unsafe limits and malformed bridge envelopes", async () => {
		const execute = vi.fn().mockResolvedValue({ nodes: "wrong" });
		await expect(
			collectProjectGraph(
				{ execute },
				{ maxNodes: 50001, rootPath: "/project" },
			),
		).rejects.toThrow();
		const graph = await collectProjectGraph(
			{ execute },
			{ rootPath: "/project" },
		);
		expect(graph.complete).toBe(false);
		expect(graph.status).toBe("disconnected");
	});
	it("diffs stable IDs and treats session changes as invalidation", async () => {
		const first = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(response()) },
			{ rootPath: "/project" },
		);
		const next = {
			...first,
			nodes: [{ ...first.nodes[0], fingerprint: "changed", path: "/renamed" }],
		};
		expect(graphDiff(first, next).changed).toEqual(["/renamed"]);
		expect(graphDiff(first, { ...next, sessionId: "new" }).invalidated).toBe(
			true,
		);
	});
});

describe("graph completeness and bounded source census", () => {
	it("collects ordinary and COMP wires with producer-to-consumer indices", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"from types import SimpleNamespace\na.inputConnectors=[SimpleNamespace(index=2,connections=[SimpleNamespace(index=3,owner=b)])]\na.inputCOMPConnectors=[SimpleNamespace(index=0,connections=[SimpleNamespace(index=1,owner=b)])]",
		);
		expect(report.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					inputIndex: 2,
					kind: "wire",
					outputIndex: 3,
					source: "/project/b",
					target: "/project/a",
				}),
				expect.objectContaining({
					inputIndex: 0,
					kind: "component-wire",
					outputIndex: 1,
				}),
			]),
		);
	});
	it("hashes source transiently and identifies static candidate dependencies", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a.family='DAT'; a.type='textDAT'; a.text=\"op('b')\\npassword='NOT_RETURNED'\"; a._pars=[]",
		);
		expect(report.nodes[0].sourceHashes["DAT:text"]).toMatch(/^[a-f0-9]{64}$/);
		expect(report.edges).toContainEqual(
			expect.objectContaining({
				evidence: "static",
				kind: "expression",
				source: "/project/b",
				target: "/project/a",
			}),
		);
		expect(JSON.stringify(report)).not.toContain("NOT_RETURNED");
	});
	it("does not read DAT text when source analysis is disabled", () => {
		const [report] = python(
			[
				buildGraphPageScript({
					dependencyAnalysis: false,
					items: [{ path: "/project/a" }],
					pageSize: 100,
					rootPath: "/project",
				}),
			],
			"a.family='DAT'; a.type='textDAT'; Node.text=property(lambda self: (_ for _ in ()).throw(AssertionError('read source')))",
		);
		expect(report.dependencyComplete).toBe(false);
	});
	it("marks oversized parameter/source collections unresolved", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a._pars=[Par('p'+str(i),mode='EXPRESSION',expr='a'*70000) for i in range(600)]",
		);
		expect(report.nodes[0].parameterReferences).toHaveLength(512);
		expect(Object.keys(report.nodes[0].sourceHashes)).toHaveLength(512);
		expect(report.dependencyComplete).toBe(false);
	});
	it("records bindings and exports without evaluating either", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a._pars=[Par('bind',mode='BIND'),Par('export',mode='EXPORT')]",
		);
		expect(report.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ evidence: "unresolved", kind: "binding" }),
				expect.objectContaining({ evidence: "unresolved", kind: "export" }),
			]),
		);
	});
	it("respects constant relative native context and skips pattern expansion", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a._pars=[Par('source','b',isOP=True),Par('pattern','*',isOP=True)]",
		);
		expect(report.nodes[0].parameterReferences[0].targetPaths).toEqual([
			"/project/b",
		]);
		expect(report.nodes[0].parameterReferences[1].targetPaths).toEqual([]);
	});
	it("invalidates project epoch on changed project file", () => {
		const reports = python([page(), `project.name='second.toe'\n${page()}`]);
		expect(reports[0].projectId).not.toBe(reports[1].projectId);
	});
	it("does not claim dependency closure for a subtree", async () => {
		const graph = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(response()) },
			{ dependencyAnalysis: true, rootPath: "/project" },
		);
		expect(graph.complete).toBe(true);
		expect(graph.dependencyComplete).toBe(false);
	});
	it("tracks structural changes during a multi-page scan", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(
				response({ dirtyRevision: 1, discovered: [{ path: "/project/a" }] }),
			)
			.mockResolvedValueOnce(
				response({ dirtyRevision: 2, nodes: [node("/project/a", 2)] }),
			);
		expect(
			(await collectProjectGraph({ execute }, { rootPath: "/project" })).status,
		).toBe("stale");
	});
	it("stops before calling the bridge for an aborted scan", async () => {
		const execute = vi.fn();
		const controller = new AbortController();
		controller.abort();
		const graph = await collectProjectGraph(
			{ execute },
			{ rootPath: "/project", signal: controller.signal },
		);
		expect(execute).not.toHaveBeenCalled();
		expect(graph.coverage.truncated).toBe(true);
		expect(graph.complete).toBe(false);
	});
	it("accepts API execute JSON result envelopes", async () => {
		const graph = await collectProjectGraph(
			{
				execute: vi
					.fn()
					.mockResolvedValue({ result: JSON.stringify(response()) }),
			},
			{ rootPath: "/project" },
		);
		expect(graph.nodes).toHaveLength(1);
	});
});

describe("graph transport and delta failure boundaries", () => {
	it("reports added/removed/changed nodes and edges without mutating the old graph", async () => {
		const edge = {
			evidence: "observed",
			id: "wire-a",
			kind: "wire",
			source: "/project/a",
			target: "/project/b",
		};
		const old = await collectProjectGraph(
			{
				execute: vi.fn().mockResolvedValue(
					response({
						edges: [edge],
						nodes: [node("/project/a", 2), node("/project/b", 3)],
					}),
				),
			},
			{ rootPath: "/project" },
		);
		const next = await collectProjectGraph(
			{
				execute: vi.fn().mockResolvedValue(
					response({
						edges: [{ ...edge, id: "wire-b" }],
						nodes: [
							{ ...node("/project/a", 2), fingerprint: "other" },
							node("/project/c", 4),
						],
					}),
				),
			},
			{ previous: old, rootPath: "/project" },
		);
		expect(graphDiff(old, next)).toMatchObject({
			added: ["/project/c"],
			changed: ["/project/a"],
			edgesAdded: ["wire-b"],
			edgesRemoved: ["wire-a"],
			removed: ["/project/b"],
			toRevision: 2,
		});
		expect(old.nodes[0].fingerprint).toBe("2");
	});
	it("bounds stalled requests by the overall scan deadline", async () => {
		const execute = vi.fn().mockImplementation(() => new Promise(() => {}));
		const graph = await collectProjectGraph(
			{ execute },
			{ maxDurationMs: 5, rootPath: "/project" },
		);
		expect(graph.status).toBe("stale");
		expect(graph.coverage.truncated).toBe(true);
		expect(graph.warnings.join(" ")).toContain("time budget exhausted");
		expect(graph.complete).toBe(false);
	});
	it("rejects out-of-scope continuation and work items before another bridge call", async () => {
		expect(() =>
			buildGraphPageScript({
				items: [{ path: "/outside" }],
				rootPath: "/project",
			}),
		).toThrow();
		const execute = vi
			.fn()
			.mockResolvedValue(response({ pending: [{ path: "/outside" }] }));
		expect(
			(await collectProjectGraph({ execute }, { rootPath: "/project" }))
				.complete,
		).toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("deduplicates discovered nodes and resumes child-only expansion", async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					discovered: [{ path: "/project/a" }, { path: "/project/a" }],
					pending: [{ expandOnly: true, offset: 1, path: "/project" }],
				}),
			)
			.mockResolvedValueOnce(
				response({
					dependencyComplete: false,
					nodes: [node("/project/a", 2)],
					warnings: ["partial source census"],
				}),
			);
		expect(
			(await collectProjectGraph({ execute }, { rootPath: "/project" })).nodes,
		).toHaveLength(2);
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it("reports disappearing nodes and per-page truncation accurately", async () => {
		const graph = await collectProjectGraph(
			{
				execute: vi
					.fn()
					.mockResolvedValue(
						response({ missing: ["/project/a"], truncated: true }),
					),
			},
			{ rootPath: "/project" },
		);
		expect(graph.status).toBe("stale");
		expect(graph.coverage.truncated).toBe(true);
		expect(graph.dependencyComplete).toBe(false);
	});
	it("only permits complete dependency census over the full root", async () => {
		const graph = await collectProjectGraph(
			{
				execute: vi.fn().mockResolvedValue(response({ nodes: [node("/", 0)] })),
			},
			{ dependencyAnalysis: true, rootPath: "/" },
		);
		expect(graph.dependencyComplete).toBe(true);
	});
	it("records runtime caches without returning their contents", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a.storage={'access_token':'NEVER_RETURNED'}; a._pars=[]",
		);
		expect(report.nodes[0].ownership).toContain("runtime-cache");
		expect(JSON.stringify(report)).not.toContain("NEVER_RETURNED");
	});
});

describe("durable project identity and native TD metadata", () => {
	it("keeps project identity stable across independent bridge processes", () => {
		const [first] = python([page()]);
		const [reopened] = python([page()]);
		expect(first.projectId).toBe(reopened.projectId);
		expect(first.projectId).toMatch(/^[a-f0-9]{64}$/);
		expect(first.sessionId).not.toBe(reopened.sessionId);
	});
	it("canonicalizes path segments without folding POSIX case-sensitive names", () => {
		const [first] = python([page()], "project.folder='/tmp/a/../Case'");
		const [same] = python([page()], "project.folder='/tmp/Case'");
		const [different] = python([page()], "project.folder='/tmp/case'");
		expect(first.projectId).toBe(same.projectId);
		expect(first.projectId).not.toBe(different.projectId);
	});
	it("uses canonical opType when type is the native unsuffixed operator name", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a.family='CHOP'; a.type='audiodevicein'; a.opType='audiodeviceinCHOP'; a._pars=[]",
		);
		expect(report.nodes[0].opType).toBe("audiodeviceinCHOP");
	});
	it("normalizes unsuffixed older metadata using its family", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a.family='COMP'; a.type='annotate'; a._pars=[]",
		);
		expect(report.nodes[0].opType).toBe("annotateCOMP");
	});
	it.each([
		"executeDAT",
		"chopexecuteDAT",
		"datexecuteDAT",
		"opexecuteDAT",
		"panelexecuteDAT",
		"parexecuteDAT",
	])("includes unmoved %s callback source dependencies", (type) => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			`a.family='DAT'; a.type='${type}'; a.text="op('/project/b')"; a._pars=[]`,
		);
		expect(report.nodes[0].sourceHashes["DAT:text"]).toMatch(/^[a-f0-9]{64}$/);
		expect(report.edges).toContainEqual(
			expect.objectContaining({
				evidence: "static",
				source: "/project/b",
				target: "/project/a",
			}),
		);
		expect(report.edges).toContainEqual(
			expect.objectContaining({ evidence: "unresolved", kind: "expression" }),
		);
	});
});

describe("semantic graph revisions", () => {
	it("keeps revision stable for an unchanged re-observation", async () => {
		const execute = vi.fn().mockResolvedValue(response());
		const first = await collectProjectGraph(
			{ execute },
			{ rootPath: "/project" },
		);
		const second = await collectProjectGraph(
			{ execute },
			{ previous: first, rootPath: "/project" },
		);
		expect(second.revision).toBe(first.revision);
	});
	it("increments revision when source fingerprints or coverage changes", async () => {
		const first = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(response()) },
			{ rootPath: "/project" },
		);
		const changed = await collectProjectGraph(
			{
				execute: vi.fn().mockResolvedValue(
					response({
						nodes: [{ ...node("/project", 1), fingerprint: "new-source" }],
					}),
				),
			},
			{ previous: first, rootPath: "/project" },
		);
		expect(changed.revision).toBe(first.revision + 1);
		const truncated = await collectProjectGraph(
			{ execute: vi.fn().mockResolvedValue(response({ truncated: true })) },
			{ previous: first, rootPath: "/project" },
		);
		expect(truncated.revision).toBe(first.revision + 1);
	});
});

describe("large native network census limits", () => {
	it("paginates connector tails rather than silently omitting native ports", () => {
		const [first] = python(
			[page([{ path: "/project/a" }])],
			"from types import SimpleNamespace\na.inputConnectors=[SimpleNamespace(index=i,connections=[SimpleNamespace(index=0,owner=b)]) for i in range(80)]",
		);
		expect(first.pending).toContainEqual({
			path: "/project/a",
			wireAttribute: "inputConnectors",
			wireOffset: 64,
		});
		const [tail] = python(
			[
				page([
					{
						path: "/project/a",
						wireAttribute: "inputConnectors",
						wireOffset: 64,
					},
				]),
			],
			"from types import SimpleNamespace\na.inputConnectors=[SimpleNamespace(index=i,connections=[SimpleNamespace(index=0,owner=b)]) for i in range(80)]",
		);
		expect(tail.nodes).toHaveLength(0);
		expect(tail.edges).toHaveLength(16);
		expect(tail.edges[0].inputIndex).toBe(64);
	});
	it("records oversized AST source as hashed opaque dependency within the hash budget", () => {
		const [report] = python(
			[page([{ path: "/project/a" }])],
			"a.family='DAT'; a.type='textDAT'; a.text='#'+('x'*80000); a._pars=[]",
		);
		expect(report.nodes[0].sourceHashes["DAT:text"]).toMatch(/^[a-f0-9]{64}$/);
		expect(report.dependencyComplete).toBe(true);
		expect(report.edges).toContainEqual(
			expect.objectContaining({ evidence: "unresolved", kind: "expression" }),
		);
	});
});
