import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { rpcMethods } from "./http.js";

const descriptorSchema = z.strictObject({
	pid: z.number().int().min(1).max(2147483647),
	target: z.strictObject({
		host: z.string().max(1024),
		port: z.number().int().min(1).max(65535),
	}),
	token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
	url: z
		.string()
		.regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/)
		.refine((value) => {
			const port = Number(value.slice(value.lastIndexOf(":") + 1));
			return port >= 1 && port <= 65535;
		}),
	version: z.literal("1"),
});
type Descriptor = z.infer<typeof descriptorSchema>;
type Target = Descriptor["target"];
const startups = new Map<string, Promise<Descriptor>>();
const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
const existsError = (error: unknown, code: string) =>
	(error as NodeJS.ErrnoException).code === code;

function target(): Target {
	const host = process.env.TD_WEB_SERVER_HOST ?? "http://127.0.0.1";
	const rawPort = process.env.TD_WEB_SERVER_PORT ?? "9981";
	if (!/^https?:\/\/[^@/?#\\\s]+\/?$/i.test(host))
		throw new Error("Invalid TD_WEB_SERVER_HOST for architecture service.");
	let parsed: URL;
	try {
		parsed = new URL(host);
	} catch {
		throw new Error("Invalid TD_WEB_SERVER_HOST for architecture service.");
	}
	const port = Number(rawPort);
	if (
		!/^\d+$/.test(rawPort) ||
		!Number.isSafeInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("Invalid TD_WEB_SERVER_PORT for architecture service.");
	parsed.port = "";
	return { host: parsed.origin, port };
}
function stateDirectory(): string {
	const directory =
		process.env.TD_ARCHITECTURE_STATE_DIR ??
		join(homedir(), ".touchdesigner-mcp", "architecture");
	if (!isAbsolute(directory))
		throw new Error("Architecture state directory must be absolute.");
	return resolve(directory);
}
function privateOwner(info: Stats): void {
	if (
		(info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())
	)
		throw new Error(
			"Architecture state must have private permissions and belong to the current user.",
		);
}
async function ensureDirectory(directory: string): Promise<void> {
	await mkdir(directory, { mode: 0o700, recursive: true });
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(
			"Architecture state must be a private directory, not a symlink.",
		);
	privateOwner(info);
}
async function privateJson(filename: string): Promise<unknown | null> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(
			filename,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (existsError(error, "ENOENT")) return null;
		throw new Error("Unable to read a private architecture descriptor.");
	}
	try {
		const info = await file.stat();
		privateOwner(info);
		if (!info.isFile() || info.size > 8192)
			throw new Error("Invalid architecture descriptor file.");
		try {
			return JSON.parse(await file.readFile("utf8"));
		} catch {
			throw new Error("Malformed architecture descriptor.");
		}
	} finally {
		await file.close();
	}
}
async function readDescriptor(directory: string): Promise<Descriptor | null> {
	const value = await privateJson(join(directory, "service.json"));
	if (value === null) return null;
	const parsed = descriptorSchema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			"Invalid architecture descriptor or unsupported service version.",
		);
	return parsed.data;
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (existsError(error, "ESRCH")) return false;
		throw new Error("Cannot verify architecture process ownership.");
	}
}
function compatible(descriptor: Descriptor, expected: Target): void {
	if (
		descriptor.target.host !== expected.host ||
		descriptor.target.port !== expected.port
	)
		throw new Error(
			"Architecture service uses another TouchDesigner target. Stop that service before changing the target.",
		);
}
async function boundedJson(
	response: Response,
	limit: number,
): Promise<unknown> {
	if (Number(response.headers.get("content-length")) > limit)
		throw new Error("Architecture response exceeds its size limit.");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Architecture response has no body.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit)
				throw new Error("Architecture response exceeds its size limit.");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel();
	}
}
async function health(descriptor: Descriptor): Promise<void> {
	try {
		const response = await fetch(`${descriptor.url}/health`, {
			headers: { Authorization: `Bearer ${descriptor.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(1500),
		});
		const data = (await boundedJson(response, 8192)) as {
			ok?: boolean;
			result?: { service?: string; protocol?: number };
		};
		if (
			!response.ok ||
			data.ok !== true ||
			data.result?.service !== "td-architecture" ||
			data.result.protocol !== 1
		)
			throw new Error("Untrusted health response");
	} catch {
		throw new Error(
			"Architecture service authentication or health check failed; no replacement service was started.",
		);
	}
}
async function ready(
	directory: string,
	expected: Target,
): Promise<Descriptor | null> {
	const descriptor = await readDescriptor(directory);
	if (!descriptor || !alive(descriptor.pid)) return null;
	compatible(descriptor, expected);
	await health(descriptor);
	return descriptor;
}

async function removeOwnedMarker(
	filename: string,
	inode: number,
): Promise<void> {
	try {
		if ((await lstat(filename)).ino === inode)
			await rm(filename, { recursive: true });
	} catch (error) {
		if (!existsError(error, "ENOENT")) throw error;
	}
}

interface StartupLock {
	release(): Promise<void>;
	transfer(pid: number): Promise<void>;
}
async function acquireStartup(directory: string): Promise<StartupLock> {
	const lock = join(directory, ".startup-lock");
	const id = randomBytes(16).toString("hex");
	for (let attempt = 0; attempt < 150; attempt++) {
		try {
			await mkdir(lock, { mode: 0o700 });
			await writeFile(
				join(lock, "owner.json"),
				JSON.stringify({ id, pid: process.pid }),
				{ flag: "wx", mode: 0o600 },
			);
			return {
				async release() {
					const owner = (await privateJson(join(lock, "owner.json"))) as {
						id?: string;
					} | null;
					if (owner?.id === id) await rm(lock, { recursive: true });
				},
				async transfer(pid) {
					const temporary = join(lock, `${id}.tmp`);
					try {
						await writeFile(temporary, JSON.stringify({ id, pid }), {
							flag: "wx",
							mode: 0o600,
						});
						await rename(temporary, join(lock, "owner.json"));
					} finally {
						await rm(temporary, { force: true });
					}
				},
			};
		} catch (error) {
			if (!existsError(error, "EEXIST")) throw error;
			const info = await lstat(lock);
			privateOwner(info);
			if (!info.isDirectory() || info.isSymbolicLink())
				throw new Error("Invalid architecture startup lock.");
			const owner = (await privateJson(join(lock, "owner.json"))) as {
				pid?: unknown;
			} | null;
			const stale =
				owner &&
				typeof owner.pid === "number" &&
				Number.isInteger(owner.pid) &&
				owner.pid > 0 &&
				!alive(owner.pid);
			if (stale || (!owner && Date.now() - info.mtimeMs > 15000)) {
				// Serialize reclamation inside the old lock. Recheck its inode and
				// owner so a racing contender cannot rename a newly acquired lock.
				const reaper = join(lock, ".reaping");
				try {
					await mkdir(reaper, { mode: 0o700 });
				} catch (reapError) {
					if (existsError(reapError, "ENOENT")) continue;
					if (!existsError(reapError, "EEXIST")) throw reapError;
					await wait();
					continue;
				}
				const reaperIdentity = await lstat(reaper);
				const retired = join(directory, `.retired-lock-${id}`);
				try {
					const fresh = await lstat(lock);
					const freshOwner = await privateJson(join(lock, "owner.json"));
					if (
						fresh.ino !== info.ino ||
						JSON.stringify(freshOwner) !== JSON.stringify(owner)
					)
						continue;
					await rename(lock, retired);
					await rm(retired, { recursive: true });
				} catch (moveError) {
					if (!existsError(moveError, "ENOENT")) throw moveError;
				} finally {
					await removeOwnedMarker(reaper, reaperIdentity.ino);
				}
				continue;
			}
			await wait();
		}
	}
	throw new Error(
		"Architecture startup is busy; no duplicate daemon was launched.",
	);
}
async function launch(
	directory: string,
	expected: Target,
): Promise<Descriptor> {
	await ensureDirectory(directory);
	const existing = await ready(directory, expected);
	if (existing) return existing;
	const lock = await acquireStartup(directory);
	let spawnedPid = 0;
	let completed = false;
	try {
		const raced = await ready(directory, expected);
		if (raced) return raced;
		// A dead-PID descriptor is replaced only while holding the startup lock.
		await rm(join(directory, "service.json"), { force: true });
		let failed = false;
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("../daemon.js", import.meta.url))],
			{
				detached: true,
				env: { ...process.env, TD_ARCHITECTURE_STATE_DIR: directory },
				stdio: "ignore",
			},
		);
		child.once("error", () => {
			failed = true;
		});
		child.unref();
		spawnedPid = child.pid ?? 0;
		if (spawnedPid) await lock.transfer(spawnedPid);
		for (let attempt = 0; attempt < 150; attempt++) {
			if (failed || child.exitCode !== null)
				throw new Error("Architecture daemon could not start.");
			const descriptor = await ready(directory, expected);
			if (descriptor) {
				completed = true;
				return descriptor;
			}
			await wait();
		}
		throw new Error(
			"Architecture daemon did not become ready. A later invocation may check its status.",
		);
	} finally {
		// Keep a live, unready child's lock: timing out must not permit a second
		// daemon to start. Its dead PID can be reclaimed by a later invocation.
		if (completed || !spawnedPid || !alive(spawnedPid)) await lock.release();
	}
}
async function sharedService(
	directory: string,
	expected: Target,
): Promise<Descriptor> {
	let pending = startups.get(directory);
	if (!pending) {
		pending = launch(directory, expected);
		startups.set(directory, pending);
	}
	try {
		const descriptor = await pending;
		compatible(descriptor, expected);
		return descriptor;
	} finally {
		if (startups.get(directory) === pending) startups.delete(directory);
	}
}

/** Lazy authenticated local RPC. No daemon is spawned on import. A transport
 * timeout never cancels or retries a mutation already running in TouchDesigner. */
export async function callArchitecture(
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	if (
		!(rpcMethods as readonly string[]).includes(method) ||
		!params ||
		typeof params !== "object" ||
		Array.isArray(params)
	)
		throw new Error("Invalid architecture RPC request.");
	let body: string;
	try {
		body = JSON.stringify({ method, params });
	} catch {
		throw new Error("Architecture parameters must be JSON serializable.");
	}
	if (Buffer.byteLength(body) > 1024 * 1024)
		throw new Error("Architecture request exceeds 1 MiB.");
	const descriptor = await sharedService(stateDirectory(), target());
	let response: Response;
	let value: unknown;
	try {
		response = await fetch(`${descriptor.url}/rpc`, {
			body,
			headers: {
				Authorization: `Bearer ${descriptor.token}`,
				"Content-Type": "application/json",
			},
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(120000),
		});
		value = await boundedJson(response, 8 * 1024 * 1024);
	} catch {
		throw new Error(
			"Architecture RPC transport failed; outcome may be uncertain. The request was not retried.",
		);
	}
	const envelope = value as {
		ok?: boolean;
		result?: unknown;
		error?: { message?: unknown };
	};
	if (!response.ok || envelope?.ok !== true) {
		const message =
			typeof envelope?.error?.message === "string"
				? envelope.error.message.slice(0, 700)
				: "Architecture operation failed.";
		throw new Error(message.replaceAll(descriptor.token, "[REDACTED]"));
	}
	return envelope.result;
}
