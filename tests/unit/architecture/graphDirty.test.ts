import { describe, expect, it, vi } from "vitest";
import {
	drainGraphDirtyEvents,
	markGraphDirty,
} from "../../../src/architecture/graph/index.js";
import type { ProjectGraph } from "../../../src/architecture/types.js";

const graph: ProjectGraph = {
	build: "1",
	complete: true,
	coverage: { remaining: 0, truncated: false, visited: 0 },
	dependencyComplete: true,
	edges: [],
	nodes: [],
	observedAt: "then",
	projectId: "p",
	projectPath: "file",
	revision: 2,
	rootPath: "/",
	schemaVersion: 1,
	sessionId: "s",
	status: "fresh",
	warnings: [],
};
const batch = {
	dirty_revision: 1,
	dropped: 0,
	events: [],
	project_identity: "p",
	remaining: 0,
	session_id: "s",
};
describe("observer dirty ledger compatibility", () => {
	it("preserves observation timestamp and revision when marking dirty", () => {
		const next = markGraphDirty(graph, {
			...batch,
			events: [
				{ at: 1, kind: "wire", parentPath: "/", path: "/a", revision: 2 },
			],
		});
		expect(next.status).toBe("stale");
		expect(next.observedAt).toBe("then");
		expect(next.revision).toBe(2);
		expect(graph.status).toBe("fresh");
	});
	it("invalidates closure on overflow or session replacement", () => {
		expect(markGraphDirty(graph, { ...batch, dropped: 1 }).complete).toBe(
			false,
		);
		expect(
			markGraphDirty(graph, { ...batch, session_id: "new" }).dependencyComplete,
		).toBe(false);
	});
	it("retains quiet state without claiming additional coverage", () => {
		expect(markGraphDirty(graph, batch)).toBe(graph);
		expect(markGraphDirty(graph, { ...batch, active: false }).status).toBe(
			"stale",
		);
	});
	it("uses bounded drain without installing a watcher", async () => {
		const execute = vi.fn().mockResolvedValue(JSON.stringify(batch));
		expect(await drainGraphDirtyEvents({ execute }, 32)).toEqual(batch);
		expect(execute.mock.calls[0][0]).toContain("_dm.drain(32)");
		expect(execute.mock.calls[0][0]).not.toContain(".start(");
		await expect(drainGraphDirtyEvents({ execute }, 1025)).rejects.toThrow();
	});
});
