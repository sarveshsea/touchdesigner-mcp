import { describe, expect, it } from "vitest";
import { planRefactor } from "../../../src/architecture/refactor/index.js";
import type {
	GraphNode,
	ProjectGraph,
} from "../../../src/architecture/types.js";

const node = (path: string, id: number): GraphNode => ({
	family: "CHOP",
	fingerprint: String(id),
	flags: {},
	id,
	name: path.split("/").at(-1) ?? "",
	nodeX: 0,
	nodeY: 0,
	opType: "nullCHOP",
	ownership: [],
	parameterReferences: [],
	parentPath: path.slice(0, path.lastIndexOf("/")),
	path,
	sourceHashes: {},
	tags: [],
});
const graph = (): ProjectGraph => ({
	build: "2025.33230",
	complete: true,
	coverage: { remaining: 0, truncated: false, visited: 3 },
	dependencyComplete: true,
	edges: [
		{
			evidence: "observed",
			id: "w",
			inputIndex: 0,
			kind: "wire",
			outputIndex: 0,
			source: "/project1/external",
			target: "/project1/nested/a",
		},
	],
	nodes: [
		node("/project1/nested/a", 1),
		node("/project1/nested/b", 2),
		node("/project1/external", 3),
	],
	observedAt: "now",
	projectId: "p",
	projectPath: "/tmp/art.toe",
	revision: 3,
	rootPath: "/",
	schemaVersion: 1,
	sessionId: "s",
	status: "fresh",
	warnings: [],
});
describe("refactor planning", () => {
	it("binds immutable nested sibling plan to session and graph revision", () => {
		const g = graph();
		const p = planRefactor(g, {
			name: "audio",
			paths: g.nodes.slice(0, 2).map((n) => n.path),
		});
		expect(p.blockedReasons).toEqual([]);
		expect(p.parentPath).toBe("/project1/nested");
		expect(Object.isFrozen(p)).toBe(true);
		expect(planRefactor({ ...g, sessionId: "new" }, p.input).id).not.toBe(p.id);
		expect(planRefactor({ ...g, revision: 4 }, p.input).id).not.toBe(p.id);
	});
	it("requires whole project dependency census", () => {
		for (const g of [
			{ ...graph(), dependencyComplete: false },
			{ ...graph(), rootPath: "/project1" },
			{ ...graph(), complete: false },
		])
			expect(
				planRefactor(g, { name: "audio", paths: [g.nodes[0].path] })
					.blockedReasons.length,
			).toBeGreaterThan(0);
	});
	it("blocks inbound unresolved expressions and code ownership", () => {
		const g = graph();
		g.edges.push({
			evidence: "unresolved",
			id: "x",
			kind: "expression",
			source: g.nodes[2].path,
			target: g.nodes[0].path,
		});
		expect(
			planRefactor(g, {
				name: "audio",
				paths: [g.nodes[0].path],
			}).blockedReasons.join(),
		).toContain("expression");
	});
	it("repairs inbound typed constant OP refs while preserving target order", () => {
		const g = graph();
		g.nodes[2].parameterReferences = [
			{
				evidence: "observed",
				mode: "constant",
				name: "chop",
				targetPaths: [g.nodes[1].path, g.nodes[0].path],
			},
		];
		const p = planRefactor(g, {
			name: "audio",
			paths: g.nodes.slice(0, 2).map((n) => n.path),
		});
		expect(p.repairs[0].targetsAfter).toEqual([
			"/project1/nested/audio/b",
			"/project1/nested/audio/a",
		]);
	});
	it("deterministically orders boundary ports and rejects wildcard references", () => {
		const g = graph();
		g.edges.push({
			...g.edges[0],
			id: "w2",
			inputIndex: 1,
			target: g.nodes[1].path,
		});
		const p = planRefactor(g, {
			name: "audio",
			paths: g.nodes.slice(0, 2).map((n) => n.path),
		});
		expect(p.ports).toHaveLength(1);
		g.nodes[2].parameterReferences = [
			{
				evidence: "unresolved",
				mode: "constant",
				name: "chop",
				targetPaths: ["/project1/nested/*"],
			},
		];
		expect(planRefactor(g, p.input).blockedReasons.length).toBeGreaterThan(0);
	});
});

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
	buildCanaryScript,
	buildStageScript,
	RefactorStager,
	runRefactorCanary,
} from "../../../src/architecture/refactor/index.js";

