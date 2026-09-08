import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/architecture/memory/index.js";
import type { ProjectGraph } from "../../../src/architecture/types.js";

const projectId = "a".repeat(64);
const otherProject = "b".repeat(64);
const fingerprint = "c".repeat(64);
function graph(overrides: Partial<ProjectGraph> = {}): ProjectGraph {
	return {
		build: "2025.33230",
		complete: true,
		coverage: { remaining: 0, truncated: false, visited: 1 },
		dependencyComplete: true,
		edges: [],
		nodes: [
			{
				family: "TOP",
				fingerprint,
				flags: {},
				id: 1,
				name: "out",
				nodeX: 0,
				nodeY: 0,
				opType: "nullTOP",
				ownership: [],
				parentPath: "/project1",
				path: "/project1/out",
				tags: [],
			},
		],
		observedAt: "2026-09-08T10:00:00.000Z",
		projectId,
		projectPath: "/private/art.toe",
		revision: 1,
		rootPath: "/project1",
		schemaVersion: 1,
		sessionId: "session-1",
		status: "fresh",
		warnings: [],
		...overrides,
	};
}
let directory: string;
let store: MemoryStore;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "td-memory-"));
	store = new MemoryStore(directory);
});
afterEach(async () => {
	await rm(directory, { force: true, recursive: true });
});
async function record(
	text = "Keep the output independent of the control panel.",
) {
	return store.record({
		action: "record",
		kind: "decision",
		projectId,
		text,
		title: "Output ownership",
	});
}

