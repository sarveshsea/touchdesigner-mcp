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

function actualBridgePayload() {
	const setup = `
from types import SimpleNamespace
class Node:
 id=1; path='/project'; name='project'; family='COMP'; type='base'; opType='baseCOMP'
 children=[]; tags=[]; inputConnectors=[]; inputCOMPConnectors=[]
 def pars(self): return []
node=Node()
def op(path): return node if path=='/project' else None
project=SimpleNamespace(folder='/synthetic/project',name='identity-test.toe')
app=SimpleNamespace(build=202533230)
`;
	const script = buildGraphPageScript({
		items: [{ path: "/project" }],
		rootPath: "/project",
	});
	return JSON.parse(
		execFileSync(
			"python3",
			["-c", `${setup}\nexec(${JSON.stringify(script)})\nprint(result)`],
			{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
		),
	);
}
describe("real graph payload to local project memory contract", () => {
	it("retains notes across new bridge sessions with the same saved project path", async () => {
		const state = await mkdtemp(join(tmpdir(), "td-graph-memory-"));
		try {
			const store = new MemoryStore(state);
			const first = await collectProjectGraph(
				{ execute: async () => actualBridgePayload() },
				{ rootPath: "/project" },
			);
			const retained = await store.observeGraph(first);
			await store.record({
				action: "record",
				kind: "observed",
				projectId: first.projectId,
				text: "Synthetic graph integration evidence.",
				title: "Stable project note",
			});
			const reopened = await collectProjectGraph(
				{ execute: async () => actualBridgePayload() },
				{ rootPath: "/project" },
			);
			await store.observeGraph(reopened);
			expect(reopened.sessionId).not.toBe(first.sessionId);
			expect(reopened.projectId).toBe(first.projectId);
			expect(retained.build).toBe("202533230");
			expect(
				(await store.query({ projectId: reopened.projectId })).records,
			).toHaveLength(1);
		} finally {
			await rm(state, { force: true, recursive: true });
		}
	});
});
