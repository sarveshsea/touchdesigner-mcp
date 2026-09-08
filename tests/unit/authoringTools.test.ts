import { describe, expect, it, vi } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/features/tools/toolDefinitions.js";
import type { TouchDesignerClient } from "../../src/tdClient/touchDesignerClient.js";

for (const name of ["get_td_network_snapshot", "layout_td_network"]) {
	describe(name, () => {
		const get = () => {
			const definition = TOOL_DEFINITIONS.find((entry) => entry.name === name);
			if (!definition) throw new Error(`Missing ${name}`);
			return definition;
		};
		it("registers a bounded parent-scoped tool", () => {
			const schema = get().schema;
			expect(schema.safeParse({ parentPath: "/project1" }).success).toBe(true);
			expect(schema.safeParse({ parentPath: "" }).success).toBe(false);
		});
		it("returns the JSON report without execution stdout", async () => {
			const execPythonScript = vi.fn().mockResolvedValue({
				data: { result: '{"ok":true}', stdout: "unrelated private text" },
				success: true,
			});
			const result = await get().run({
				logger: { sendLog() {} },
				params: { parentPath: "/project1" },
				tdClient: { execPythonScript } as unknown as TouchDesignerClient,
			});
			expect(JSON.parse(result as string)).toEqual({ ok: true });
			expect(execPythonScript).toHaveBeenCalledTimes(1);
		});
		it("fails explicitly for malformed reports and bridge failures", async () => {
			for (const response of [
				{ data: { result: "not json" }, success: true },
				{ error: new Error("Bridge offline"), success: false },
			]) {
				await expect(
					get().run({
						logger: { sendLog() {} },
						params: { parentPath: "/project1" },
						tdClient: {
							execPythonScript: vi.fn().mockResolvedValue(response),
						} as unknown as TouchDesignerClient,
					}),
				).rejects.toThrow();
			}
		});
	});
}