describe("private architecture memory", () => {
	it("accepts scanner UUID project identities and numeric TD build strings", async () => {
		const scannerId = "bc6e5303-765d-4cd2-a02e-1c2f06b67e94";
		const observed = await store.observeGraph(
			graph({ build: "202533230", projectId: scannerId }),
		);
		await store.record({
			action: "record",
			kind: "verified",
			projectId: scannerId,
			provenance: {
				build: "202533230",
				fingerprint: observed.graphFingerprint,
				sourceIdentity: observed.sourceIdentity,
			},
			text: "Checked current topology.",
			title: "Scanner evidence",
		});
		expect(
			(await store.query({ projectId: scannerId })).records[0].freshness,
		).toBe("current");
	});

	it("isolates projects and promotes to personal memory only by explicit action", async () => {
		const note = await record();
		expect((await store.query({ projectId })).records).toHaveLength(1);
		expect(
			(await store.query({ projectId: otherProject })).records,
		).toHaveLength(0);
		expect(
			(await store.query({ projectId, scope: "personal" })).records,
		).toHaveLength(0);
		await expect(
			store.record({
				action: "record",
				kind: "decision",
				projectId,
				scope: "personal",
				text: "Implicit promotion",
				title: "No",
			}),
		).rejects.toThrow();
		const promoted = await store.record({
			action: "promote",
			id: note.id,
			projectId,
		});
		expect(promoted.promotedFrom).toEqual({
			id: note.id,
			projectId,
			version: 1,
		});
		expect(
			(await store.query({ projectId, scope: "personal" })).records,
		).toHaveLength(1);
		await store.record({ action: "promote", id: note.id, projectId });
		expect(
			(await store.query({ projectId, scope: "personal" })).records,
		).toHaveLength(1);
	});

	it("versions corrections and retirement without modifying the original result", async () => {
		const note = await record();
		const corrected = await store.record({
			action: "correct",
			id: note.id,
			projectId,
			text: "Use a dedicated output COMP.",
		});
		expect(corrected.version).toBe(2);
		expect(note.version).toBe(1);
		expect(note.text).not.toBe(corrected.text);
		await store.record({ action: "retire", id: note.id, projectId });
		expect((await store.query({ projectId })).records).toHaveLength(0);
		const retired = await store.query({ includeRetired: true, projectId });
		expect(retired.records[0].status).toBe("retired");
		expect(retired.records[0].version).toBe(3);
	});

	it("derives staleness from observed build, source identity, and node fingerprint", async () => {
		const evidence = await store.observeGraph(graph());
		await store.record({
			action: "record",
			kind: "verified",
			projectId,
			provenance: {
				build: evidence.build,
				fingerprint,
				nodePath: "/project1/out",
				sourceIdentity: evidence.sourceIdentity,
			},
			text: "A preview confirmed the output.",
			title: "Output verified",
		});
		expect((await store.query({ projectId })).records[0].freshness).toBe(
			"current",
		);
		await store.observeGraph(
			graph({ nodes: [{ ...graph().nodes[0], fingerprint: "d".repeat(64) }] }),
		);
		expect(
			(await store.query({ projectId })).records[0].staleReasons,
		).toContain("fingerprint-changed");
		await store.observeGraph(graph({ build: "2025.33231" }));
		expect(
			(await store.query({ projectId })).records[0].staleReasons,
		).toContain("build-changed");
		await store.observeGraph(graph({ projectPath: "/private/different.toe" }));
		expect(
			(await store.query({ projectId })).records[0].staleReasons,
		).toContain("source-changed");
	});

	it("keeps incomplete, stale or disconnected graphs from claiming current verification", async () => {
		const evidence = await store.observeGraph(graph());
		await store.record({
			action: "record",
			kind: "verified",
			projectId,
			provenance: {
				build: evidence.build,
				fingerprint: evidence.graphFingerprint,
				sourceIdentity: evidence.sourceIdentity,
			},
			text: "Verified nodes.",
			title: "Graph check",
		});
		await store.observeGraph(graph({ complete: false, status: "stale" }));
		expect((await store.query({ projectId })).records[0].freshness).toBe(
			"stale",
		);
	});

	it("requires fresh explicit provenance for verified corrections and handles missing nodes", async () => {
		await expect(
			store.record({
				action: "record",
				kind: "verified",
				projectId,
				text: "Not established.",
				title: "No evidence",
			}),
		).rejects.toThrow("provenance");
		const evidence = await store.observeGraph(graph());
		const note = await store.record({
			action: "record",
			kind: "verified",
			projectId,
			provenance: {
				build: evidence.build,
				fingerprint,
				nodePath: "/project1/out",
				sourceIdentity: evidence.sourceIdentity,
			},
			text: "Observed output.",
			title: "Check",
		});
		await expect(
			store.record({
				action: "correct",
				id: note.id,
				kind: "verified",
				projectId,
				text: "Changed claim.",
			}),
		).rejects.toThrow("provenance");
		await store.observeGraph(graph({ nodes: [] }));
		expect(
			(await store.query({ projectId })).records[0].staleReasons,
		).toContain("node-missing");
		const correction = await store.record({
			action: "correct",
			id: note.id,
			projectId,
			text: "Tentative claim.",
		});
		expect(correction.kind).toBe("inferred");
		expect((await store.query({ projectId })).records[0].freshness).toBe(
			"unverified",
		);
	});

	it("retains wires without expressions and validates graph source identity", async () => {
		const withEdge = graph({
			edges: [
				{
					evidence: "static",
					id: "e1",
					kind: "expression",
					reason: "secret executable expression omitted",
					source: "/project1/out",
					target: "/project1/input",
				},
			],
			nodes: [
				...graph().nodes,
				{ ...graph().nodes[0], id: 2, name: "input", path: "/project1/input" },
			],
		});
		const first = await store.observeGraph(withEdge);
		expect(first.edges).toHaveLength(1);
		expect(JSON.stringify(first)).not.toContain("executable");
		const restarted = await store.observeGraph({
			...withEdge,
			sessionId: "restarted",
		});
		expect(restarted.sourceIdentity).toBe(first.sourceIdentity);
		await expect(
			store.observeGraph(graph({ projectPath: "x".repeat(4097) })),
		).rejects.toThrow("identity");
	});

	it("retains a bounded source-free projection of a 50k-node graph", async () => {
		const nodes = Array.from({ length: 50000 }, (_, index) => ({
			...graph().nodes[0],
			id: index,
			name: `n${index}`,
			path: `/project1/n${index}`,
			storage: { token: "NEVER RETAIN STORAGE" },
			text: "NEVER RETAIN SOURCE",
		}));
		const edges = Array.from({ length: 20000 }, (_, index) => ({
			evidence: "observed" as const,
			id: `e${index}`,
			kind: "wire" as const,
			source: nodes[index % 4096].path,
			target: nodes[(index + 1) % 4096].path,
		}));
		const observed = await store.observeGraph(graph({ edges, nodes }));
		expect(observed.nodes).toHaveLength(4096);
		expect(observed.edges).toHaveLength(16384);
		expect(observed).toMatchObject({
			complete: false,
			dependencyComplete: false,
			originalCounts: { edges: 20000, nodes: 50000 },
		});
		const paths = new Set(observed.nodes.map((node) => node.path));
		expect(
			observed.edges.every(
				(edge) => paths.has(edge.source) && paths.has(edge.target),
			),
		).toBe(true);
		const saved = await readFile(
			join(directory, "projects", projectId, "graph.json"),
			"utf8",
		);
		expect(saved).not.toContain("NEVER RETAIN");
		expect(Buffer.byteLength(saved)).toBeLessThan(4 * 1024 * 1024);
		await record();
		expect((await new MemoryStore(directory).query({ projectId })).total).toBe(
			1,
		);
	});

	it("keeps structural observations and decisions current with shallow dependency analysis", async () => {
		const observed = await store.observeGraph(
			graph({ dependencyComplete: false }),
		);
		for (const kind of [
			"observed",
			"decision",
			"inferred",
			"verified",
		] as const) {
			await store.record({
				action: "record",
				kind,
				projectId,
				provenance: {
					build: observed.build,
					fingerprint,
					nodePath: "/project1/out",
					sourceIdentity: observed.sourceIdentity,
				},
				text: "Output topology evidence.",
				title: kind,
			});
		}
		const records = (await store.query({ projectId })).records;
		for (const kind of ["observed", "decision"])
			expect(records.find((note) => note.kind === kind)?.freshness).toBe(
				"current",
			);
		for (const kind of ["verified", "inferred"])
			expect(records.find((note) => note.kind === kind)?.freshness).toBe(
				"stale",
			);
		await store.observeGraph(
			graph({ complete: false, dependencyComplete: false }),
		);
		expect(
			(await store.query({ projectId })).records.every(
				(note) => note.freshness === "stale",
			),
		).toBe(true);
	});

	it("bounds maximum-length graph paths by bytes and excludes edges outside the retained index", async () => {
		const nodes = Array.from({ length: 4096 }, (_, index) => ({
			...graph().nodes[0],
			id: index,
			parentPath: `/project1/${"segment/".repeat(60)}`,
			path: `/project1/${"segment/".repeat(60)}n${index}`,
		}));
		const edge = {
			evidence: "observed" as const,
			id: "edge",
			kind: "wire" as const,
			source: nodes[0].path,
			target: nodes[1].path,
		};
		const retained = await store.observeGraph(
			graph({
				edges: [edge, { ...edge, id: "outside", target: "/outside" }],
				nodes,
			}),
		);
		expect(retained.nodes.length).toBeLessThan(4096);
		expect(retained.complete).toBe(false);
		expect(retained.edges.every((item) => item.target !== "/outside")).toBe(
			true,
		);
		await record();
		expect((await store.query({ projectId })).total).toBe(1);
		const edgeLimited = await store.observeGraph(
			graph({
				edges: Array.from({ length: 16000 }, () => edge),
				nodes: nodes.slice(0, 2),
			}),
		);
		expect(edgeLimited.edges.length).toBeLessThan(16000);
		expect(edgeLimited).toMatchObject({
			complete: false,
			dependencyComplete: false,
		});
	});

	it("still invalidates shallow structural notes on changed identity, build, fingerprint or status", async () => {
		const observed = await store.observeGraph(
			graph({ dependencyComplete: false }),
		);
		await store.record({
			action: "record",
			kind: "observed",
			projectId,
			provenance: {
				build: observed.build,
				fingerprint,
				nodePath: "/project1/out",
				sourceIdentity: observed.sourceIdentity,
			},
			text: "Observed output.",
			title: "Structure",
		});
		const cases: Partial<ProjectGraph>[] = [
			{ status: "disconnected" },
			{ status: "stale" },
			{ status: "scanning" },
			{ complete: false },
			{ build: "2025.33231" },
			{ projectPath: "/private/another.toe" },
			{ nodes: [{ ...graph().nodes[0], fingerprint: "d".repeat(64) }] },
			{ nodes: [] },
		];
		for (const changed of cases) {
			await store.observeGraph(
				graph({ dependencyComplete: false, ...changed }),
			);
			expect((await store.query({ projectId })).records[0].freshness).toBe(
				"stale",
			);
		}
	});

	it("strictly rejects unknown caller metadata and redacts recognizable secrets", async () => {
		await expect(
			store.record({
				action: "record",
				kind: "decision",
				projectId,
				storage: { secret: "hidden" },
				text: "note",
				title: "Unsafe",
			}),
		).rejects.toThrow();
		await record(
			"access_token=secret-value; Bearer abcdefghijklmnopqrstuvwxyz0123456789; client_secret: private123",
		);
		const query = await store.query({ projectId });
		expect(query.records[0].text).toContain("[REDACTED]");
		const json = await readFile(
			join(directory, "projects", projectId, "memory.json"),
			"utf8",
		);
		expect(json).not.toContain("secret-value");
		expect(json).not.toContain("private123");
		expect(json).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		await expect(
			record("```python\nimport os\nprint(os.environ)\n```"),
		).rejects.toThrow();
	});

	it("automatically retains only source-free graph fields and hashes file identity", async () => {
		const unsafe = {
			...graph(),
			nodes: [
				{
					...graph().nodes[0],
					storage: { key: "secret" },
					text: "raw shader code",
				},
			],
			rawDat: "private source",
			storage: { token: "top secret" },
		};
		await store.observeGraph(unsafe);
		const json = await readFile(
			join(directory, "projects", projectId, "graph.json"),
			"utf8",
		);
		expect(json).not.toContain("private source");
		expect(json).not.toContain("raw shader code");
		expect(json).not.toContain("top secret");
		expect(json).not.toContain("/private/art.toe");
		expect(json).toContain("/project1/out");
	});

	it("serializes concurrent writes across store instances and uses private atomic files", async () => {
		const second = new MemoryStore(directory);
		await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				(index % 2 ? store : second).record({
					action: "record",
					kind: "inferred",
					projectId,
					text: "A bounded inference.",
					title: `Observation ${index}`,
				}),
			),
		);
		const results = await store.query({ limit: 50, projectId });
		expect(results.records).toHaveLength(24);
		const folder = join(directory, "projects", projectId);
		expect((await stat(folder)).mode & 0o777).toBe(0o700);
		expect((await stat(join(folder, "memory.json"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(folder, "notes.md"))).mode & 0o777).toBe(0o600);
		expect((await readdir(folder)).some((name) => name.endsWith(".tmp"))).toBe(
			false,
		);
	});

	it("validates traversal, bounds, and refuses symlinked state files", async () => {
		await expect(store.query({ projectId: "../../outside" })).rejects.toThrow();
		await expect(store.query({ limit: 1000, projectId })).rejects.toThrow();
		await expect(record("x".repeat(2001))).rejects.toThrow();
		await record();
		const file = join(directory, "projects", projectId, "memory.json");
		await rm(file);
		await symlink("/etc/passwd", file);
		await expect(store.query({ projectId })).rejects.toThrow();
	});

	it("bounds retention and supports case-insensitive query without regular expressions", async () => {
		for (let i = 0; i < 140; i++)
			await record(i === 139 ? "UNIQUE retained note" : `note ${i}`);
		const all = await store.query({ limit: 50, projectId });
		expect(all.total).toBe(128);
		expect(all.records).toHaveLength(50);
		expect(
			(await store.query({ projectId, search: "unique" })).records,
		).toHaveLength(1);
	});
});
