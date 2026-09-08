import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildGraphPageScript,
	collectProjectGraph,
} from "../../../src/architecture/graph/index.js";
import { MemoryStore } from "../../../src/architecture/memory/index.js";

function actualBridgePayload(id = 1, changes = "", legacy = false) {
	const setup = `
from types import SimpleNamespace
class Node:
 id=${id}; path='/'; name='project'; family='COMP'; type='base'; opType='baseCOMP'
 children=[]; tags=[]; inputConnectors=[]; inputCOMPConnectors=[]
 def pars(self): return []
node=Node()
${changes}
def op(path): return node if path=='/' else None
project=SimpleNamespace(folder='/synthetic/project',name='identity-test.toe')
app=SimpleNamespace(build=202533230)
`;
	const currentScript = buildGraphPageScript({
		dependencyAnalysis: true,
		items: [{ path: "/" }],
		rootPath: "/",
	});
	// Reproduce the shipped v1 hashing operation, including runtime identity.
	const script = legacy
		? currentScript.replace(
				/ {4}entry\['fingerprint'\] = .*\n/,
				"    entry['fingerprint'] = _gh(json.dumps(entry,sort_keys=True))\n",
			)
		: currentScript;

	return JSON.parse(
		execFileSync(
			"python3",
			["-c", `${setup}\nexec(${JSON.stringify(script)})\nprint(result)`],
			{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
		),
	);
}
// Verified techniques require a complete root census, not a scoped project scan.
function collect(id = 1, changes = "") {
	return collectProjectGraph(
		{ execute: async () => actualBridgePayload(id, changes) },
		{ dependencyAnalysis: true, rootPath: "/" },
	);
}
describe("real graph payload to local project memory contract", () => {
	it("keeps evidenced notes current across sessions with reassigned runtime operator IDs", async () => {
		const state = await mkdtemp(join(tmpdir(), "td-graph-memory-"));
		try {
			const store = new MemoryStore(state);
			const first = await collect();
			const retained = await store.observeGraph(first);
			for (const kind of ["observed", "decision", "verified"] as const) {
				for (const nodeScoped of [true, false]) {
					await store.record({
						action: "record",
						kind,
						projectId: first.projectId,
						provenance: {
							build: retained.build,
							fingerprint: nodeScoped
								? first.nodes[0].fingerprint
								: retained.graphFingerprint,
							sourceIdentity: retained.sourceIdentity,
							...(nodeScoped ? { nodePath: "/" } : {}),
						},
						text: "Synthetic graph integration evidence.",
						title: `${kind} ${nodeScoped}`,
					});
				}
			}
			const reopened = await collect(999);
			await store.observeGraph(reopened);
			expect(reopened.sessionId).not.toBe(first.sessionId);
			expect(reopened.projectId).toBe(first.projectId);
			expect(reopened.nodes[0].id).not.toBe(first.nodes[0].id);
			const notes = (await store.query({ projectId: reopened.projectId }))
				.records;
			expect(notes).toHaveLength(6);
			expect(
				notes.map((note) => ({
					freshness: note.freshness,
					kind: note.kind,
					reasons: note.staleReasons,
				})),
			).toEqual(
				notes.map((note) => ({
					freshness: "current",
					kind: note.kind,
					reasons: [],
				})),
			);
			await store.observeGraph(
				await collect(999, "node.opType='containerCOMP'"),
			);
			expect(
				(await store.query({ projectId: first.projectId })).records.every(
					(note) => note.staleReasons.includes("fingerprint-changed"),
				),
			).toBe(true);
		} finally {
			await rm(state, { force: true, recursive: true });
		}
	});

	it("does not silently promote legacy ID-bearing provenance to current", async () => {
		const state = await mkdtemp(join(tmpdir(), "td-legacy-memory-"));
		try {
			const store = new MemoryStore(state);
			const prior = await collectProjectGraph(
				{ execute: async () => actualBridgePayload(1, "", true) },
				{ dependencyAnalysis: true, rootPath: "/" },
			);
			const retained = await store.observeGraph(prior);
			await store.record({
				action: "record",
				kind: "verified",
				projectId: prior.projectId,
				provenance: {
					build: retained.build,
					fingerprint: prior.nodes[0].fingerprint,
					nodePath: "/",
					sourceIdentity: retained.sourceIdentity,
				},
				text: "Prior evidence.",
				title: "Legacy verification",
			});
			await store.observeGraph(await collect(1));
			const note = (await store.query({ projectId: prior.projectId }))
				.records[0];
			expect(note.freshness).toBe("stale");
			expect(note.staleReasons).toContain("fingerprint-changed");
			expect(note.provenance?.fingerprint).toBe(prior.nodes[0].fingerprint);
		} finally {
			await rm(state, { force: true, recursive: true });
		}
	});

	it.each([
		"node.nodeX=12",
		"node.viewer=True",
		"node.tags=['changed']",
		"node.opType='containerCOMP'",
	])("retains non-identity fingerprint evidence: %s", (changes) => {
		expect(actualBridgePayload(1, changes).nodes[0].fingerprint).not.toBe(
			actualBridgePayload().nodes[0].fingerprint,
		);
	});

	it("retains source hashes in stable fingerprints", () => {
		const setup =
			"node.family='DAT'; node.type='text'; node.opType='textDAT'; node.text=";
		expect(
			actualBridgePayload(1, `${setup}'value=1'`).nodes[0].fingerprint,
		).not.toBe(
			actualBridgePayload(1, `${setup}'value=2'`).nodes[0].fingerprint,
		);
	});
});
