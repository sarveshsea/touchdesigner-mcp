import * as childProcess from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callArchitecture } from "../../../src/architecture/service/client.js";
import { startArchitectureHttp } from "../../../src/architecture/service/http.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
}));
const token = "a".repeat(64);
const target = { host: "http://127.0.0.1", port: 9981 };
let directory: string;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "td-architecture-client-"));
	vi.stubEnv("TD_ARCHITECTURE_STATE_DIR", directory);
	vi.stubEnv("TD_WEB_SERVER_HOST", undefined);
	vi.stubEnv("TD_WEB_SERVER_PORT", undefined);
	vi.stubEnv("TD_WEB_SERVER_TIMEOUT_MS", undefined);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(directory, { force: true, recursive: true });
});
async function descriptor(url: string, extra: Record<string, unknown> = {}) {
	await writeFile(
		join(directory, "service.json"),
		JSON.stringify({
			pid: process.pid,
			target,
			token,
			url,
			version: "1",
			...extra,
		}),
		{ mode: 0o600 },
	);
}
async function service(
	dispatch = (method: string, _params: Record<string, unknown>) =>
		Promise.resolve({ method }),
) {
	const live = await startArchitectureHttp({ dispatch, token });
	cleanups.push(live.close);
	await descriptor(live.url);
	return live;
}

async function spawnFixture() {
	const fixture = join(directory, "fixture.cjs");
	await writeFile(
		fixture,
		`const fs=require('fs'),http=require('http'),path=require('path');const root=process.env.TD_ARCHITECTURE_STATE_DIR,token='${token}';const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end('{}');return;}let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/health'?{ok:true,result:{service:'td-architecture',protocol:1}}:{ok:true,result:{method:JSON.parse(body).method}}));});});server.listen(0,'127.0.0.1',()=>{const d={url:'http://127.0.0.1:'+server.address().port,token,pid:process.pid,version:'1',target:{host:'http://127.0.0.1',port:9981}};fs.writeFileSync(path.join(root,'service.json'),JSON.stringify(d),{mode:0o600});});`,
	);
	const spawn = childProcess.spawn;
	return vi
		.spyOn(childProcess, "spawn")
		.mockImplementation((command, _args, options) => {
			const child = spawn(command, [fixture], options);
			cleanups.push(async () => {
				if (child.pid) {
					try {
						process.kill(child.pid);
					} catch {}
				}
			});
			return child;
		});
}

describe("shared local architecture client", () => {
	it("reuses an authenticated private descriptor and dispatches one RPC", async () => {
		const calls: unknown[] = [];
		await service(async (method, params) => {
			calls.push({ method, params });
			return { answer: 42 };
		});
		const spawn = vi.spyOn(childProcess, "spawn");
		await expect(
			callArchitecture("get_td_memory", { projectId: "a".repeat(64) }),
		).resolves.toEqual({ answer: 42 });
		expect(calls).toHaveLength(1);
		expect(spawn).not.toHaveBeenCalled();
	});
	it.each([
		"http://localhost:9981",
		"http://127.0.0.2:9981",
		"https://example.com",
		"http://127.0.0.1:9981/path",
		"http://user:pass@127.0.0.1:9981",
	])("rejects unsafe descriptor URL %s before dispatch", async (url) => {
		await descriptor(url);
		const spawn = vi.spyOn(childProcess, "spawn");
		await expect(callArchitecture("get_td_memory", {})).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});
	it("refuses world-readable descriptor files and symlink aliases", async () => {
		const live = await service();
		await chmod(join(directory, "service.json"), 0o644);
		await expect(callArchitecture("get_td_memory", {})).rejects.toThrow(
			/private|permission/i,
		);
		await rm(join(directory, "service.json"));
		const other = join(directory, "other.json");
		await writeFile(
			other,
			JSON.stringify({
				pid: process.pid,
				target,
				token,
				url: live.url,
				version: "1",
			}),
			{ mode: 0o600 },
		);
		await symlink(other, join(directory, "service.json"));
		await expect(callArchitecture("get_td_memory", {})).rejects.toThrow();
	});
	it("rejects FIFO descriptors without blocking", async () => {
		childProcess.execFileSync("mkfifo", [join(directory, "service.json")]);
		await chmod(join(directory, "service.json"), 0o600);
		await expect(callArchitecture("get_td_memory", {})).rejects.toThrow(
			"descriptor file",
		);
	});

	it("rejects a healthy service connected to another TD target", async () => {
		await service();
		vi.stubEnv("TD_WEB_SERVER_PORT", "9999");
		const spawn = vi.spyOn(childProcess, "spawn");
		await expect(callArchitecture("get_td_memory", {})).rejects.toThrow(
			/target/i,
		);
		expect(spawn).not.toHaveBeenCalled();
	});
	it("starts exactly one real subprocess for concurrent first requests", async () => {
		const spawn = await spawnFixture();
		const values = await Promise.all(
			Array.from({ length: 6 }, () => callArchitecture("inspector_state", {})),
		);
		expect(values).toEqual(
			Array.from({ length: 6 }, () => ({ method: "inspector_state" })),
		);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0][2]).toMatchObject({
			detached: true,
			stdio: "ignore",
		});
		expect(
			JSON.parse(await readFile(join(directory, "service.json"), "utf8")).pid,
		).not.toBe(process.pid);
	});
	it("recovers a dead PID descriptor and abandoned startup lock without killing other processes", async () => {
		await descriptor("http://127.0.0.1:1", { pid: 2147483647 });
		await mkdir(join(directory, ".startup-lock"), { mode: 0o700 });
		await writeFile(
			join(directory, ".startup-lock", "owner.json"),
			JSON.stringify({ id: "stale", pid: 2147483647 }),
			{ mode: 0o600 },
		);
		const spawn = await spawnFixture();
		await expect(callArchitecture("inspector_state", {})).resolves.toEqual({
			method: "inspector_state",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});
	it("retains the child startup lock if a live daemon never publishes readiness", async () => {
		const fixture = join(directory, "unready.cjs");
		await writeFile(fixture, "setInterval(()=>{},1000);");
		const spawn = childProcess.spawn;
		let pid = 0;
		vi.spyOn(childProcess, "spawn").mockImplementation(
			(command, _args, options) => {
				const child = spawn(command, [fixture], options);
				pid = child.pid ?? 0;
				cleanups.push(async () => {
					if (pid) {
						try {
							process.kill(pid);
						} catch {}
					}
				});
				return child;
			},
		);
		await expect(callArchitecture("inspector_state", {})).rejects.toThrow(
			"did not become ready",
		);
		const owner = JSON.parse(
			await readFile(join(directory, ".startup-lock", "owner.json"), "utf8"),
		);
		expect(owner.pid).toBe(pid);
	}, 20000);

	it("does not retry a failed mutation or expose the local token in errors", async () => {
		let calls = 0;
		await service(async () => {
			calls++;
			throw new Error(`Failure with ${token}`);
		});
		await expect(callArchitecture("record_td_memory", {})).rejects.toThrow(
			"Failure with [REDACTED]",
		);
		expect(calls).toBe(1);
	});
	it("validates method and payload before launching", async () => {
		const spawn = vi.spyOn(childProcess, "spawn");
		await expect(
			callArchitecture("execute_python_script", {}),
		).rejects.toThrow();
		await expect(
			callArchitecture("record_td_memory", { text: "x".repeat(1024 * 1024) }),
		).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});
});
