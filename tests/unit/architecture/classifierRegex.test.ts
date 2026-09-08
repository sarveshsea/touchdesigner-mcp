import { describe, expect, it } from "vitest";
import { runRegexRules } from "../../../src/architecture/classifier/regex.js";

describe("isolated regular expression matching", () => {
	it("matches regular rules in a worker", async () => {
		const result = await runRegexRules(
			[{ id: "audio", nameRegex: "^audio" }],
			[
				{ name: "audio_in", path: "/a" },
				{ name: "noise", path: "/b" },
			],
			1000,
		);
		expect(result.matches).toEqual([[0, 0]]);
		expect(result.warnings).toEqual([]);
	});
	it("reports invalid and oversized patterns without executing them", async () => {
		const result = await runRegexRules(
			[
				{ id: "invalid", nameRegex: "[" },
				{ id: "oversized", nameRegex: "x".repeat(300) },
			],
			[{ name: "x", path: "/x" }],
			1000,
		);
		expect(result.matches).toEqual([]);
		expect(result.warnings.join(" ")).toContain("invalid");
		expect(result.warnings.join(" ")).toContain("oversized");
	});
	it("terminates catastrophic matching without blocking the main thread", async () => {
		const start = Date.now();
		let heartbeat = false;
		setTimeout(() => {
			heartbeat = true;
		}, 5);
		const result = await runRegexRules(
			[{ id: "catastrophic", nameRegex: "^(a+)+$" }],
			[{ name: `${"a".repeat(200)}!`, path: "/x" }],
			100,
		);
		expect(heartbeat).toBe(true);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(result.warnings.join(" ")).toContain("timeout");
		expect(result.matches).toEqual([]);
	});
});

describe("regex workload budgets", () => {
	it("does not start workers for empty inputs", async () => {
		expect(await runRegexRules([], [{ name: "a", path: "/a" }])).toEqual({
			matches: [],
			warnings: [],
		});
		expect(await runRegexRules([{ id: "a", nameRegex: "a" }], [])).toEqual({
			matches: [],
			warnings: [],
		});
	});
	it("bounds rule count, matching result count, and path selectors", async () => {
		const result = await runRegexRules(
			Array.from({ length: 33 }, (_, i) => ({ id: `${i}`, pathRegex: "^/a" })),
			[{ name: "x", path: "/a" }],
			Number.NaN,
		);
		expect(result.matches).toHaveLength(32);
		expect(result.warnings.join(" ")).toContain("rule limit");
	});
	it("bounds serialized input before dispatching to the worker", async () => {
		const result = await runRegexRules(
			[{ id: "x", nameRegex: "not-found" }],
			Array.from({ length: 5001 }, () => ({
				name: "x".repeat(512),
				path: "/".repeat(2048),
			})),
			1000,
		);
		expect(result.matches).toEqual([]);
		expect(result.warnings.join(" ")).toContain("input budget");
	});
});

describe("regex worker concurrency", () => {
	it("caps simultaneous workers and releases capacity after timeout", async () => {
		const rules = [{ id: "slow", nameRegex: "^(a+)+$" }];
		const nodes = [{ name: `${"a".repeat(200)}!`, path: "/a" }];
		const [first, second, excess] = await Promise.all([
			runRegexRules(rules, nodes, 100),
			runRegexRules(rules, nodes, 100),
			runRegexRules(rules, nodes, 100),
		]);
		expect(first.warnings.join(" ")).toContain("timeout");
		expect(second.warnings.join(" ")).toContain("timeout");
		expect(excess.warnings.join(" ")).toContain("busy");
		expect(
			(
				await runRegexRules(
					[{ id: "fast", nameRegex: "^a" }],
					[{ name: "a", path: "/a" }],
					1000,
				)
			).matches,
		).toEqual([[0, 0]]);
	});
});
