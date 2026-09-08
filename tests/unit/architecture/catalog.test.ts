import { describe, expect, it, vi } from "vitest";
import { getOperatorCatalog } from "../../../src/architecture/catalog/index.js";

function bridge(build = "2025.33230") {
	const rows = [
		"COMP",
		"TOP",
		"CHOP",
		"POP",
		"DAT",
		"MAT",
		"SOP",
		"CUSTOM",
	].map((family, i) => ({
		family,
		label: `Type ${i}`,
		opType: `type${i}`,
		...(i === 0
			? {
					isFilter: false,
					isSupported: true,
					maxInputs: 0,
					minInputs: 0,
					subType: "panel",
				}
			: {}),
	}));
	return {
		execute: vi.fn(async (script: string) =>
			script.includes("CATALOG_HEADER")
				? {
						build,
						families: rows.map((r) => r.family),
						registryCount: rows.length,
						truncated: false,
					}
				: { build, entries: rows, nextOffset: null, truncated: false },
		),
		rows,
	};
}

describe("operator catalog", () => {
	it("preserves all seven families plus custom and does not invent support or metadata", async () => {
		const b = bridge();
		const result = await getOperatorCatalog(b, {});
		expect(result.families).toEqual(
			expect.arrayContaining([
				"COMP",
				"TOP",
				"CHOP",
				"POP",
				"DAT",
				"MAT",
				"SOP",
				"CUSTOM",
			]),
		);
		expect(result.operators[0]).toMatchObject({
			kind: "generator",
			opType: "type0",
			subType: "panel",
			support: "reported-supported",
			tested: false,
		});
		expect(result.operators[1]).toMatchObject({
			support: "unknown",
			tested: false,
		});
		expect(result.operators[1]).not.toHaveProperty("subType");
		expect(result.operators[1]).not.toHaveProperty("minInputs");
	});
	it("filters and paginates cached data while checking the build on each call", async () => {
		const b = bridge();
		const first = await getOperatorCatalog(b, { limit: 2 });
		expect(first.total).toBe(8);
		expect(first.nextOffset).toBe(2);
		const second = await getOperatorCatalog(b, {
			family: "pop",
			query: "type 3",
		});
		expect(second.operators.map((x) => x.opType)).toEqual(["type3"]);
		expect(b.execute).toHaveBeenCalledTimes(3);
	});
	it("invalidates the cache on build changes and detaches returned rows", async () => {
		const b = bridge();
		const one = await getOperatorCatalog(b, {});
		one.operators[0].label = "changed";
		const two = await getOperatorCatalog(b, {});
		expect(two.operators[0].label).toBe("Type 0");
		b.execute.mockImplementation(async (script) =>
			script.includes("CATALOG_HEADER")
				? {
						build: "2026.1",
						families: ["COMP"],
						registryCount: 8,
						truncated: false,
					}
				: {
						build: "2026.1",
						entries: b.rows,
						nextOffset: null,
						truncated: false,
					},
		);
		expect((await getOperatorCatalog(b, {})).build).toBe("2026.1");
		expect(b.execute).toHaveBeenCalledTimes(5);
	});
	it("rejects invalid bounds before touching the bridge", async () => {
		const b = bridge();
		for (const opts of [
			{ limit: 0 },
			{ limit: 201 },
			{ offset: -1 },
			{ query: "x".repeat(161) },
			{ docRoot: "relative" },
		])
			await expect(getOperatorCatalog(b, opts)).rejects.toThrow();
		expect(b.execute).not.toHaveBeenCalled();
	});
	it("rejects malformed runtime data and impossible pages", async () => {
		const b = bridge();
		b.rows[0].opType = "<script>";
		await expect(getOperatorCatalog(b, {})).rejects.toThrow("catalog");
	});
});

describe("catalog scan boundaries", () => {
	it("decodes JSON bridge responses and labels observed unsupported filters", async () => {
		const executor = {
			execute: vi.fn(async (script: string) =>
				JSON.stringify(
					script.includes("CATALOG_HEADER")
						? {
								build: "1",
								families: ["TOP"],
								registryCount: 1,
								truncated: false,
							}
						: {
								build: "1",
								entries: [
									{
										family: "TOP",
										isFilter: true,
										isSupported: false,
										opType: "disabledTOP",
									},
								],
								nextOffset: null,
								truncated: false,
							},
				),
			),
		};
		const result = await getOperatorCatalog(executor, {});
		expect(result.operators[0]).toMatchObject({
			kind: "filter",
			support: "reported-unsupported",
		});
		expect(result.nextOffset).toBeNull();
	});
	it("scans multiple fixed-size pages and marks bounded discovery incomplete", async () => {
		let calls = 0;
		const executor = {
			execute: vi.fn(async (script: string) => {
				if (script.includes("CATALOG_HEADER"))
					return {
						build: "1",
						families: ["TOP"],
						registryCount: 129,
						truncated: true,
					};
				const first = calls++ === 0;
				return {
					build: "1",
					entries: Array.from({ length: first ? 128 : 1 }, (_, i) => ({
						family: "TOP",
						opType: `op${first ? i : 128}`,
					})),
					nextOffset: first ? 128 : null,
					truncated: true,
				};
			}),
		};
		const result = await getOperatorCatalog(executor, { offset: 128 });
		expect(result.operators[0].opType).toBe("op128");
		expect(result.complete).toBe(false);
		expect(result.warnings).toHaveLength(1);
	});
	it("rejects build changes and malformed cursors during a scan", async () => {
		for (const page of [
			{ build: "changed", entries: [], nextOffset: null, truncated: false },
			{ build: "1", entries: [], nextOffset: 2, truncated: false },
		]) {
			const executor = {
				execute: vi.fn(async (script: string) =>
					script.includes("CATALOG_HEADER")
						? { build: "1", families: [], registryCount: 1, truncated: false }
						: page,
				),
			};
			await expect(getOperatorCatalog(executor, {})).rejects.toThrow(
				"Invalid operator catalog response",
			);
		}
	});
	it("rejects duplicate rows and never retains the failed cache", async () => {
		const executor = {
			execute: vi.fn(async (script: string) =>
				script.includes("CATALOG_HEADER")
					? { build: "1", families: [], registryCount: 2, truncated: false }
					: {
							build: "1",
							entries: [{ opType: "dup" }, { opType: "dup" }],
							nextOffset: null,
							truncated: false,
						},
			),
		};
		await expect(getOperatorCatalog(executor, {})).rejects.toThrow();
		await expect(getOperatorCatalog(executor, {})).rejects.toThrow();
		expect(executor.execute).toHaveBeenCalledTimes(4);
	});
});

it("retains the actual supported integer flag without interpreting arbitrary values", async () => {
	const executor = {
		execute: vi.fn(async (script: string) =>
			script.includes("CATALOG_HEADER")
				? {
						build: "2025.33230",
						families: ["TOP"],
						registryCount: 2,
						truncated: false,
					}
				: {
						build: "2025.33230",
						entries: [
							{ opType: "activeTOP", supported: 1 },
							{ opType: "missingTOP", supported: 0 },
						],
						nextOffset: null,
						truncated: false,
					},
		),
	};
	const r = await getOperatorCatalog(executor, {});
	expect(r.operators[0]).toMatchObject({
		support: "reported-supported",
		supported: 1,
		supportSource: "supported",
	});
	expect(r.operators[1]).toMatchObject({
		support: "reported-unsupported",
		supported: 0,
	});
});
