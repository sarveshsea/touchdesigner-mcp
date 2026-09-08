import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	graphDigest,
	planRefactor,
	RefactorStager,
} from "../../../src/architecture/refactor/index.js";
import type { ProjectGraph } from "../../../src/architecture/types.js";

const graph = (): ProjectGraph => ({
	build: "2025.33230",
	complete: true,
	coverage: { remaining: 0, truncated: false, visited: 1 },
	dependencyComplete: true,
	edges: [],
	nodes: [
		{
			family: "CHOP",
			fingerprint: "stable-content-v2",
			flags: {},
			id: 1,
			name: "a",
			nodeX: 0,
			nodeY: 0,
			opType: "nullCHOP",
			ownership: [],
			parameterReferences: [],
			parentPath: "/project1",
			path: "/project1/a",
			sourceHashes: {},
			tags: [],
		},
	],
	observedAt: "now",
	projectId: "project",
	projectPath: "/tmp/fixture.toe",
	revision: 1,
	rootPath: "/",
	schemaVersion: 1,
	sessionId: "first-session",
	status: "fresh",
	warnings: [],
});

describe("stable content fingerprints preserve refactor identity guards", () => {
	it.each([
		"replacement",
		"reopen",
	])("rejects %s despite identical node content", async (change) => {
		const root = await mkdtemp(join(tmpdir(), "fingerprint-safety-"));
		try {
			const before = graph();
			const after: ProjectGraph =
				change === "replacement"
					? {
							...before,
							nodes: before.nodes.map((node) => ({ ...node, id: node.id + 1 })),
						}
					: { ...before, sessionId: "reopened-session" };
			expect(after.nodes[0].fingerprint).toBe(before.nodes[0].fingerprint);
			const plan = planRefactor(before, {
				name: "audio",
				paths: [before.nodes[0].path],
			});
			expect(plan.blockedReasons).toEqual([]);
			expect(graphDigest(after)).not.toBe(plan.graphDigest);
			const execute = vi.fn();
			const stager = new RefactorStager({ execute }, root);
			await expect(stager.stage(plan, after)).rejects.toThrow("Stale");
			expect(execute).not.toHaveBeenCalled();
			expect(await readdir(root)).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
