import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	architectureExecutor,
	startDaemon,
} from "../../../src/architecture/daemon.js";
import { TouchDesignerClient } from "../../../src/tdClient/touchDesignerClient.js";

const dirs: string[] = [];
const daemons: Array<Awaited<ReturnType<typeof startDaemon>>> = [];
beforeEach(() => {
	vi.stubEnv("TD_WEB_SERVER_HOST", "http://127.0.0.1");
	vi.stubEnv("TD_WEB_SERVER_PORT", "9981");
	vi.spyOn(TouchDesignerClient.prototype, "execPythonScript").mockRejectedValue(
		new Error("No live bridge calls permitted in this test"),
	);
});
afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close();
	await Promise.all(
		dirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
	);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "td-daemon-test-"));
	dirs.push(path);
	vi.stubEnv("TD_ARCHITECTURE_STATE_DIR", path);
	return path;
}

describe("daemon ownership and local-only startup", () => {
	it("publishes a private authenticated descriptor and removes only its own descriptor", async () => {
		const root = await directory();
		const daemon = await startDaemon();
		const path = join(root, "service.json");
		try {
			const descriptor = JSON.parse(await readFile(path, "utf8"));
			expect(descriptor.pid).toBe(process.pid);
			expect(descriptor.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(descriptor.target).toEqual({
				host: "http://127.0.0.1",
				port: 9981,
			});
			expect((await lstat(path)).mode & 0o777).toBe(0o600);
			const response = await fetch(`${descriptor.url}/health`, {
				headers: { authorization: `Bearer ${descriptor.token}` },
			});
			expect(response.status).toBe(200);
			const state = await fetch(`${descriptor.url}/rpc`, {
				body: JSON.stringify({ method: "inspector_state" }),
				headers: { authorization: `Bearer ${descriptor.token}` },
				method: "POST",
			});
			expect((await state.json()).result.graph).toBeNull();
			expect(
				TouchDesignerClient.prototype.execPythonScript,
			).not.toHaveBeenCalled();
		} finally {
			await daemon.close();
		}
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("preserves a descriptor replaced by another owner during shutdown", async () => {
		const root = await directory();
		const daemon = await startDaemon();
		const path = join(root, "service.json");
		await writeFile(
			path,
			JSON.stringify({ pid: process.pid, token: "replacement" }),
			{ mode: 0o600 },
		);
		await daemon.close();
		expect(JSON.parse(await readFile(path, "utf8")).token).toBe("replacement");
	});
	it("refuses duplicate startup without overwriting the active descriptor", async () => {
		const root = await directory();
		const daemon = await startDaemon();
		daemons.push(daemon);
		const before = await readFile(join(root, "service.json"), "utf8");
		await expect(startDaemon()).rejects.toMatchObject({ code: "EEXIST" });
		expect(await readFile(join(root, "service.json"), "utf8")).toBe(before);
	});
	it("rejects relative, public and symlink state directories", async () => {
		vi.stubEnv("TD_ARCHITECTURE_STATE_DIR", "relative");
		await expect(startDaemon()).rejects.toThrow(/absolute/);
		const root = await directory();
		await chmod(root, 0o755);
		await expect(startDaemon()).rejects.toThrow(/private/);
		await chmod(root, 0o700);
		const link = `${root}-link`;
		dirs.push(link);
		await symlink(root, link);
		vi.stubEnv("TD_ARCHITECTURE_STATE_DIR", link);
		await expect(startDaemon()).rejects.toThrow(/private/);
	});
});

describe("architecture bridge executor", () => {
	it("passes only the script and decodes a successful JSON result", async () => {
		const client = new TouchDesignerClient();
		vi.mocked(client.execPythonScript).mockResolvedValue({
			data: { result: '{"nodes":[]}' },
			success: true,
		} as never);
		expect(await architectureExecutor(client).execute("result='{}'")).toEqual({
			nodes: [],
		});
		expect(client.execPythonScript).toHaveBeenCalledWith({
			script: "result='{}'",
		});
	});
	it("rejects bridge failure, non-string, oversized and malformed data", async () => {
		const client = new TouchDesignerClient();
		for (const response of [
			{ error: "upstream detail", success: false },
			{ data: { result: {} }, success: true },
			{ data: { result: "x".repeat(8 * 1024 * 1024 + 1) }, success: true },
			{ data: { result: "{" }, success: true },
		]) {
			vi.mocked(client.execPythonScript).mockResolvedValueOnce(
				response as never,
			);
			await expect(
				architectureExecutor(client).execute("unused"),
			).rejects.toThrow();
		}
	});
});

describe("daemon target validation", () => {
	it("validates target before creating descriptors or listeners", async () => {
		const root = await directory();
		for (const [host, port] of [
			["not-a-url", "9981"],
			["ftp://127.0.0.1", "9981"],
			["http://user:password@127.0.0.1", "9981"],
			["http://127.0.0.1/path", "9981"],
			["http://127.0.0.1", "NaN"],
			["http://127.0.0.1", "65536"],
			["http://127.0.0.1", "0"],
		]) {
			vi.stubEnv("TD_WEB_SERVER_HOST", host);
			vi.stubEnv("TD_WEB_SERVER_PORT", port);
			await expect(startDaemon()).rejects.toThrow();
		}
		await expect(lstat(join(root, "service.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
