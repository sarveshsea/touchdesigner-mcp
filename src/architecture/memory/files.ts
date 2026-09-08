import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();

/** Shared queue protects multiple MemoryStore instances in this process. */
export async function serialized<T>(
	key: string,
	action: () => Promise<T>,
): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(action);
	queues.set(key, next);
	try {
		return await next;
	} finally {
		if (queues.get(key) === next) queues.delete(key);
	}
}

export function rootPath(value: string): string {
	if (!isAbsolute(value))
		throw new Error("Memory stateRoot must be an absolute private directory.");
	return resolve(value);
}
export async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700, recursive: true });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("Memory directory must not be a symlink.");
	await chmod(path, 0o700);
}

/** Exclusive filesystem lock prevents lost writes across separate processes. */
export async function locked<T>(
	directory: string,
	action: () => Promise<T>,
): Promise<T> {
	const lock = join(directory, ".write-lock");
	for (let attempt = 0; ; attempt++) {
		try {
			await mkdir(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt >= 100)
				throw new Error("Memory is busy; a prior writer may require recovery.");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	try {
		return await action();
	} finally {
		await rm(lock, { recursive: true });
	}
}

export async function readJson(path: string): Promise<unknown | null> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > MAX_BYTES)
			throw new Error("Memory file exceeds its safe size or is not a file.");
		return JSON.parse(await file.readFile("utf8"));
	} finally {
		await file.close();
	}
}

export async function atomicFile(path: string, text: string): Promise<void> {
	if (Buffer.byteLength(text) > MAX_BYTES)
		throw new Error("Memory file exceeds its safe size.");
	const temporary = join(
		dirname(path),
		`.${randomBytes(12).toString("hex")}.tmp`,
	);
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(text, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