describe("refactor staging", () => {
	it("generates syntactically valid Python with checkpoint before mutation and no external tox save", () => {
		const p = planRefactor(graph(), {
			name: "wrapped",
			paths: [graph().nodes[0].path],
		});
		const script = buildStageScript(
			p,
			"/tmp/art.checkpoint.toe",
			"/tmp/art.staged.toe",
		);
		const checked = spawnSync(
			"python3",
			["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
			{ encoding: "utf8", input: script },
		);
		expect(checked.status, checked.stderr).toBe(0);
		expect(script.indexOf("_r_save_copy(_rp['checkpoint']")).toBeLessThan(
			script.indexOf("container=_r_collapse(parent"),
		);
		expect(script).toContain("ACTIVE_COPY_NOT_CONFIRMED");
		expect(script).toContain("saveExternalToxs=False");
		expect(script).toContain("NONOVERWRITE_PATH_EXISTS");
		expect(script).toContain("STALE_OPERATOR");
		expect(script).toContain("ERROR_BASELINE_CHANGED");
		expect(script).toContain("UNKNOWN_GENERATED_BOUNDARY_OPERATOR");
		expect(
			spawnSync(
				"python3",
				["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
				{ input: buildCanaryScript() },
			).status,
		).toBe(0);
	});
	it("journals success once and returns immutable caller copies for repeat stage/status", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi.fn().mockResolvedValue({
				id: p.id,
				phase: "saved",
				sessionId: "s",
				state: "complete",
			});
			const s = new RefactorStager({ execute }, root);
			const first = await s.stage(p, graph());
			first.state = "failed";
			expect((await s.stage(p, graph())).state).toBe("complete");
			expect(execute).toHaveBeenCalledTimes(1);
			const journal = JSON.parse(
				await readFile(join(root, "refactor", `${p.id}.json`), "utf8"),
			);
			expect(journal.checkpoint).toContain("/tmp/art.refactor_");
			expect(journal.checkpoint.endsWith(".checkpoint.toe")).toBe(true);
			expect(journal.staged.endsWith(".staged.toe")).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("rejects changed session/revision before bridge or disk staging", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi.fn();
			const s = new RefactorStager({ execute }, root);
			await expect(
				s.stage(p, { ...graph(), sessionId: "reopened" }),
			).rejects.toThrow("Stale");
			await expect(s.stage(p, { ...graph(), revision: 999 })).rejects.toThrow(
				"Stale",
			);
			expect(execute).not.toHaveBeenCalled();
			expect(await s.status(p.id)).toBeNull();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("retains failure/checkpoint receipt and never retries a failed mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi.fn().mockResolvedValue({
				error: "BOUNDARY_WIRE_ORDER_CHANGED",
				id: p.id,
				phase: "collapse",
				sessionId: "s",
				state: "failed",
			});
			const s = new RefactorStager({ execute }, root);
			const failed = await s.stage(p, graph());
			expect(failed.checkpoint).toContain("checkpoint.toe");
			expect((await s.stage(p, graph())).error).toBe(
				"BOUNDARY_WIRE_ORDER_CHANGED",
			);
			expect(execute).toHaveBeenCalledTimes(1);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("reconciles lost responses through read-only status rather than repeating collapse", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi
				.fn()
				.mockRejectedValueOnce(new Error("lost response"))
				.mockResolvedValue({
					id: p.id,
					phase: "saved",
					sessionId: "s",
					state: "complete",
				});
			const s = new RefactorStager({ execute }, root);
			expect((await s.stage(p, graph())).state).toBe("uncertain");
			expect((await s.status(p.id))?.state).toBe("complete");
			expect(execute.mock.calls[1][0]).not.toContain("collapseSelected");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("requires a positive actual canary receipt", async () => {
		await expect(
			runRefactorCanary({
				execute: async () => ({ build: "2025.33230", passed: false }),
			}),
		).rejects.toThrow("canary");
		expect(
			(
				await runRefactorCanary({
					execute: async () =>
						JSON.stringify({
							build: "202533230",
							passed: true,
							receiptId: "live-fixture",
						}),
				})
			).passed,
		).toBe(true);
	});
});

describe("refactor refusal and trust boundaries", () => {
	it("rejects uninspected inbound owners even when graph claims complete", () => {
		const g = graph();
		delete g.nodes[2].parameterReferences;
		expect(
			planRefactor(g, {
				name: "audio",
				paths: [g.nodes[0].path],
			}).blockedReasons.join(),
		).toContain("Whole-project");
	});
	it("requires exact server-owned tooling fingerprints, session and project", () => {
		const g = graph();
		g.nodes[2].ownership = ["source-code"];
		g.nodes[2].sourceHashes = { "DAT:text": "source" };
		g.nodes[2].parameterReferences = [
			{
				evidence: "unresolved",
				mode: "expression",
				name: "expr",
				targetPaths: [],
			},
		];
		const input = { name: "audio", paths: [g.nodes[0].path] };
		const adapter = {
			id: "verified-bridge",
			nodeFingerprints: { [g.nodes[2].path]: g.nodes[2].fingerprint },
			projectId: "p",
			sessionId: "s",
		};
		expect(planRefactor(g, input).blockedReasons.length).toBeGreaterThan(0);
		expect(planRefactor(g, input, [adapter]).blockedReasons).toEqual([]);
		for (const a of [
			{ ...adapter, sessionId: "old" },
			{ ...adapter, projectId: "other" },
			{ ...adapter, nodeFingerprints: { [g.nodes[2].path]: "changed" } },
		])
			expect(planRefactor(g, input, [a]).blockedReasons.length).toBeGreaterThan(
				0,
			);
		expect(
			planRefactor(g, { name: "unsafe", paths: [g.nodes[2].path] }, [adapter])
				.blockedReasons.length,
		).toBeGreaterThan(0);
	});
	it("blocks source, cache, clone, external tox and object/panel operators", () => {
		for (const change of [
			{ ownership: ["clone"] },
			{ ownership: ["external-tox"] },
			{ ownership: ["runtime-cache"] },
			{ flags: { lock: true } },
			{ opType: "cacheTOP" },
			{ family: "COMP", opType: "containerCOMP" },
			{ family: "COMP", opType: "cameraCOMP" },
			{ parameterReferences: undefined },
		]) {
			const g = graph();
			g.nodes = [{ ...g.nodes[0], ...change }, ...g.nodes.slice(1)];
			expect(
				planRefactor(g, { name: "audio", paths: [g.nodes[0].path] })
					.blockedReasons.length,
			).toBeGreaterThan(0);
		}
	});
	it("blocks unsafe graph shape, name collision and unsupported builds", () => {
		for (const change of [
			{ build: "2023.11600" },
			{ projectPath: "relative.toe" },
			{ status: "stale" as const },
			{ coverage: { remaining: 2, truncated: true, visited: 3 } },
		]) {
			const g = { ...graph(), ...change };
			expect(
				planRefactor(g, { name: "audio", paths: [g.nodes[0].path] })
					.blockedReasons.length,
			).toBeGreaterThan(0);
		}
		const g = graph();
		expect(
			planRefactor(g, { name: "b", paths: [g.nodes[0].path] }).blockedReasons,
		).toContain("Container name already exists");
		expect(
			planRefactor(g, {
				name: "audio",
				paths: [g.nodes[0].path, g.nodes[2].path],
			}).blockedReasons,
		).toContain("All selected operators must be siblings");
		expect(
			planRefactor(g, {
				name: "audio",
				paths: ["/missing"],
			}).blockedReasons.join(),
		).toContain("Missing operator");
		expect(() =>
			planRefactor(g, { name: "../escape", paths: [g.nodes[0].path] }),
		).toThrow();
	});
	it("rejects ordered fan-in ambiguity, unsupported refs and incomplete wire boundaries", () => {
		const g = graph();
		g.edges.push({ ...g.edges[0], id: "other", source: g.nodes[1].path });
		expect(
			planRefactor(g, {
				name: "audio",
				paths: [g.nodes[0].path],
			}).blockedReasons.join(),
		).toContain("ordered adapter");
		const broken = graph();
		broken.edges[0] = { ...broken.edges[0], inputIndex: undefined };
		expect(
			planRefactor(broken, {
				name: "audio",
				paths: [broken.nodes[0].path],
			}).blockedReasons.join(),
		).toContain("Incomplete boundary");
		for (const mode of ["expression", "bind", "export"]) {
			const h = graph();
			h.nodes[0].parameterReferences = [
				{
					evidence: "observed",
					mode,
					name: "test",
					targetPaths: [h.nodes[2].path],
				},
			];
			expect(
				planRefactor(h, {
					name: "audio",
					paths: [h.nodes[0].path],
				}).blockedReasons.join(),
			).toContain(mode);
		}
		const h = graph();
		h.nodes[0].parameterReferences = [
			{
				evidence: "observed",
				mode: "constant",
				name: "test",
				targetPaths: ["/absent"],
			},
		];
		expect(
			planRefactor(h, {
				name: "audio",
				paths: [h.nodes[0].path],
			}).blockedReasons.join(),
		).toContain("outside dependency census");
	});
	it("rejects forged checkpoint metadata without trusting caller plan fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi.fn().mockResolvedValue({
				id: p.id,
				phase: "saved",
				sessionId: "s",
				state: "complete",
			});
			const s = new RefactorStager({ execute }, root);
			const result = await s.stage(
				{ ...p, projectPath: "/untrusted/other.toe", sessionId: "forged" },
				graph(),
			);
			expect(result.sessionId).toBe("s");
			expect(result.checkpoint.startsWith("/tmp/art.")).toBe(true);
			expect(result.checkpoint).not.toContain("untrusted");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("retains uncertainty for malformed/missing status responses and rejects status traversal", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
		try {
			const p = planRefactor(graph(), {
				name: "audio",
				paths: [graph().nodes[0].path],
			});
			const execute = vi
				.fn()
				.mockResolvedValueOnce({
					result: JSON.stringify({ id: "wrong", state: "complete" }),
				})
				.mockResolvedValueOnce(null)
				.mockRejectedValueOnce(new Error("offline"));
			const s = new RefactorStager({ execute }, root);
			expect((await s.stage(p, graph())).state).toBe("uncertain");
			expect((await s.status(p.id))?.state).toBe("uncertain");
			expect((await s.status(p.id))?.state).toBe("uncertain");
			await expect(s.status("../../escape")).rejects.toThrow("Invalid");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});

it("sets selected current before native collapse and protects all unaffected paths", () => {
	const canary = buildCanaryScript();
	expect(canary).toContain("d.current=True");
	expect(canary.indexOf("selected[-1].current=True")).toBeLessThan(
		canary.indexOf("candidate=parent.collapseSelected()"),
	);
	expect(canary).toContain("CANARY_UNSELECTED_CURRENT_SWEPT");
	const p = planRefactor(graph(), {
		name: "audio",
		paths: [graph().nodes[0].path],
	});
	const script = buildStageScript(p, "/tmp/a.toe", "/tmp/b.toe");
	expect(script).toContain("for oldPath,n in _rby_path.items()");
	expect(script).toContain("else oldPath");
});

it("executes generated collapse and boundary guards against a native-behavior fake", () => {
	const definitions = buildCanaryScript().split(
		"result=json.dumps(_r_canary())",
	)[0];
	const fake = `
class N:
 def __init__(self,parent,name,id):self._parent=parent;self.name=name;self.id=id;self.selected=False;self.inputConnectors=[]
 @property
 def current(self):return self._parent.currentNode is self
 @current.setter
 def current(self,value):
  if value:self._parent.currentNode=self
 def parent(self):return self._parent
class Parent:
 def __init__(self):self.children=[];self.currentNode=None;self.moved=[]
 def collapseSelected(self):
  self.moved=[n for n in self.children if n.selected or n.current]
  self.children=[n for n in self.children if n not in self.moved]
  new=N(self,'base1',99);self.children.append(new);return new
parent=Parent();first=N(parent,'first',1);untouched=N(parent,'untouched',2);parent.children=[first,untouched];untouched.current=True
assert _r_collapse(parent,[first],'wrapped').name=='wrapped'
assert parent.moved==[first] and untouched in parent.children
class C:
 def __init__(self,owner,index,links=None):self.owner=owner;self.index=index;self.connections=links or []
source=N(parent,'source',3);target=N(parent,'target',4)
target.inputConnectors=[C(target,0,[C(source,1)])]
wires=[dict(sourceId=3,targetId=4,inputIndex=0,outputIndex=1)]
_r_check_wires(wires,{3:source,4:target})
target.inputConnectors[0].connections=[C(source,0)]
try:_r_check_wires(wires,{3:source,4:target});raise AssertionError('Wrong output order accepted')
except RuntimeError as e:assert 'BOUNDARY_WIRE_ORDER_CHANGED' in str(e)
print('native-behavior-fake passed')
`;
	const run = spawnSync("python3", ["-c", definitions + fake], {
		encoding: "utf8",
	});
	expect(run.status, run.stderr).toBe(0);
	expect(run.stdout).toContain("passed");
});

it("blocks inbound clone ownership even when the clone itself is not moved", () => {
	const g = graph();
	g.nodes[2].ownership = ["clone"];
	g.nodes[2].parameterReferences = [
		{
			evidence: "observed",
			mode: "constant",
			name: "clone",
			targetPaths: [g.nodes[0].path],
		},
	];
	expect(
		planRefactor(g, {
			name: "audio",
			paths: [g.nodes[0].path],
		}).blockedReasons.join(),
	).toContain("owner has unsupported");
});

it("accepts native incremented saves only inside a fresh owned filename namespace", () => {
	const definitions = buildCanaryScript().split(
		"result=json.dumps(_r_canary())",
	)[0];
	expect(definitions).toContain(String.raw`r'(?:\.[0-9]+)?\.toe'`);
	const fake = `
import os,tempfile,hashlib
from types import SimpleNamespace
with tempfile.TemporaryDirectory() as directory:
 original=os.path.join(directory,'original.toe')
 with open(original,'wb') as f:f.write(b'original')
 original_receipt=_r_file_receipt(original)
 class Project:
  mode='increment';calls=0
  def save(self,requested,saveExternalToxs=True):
   assert saveExternalToxs is False
   self.calls+=1
   actual=requested[:-4]+'.1.toe'
   if self.mode=='outside':actual=os.path.join(directory,'unrelated.toe')
   if self.mode=='wildcard-dots':actual=requested[:-4]+'X1Ytoe'
   with open(requested,'wb') as f:f.write(b'link to numbered native save')
   if self.mode=='symlink':os.symlink(original,actual)
   elif self.mode=='hardlink':os.link(original,actual)
   else:
    with open(actual,'wb') as f:f.write(b'actual native project')
   if self.mode=='empty':
    with open(requested,'wb') as f:pass
   if self.mode=='original-change':
    with open(original,'wb') as f:f.write(b'changed by callback')
   self.folder,self.name=os.path.split(actual)
   return True
 project=Project()
 wanted=os.path.join(directory,'owned_checkpoint.toe')
 receipt=_r_save_copy(wanted,original_receipt)
 assert receipt['requested']==wanted and receipt['actual']==wanted[:-4]+'.1.toe'
 assert receipt['files'][0]['sha256']!=receipt['files'][1]['sha256'] # native link file need not be byte-identical
 assert _r_file_receipt(original)==original_receipt
 try:_r_save_copy(wanted,original_receipt);raise AssertionError('Existing namespace accepted')
 except RuntimeError as e:assert 'NONOVERWRITE_PATH_EXISTS' in str(e)
 assert project.calls==1
 for mode,error in [('symlink','SAVE_FILE_NOT_REGULAR'),('hardlink','SAVE_ALIASES_ORIGINAL'),('outside','ACTIVE_COPY_NOT_CONFIRMED'),('wildcard-dots','ACTIVE_COPY_NOT_CONFIRMED'),('empty','SAVE_FILE_EMPTY'),('original-change','ORIGINAL_FILE_CHANGED')]:
  project.mode=mode
  requested=os.path.join(directory,mode+'.toe')
  try:_r_save_copy(requested,original_receipt);raise AssertionError('Unsafe save accepted: '+mode)
  except RuntimeError as e:assert error in str(e),(mode,str(e))
 print('native-increment-save fake passed')
`;
	const run = spawnSync("python3", ["-c", definitions + fake], {
		encoding: "utf8",
	});
	expect(run.status, run.stderr).toBe(0);
	expect(run.stdout).toContain("native-increment-save fake passed");
});

it("journals requested and actual native save paths without losing the checkpoint receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "refactor-test-"));
	try {
		const p = planRefactor(graph(), {
			name: "audio",
			paths: [graph().nodes[0].path],
		});
		const execute = vi.fn().mockResolvedValue({
			checkpoint: "/tmp/native.checkpoint.1.toe",
			checkpointSave: {
				actual: "/tmp/native.checkpoint.1.toe",
				files: [],
				requested: "/tmp/native.checkpoint.toe",
			},
			id: p.id,
			phase: "saved",
			sessionId: "s",
			staged: "/tmp/native.staged.1.toe",
			state: "complete",
		});
		const result = await new RefactorStager({ execute }, root).stage(
			p,
			graph(),
		);
		expect(result.checkpointRequested).toContain(p.id);
		expect(result.stagedRequested).toContain(p.id);
		expect(result.checkpoint).toBe("/tmp/native.checkpoint.1.toe");
		const journal = JSON.parse(
			await readFile(join(root, "refactor", `${p.id}.json`), "utf8"),
		);
		expect(journal.checkpointSave.actual).toBe(result.checkpoint);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
