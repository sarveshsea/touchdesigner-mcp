import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	planRefactor,
	RefactorStager,
	type RefactorTransaction,
} from "../../../src/architecture/refactor/index.js";
import {
	comparisonPreview,
	renderRefactorComparison,
} from "../../../src/architecture/refactor/report.js";
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
			fingerprint: "hash",
			flags: {},
			id: 1,
			name: "audio",
			nodeX: 0,
			nodeY: 0,
			opType: "nullCHOP",
			ownership: [],
			parameterReferences: [],
			parentPath: "/project1/nested",
			path: "/project1/nested/audio",
			sourceHashes: {},
			tags: [],
		},
	],
	observedAt: "now",
	projectId: "project",
	projectPath: "/tmp/art.toe",
	revision: 2,
	rootPath: "/",
	schemaVersion: 1,
	sessionId: "session",
	status: "fresh",
	warnings: [],
});
const plan = () =>
	planRefactor(graph(), {
		name: "analysis",
		paths: ["/project1/nested/audio"],
	});
const receipt = () => ({
	checkpoint: "/tmp/art.checkpoint.1.toe",
	containerPath: "/project1/nested/analysis",
	id: plan().id,
	phase: "saved",
	sessionId: "session",
	staged: "/tmp/art.staged.1.toe",
	state: "complete" as const,
});

describe("private refactor comparison reports", () => {
	it("writes a deterministic private before/after report beside the successful JSON receipt", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-report-"));
		try {
			const execute = vi.fn().mockResolvedValue({
				...receipt(),
				arbitrarySource: "SECRET_SOURCE",
				error: "SECRET_TOKEN",
			});
			const stager = new RefactorStager({ execute }, root);
			const result = await stager.stage(plan(), graph());
			const file = join(root, "refactor", `${plan().id}.md`);
			const text = await readFile(file, "utf8");
			expect(result.comparisonReport).toBe("written");
			expect(text).toContain("/project1/nested/audio");
			expect(text).toContain("/project1/nested/analysis/audio");
			expect(text).toContain("Transaction receipt: complete");
			expect(text).not.toMatch(/SECRET_SOURCE|SECRET_TOKEN/);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			await stager.status(plan().id);
			expect(await readFile(file, "utf8")).toBe(text);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("does not create a success report for failed or uncertain receipts", async () => {
		for (const response of [{ ...receipt(), state: "failed" }, null]) {
			const root = await mkdtemp(join(tmpdir(), "refactor-report-"));
			try {
				await new RefactorStager(
					{ execute: vi.fn().mockResolvedValue(response) },
					root,
				).stage(plan(), graph());
				await expect(
					readFile(join(root, "refactor", `${plan().id}.md`)),
				).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await rm(root, { force: true, recursive: true });
			}
		}
	});
	it("retains comparison data across lost-response reconciliation without retrying a mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-report-"));
		try {
			const execute = vi
				.fn()
				.mockRejectedValueOnce(new Error("timeout"))
				.mockResolvedValueOnce(receipt());
			await new RefactorStager({ execute }, root).stage(plan(), graph());
			const final = await new RefactorStager({ execute }, root).status(
				plan().id,
			);
			expect(final?.comparisonReport).toBe("written");
			expect(
				await readFile(join(root, "refactor", `${plan().id}.md`), "utf8"),
			).toContain("/project1/nested/analysis/audio");
			expect(execute.mock.calls[1][0]).not.toContain("collapseSelected");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("keeps confirmed completion when writing the human report fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-report-"));
		try {
			await mkdir(join(root, "refactor", `${plan().id}.md`), {
				recursive: true,
			});
			const final = await new RefactorStager(
				{ execute: vi.fn().mockResolvedValue(receipt()) },
				root,
			).stage(plan(), graph());
			expect(final.state).toBe("complete");
			expect(final.comparisonReport).toBe("unavailable");
			expect(
				JSON.parse(
					await readFile(join(root, "refactor", `${plan().id}.json`), "utf8"),
				).state,
			).toBe("complete");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("renders capped boundary and reference comparisons with escaped cells and a byte budget", () => {
		const p = plan();
		const preview = comparisonPreview({
			...p,
			ports: [
				{
					direction: "in",
					edges: [
						{
							evidence: "observed",
							id: "wire",
							inputIndex: 0,
							kind: "wire",
							outputIndex: 2,
							source: "/project1/source",
							target: "/project1/nested/audio",
						},
					],
					order: 0,
					outputIndex: 2,
					source: "/project1/source",
				},
			],
			repairs: [
				{
					owner: "/project1/consumer",
					parameter: "chop",
					targetsAfter: ["/project1/nested/analysis/audio"],
					targetsBefore: ["/project1/nested/audio"],
				},
			],
		});
		const text = renderRefactorComparison({
			...receipt(),
			comparison: preview,
		});
		expect(text).toContain("/project1/source");
		expect(text).toContain("/project1/consumer / chop");
		const huge = comparisonPreview({
			...p,
			affectedPaths: Array.from(
				{ length: 5000 },
				() => `/project1/nested/audio/${"<script>".repeat(70)}`,
			),
		});
		const capped = renderRefactorComparison({ ...receipt(), comparison: huge });
		expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(65536);
		expect(capped).toContain("report budget");
		expect(capped).not.toContain("<script>");
		expect(
			renderRefactorComparison({
				...receipt(),
				comparison: preview,
				phase: "verified",
			}),
		).toBeNull();
	});
	it("never downgrades the authoritative complete receipt when ancillary report-status persistence fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "refactor-report-"));
		try {
			const execute = vi.fn().mockResolvedValue(receipt());
			const stager = new RefactorStager({ execute }, root);
			const seam = stager as unknown as {
				persist(record: RefactorTransaction, initial?: boolean): Promise<void>;
			};
			const persist = seam.persist.bind(stager);
			vi.spyOn(seam, "persist").mockImplementation(async (record, initial) => {
				if (record.comparisonReport)
					throw new Error("ancillary journal write unavailable");
				return persist(record, initial);
			});
			const result = await stager.stage(plan(), graph());
			expect(result.state).toBe("complete");
			expect(result.comparisonStatusPersisted).toBe(false);
			const saved = JSON.parse(
				await readFile(join(root, "refactor", `${plan().id}.json`), "utf8"),
			);
			expect(saved.state).toBe("complete");
			expect(saved.comparisonReport).toBeUndefined();
			expect(
				await readFile(join(root, "refactor", `${plan().id}.md`), "utf8"),
			).toContain("Transaction receipt: complete");
			expect((await stager.stage(plan(), graph())).state).toBe("complete");
			expect(execute).toHaveBeenCalledTimes(1);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	it("caps comparison rows and bytes and refuses mismatched or incomplete receipts", () => {
		const p = plan();
		const preview = comparisonPreview({
			...p,
			affectedPaths: Array.from(
				{ length: 5000 },
				(_, i) => `/project1/nested/audio/child${i}`,
			),
		});
		const result = { ...receipt(), comparison: preview };
		const text = renderRefactorComparison(result);
		expect(preview.paths).toHaveLength(64);
		expect(text).toContain("4936 additional");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
		expect(renderRefactorComparison({ ...result, state: "failed" })).toBeNull();
		expect(
			renderRefactorComparison({ ...result, sessionId: "other" }),
		).toBeNull();
		expect(renderRefactorComparison({ ...result, id: "other" })).toBeNull();
	});
});
