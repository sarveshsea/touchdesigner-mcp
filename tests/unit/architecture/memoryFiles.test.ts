import { execFileSync } from "node:child_process";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	atomicFile,
	privateDirectory,
	readJson,
	rootPath,
	serialized,
} from "../../../src/architecture/memory/files.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

afterEach(() => vi.restoreAllMocks());
describe("memory filesystem boundaries", () => {
	it("leaves the prior committed file intact and removes temporary output if writing fails", async () => {
		const directory = await files.mkdtemp(join(tmpdir(), "td-memory-file-"));
		const file = join(directory, "state.json");
		await atomicFile(file, '{"version":1}');
		const actualOpen = files.open;
		const spy = vi.spyOn(files, "open").mockImplementation(async (...args) => {
			const handle = await actualOpen(...args);
			if (args[1] === "wx")
				vi.spyOn(handle, "writeFile").mockRejectedValue(
					new Error("Disk write failed"),
				);
			return handle;
		});
		try {
			await expect(atomicFile(file, '{"version":2}')).rejects.toThrow(
				"Disk write failed",
			);
			spy.mockRestore();
			expect(await readJson(file)).toEqual({ version: 1 });
			expect(await files.readdir(directory)).toEqual(["state.json"]);
		} finally {
			await files.rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects relative roots, directory symlinks and oversized writes", async () => {
		expect(() => rootPath("../../state")).toThrow();
		const directory = await files.mkdtemp(join(tmpdir(), "td-memory-file-"));
		try {
			await files.symlink(directory, join(directory, "link"));
			await expect(privateDirectory(join(directory, "link"))).rejects.toThrow();
			await expect(
				atomicFile(join(directory, "large"), "x".repeat(4 * 1024 * 1024 + 1)),
			).rejects.toThrow();
			expect(await readJson(join(directory, "missing"))).toBeNull();
		} finally {
			await files.rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects FIFO memory files without blocking on open", async () => {
		const directory = await files.mkdtemp(join(tmpdir(), "td-memory-fifo-"));
		try {
			const filename = join(directory, "memory.json");
			execFileSync("mkfifo", [filename]);
			await expect(readJson(filename)).rejects.toThrow("not a file");
		} finally {
			await files.rm(directory, { force: true, recursive: true });
		}
	});

	it("allows the next queued request to succeed after an earlier write fails", async () => {
		const failure = serialized("test-key", async () => {
			throw new Error("First failed");
		});
		const success = serialized("test-key", async () => 42);
		await expect(failure).rejects.toThrow("First failed");
		await expect(success).resolves.toBe(42);
	});
});
