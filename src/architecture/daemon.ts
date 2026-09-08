import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TouchDesignerClient } from "../tdClient/touchDesignerClient.js";
import { startArchitectureHttp } from "./service/http.js";
import { ArchitectureRuntime } from "./service/runtime.js";
import type { BridgeExecutor } from "./types.js";
export function architectureExecutor(
	client = new TouchDesignerClient(),
): BridgeExecutor {
	return {
		async execute(script) {
			const response = await client.execPythonScript({ script });
			if (!response.success)
				throw new Error("TouchDesigner bridge request failed");
			const raw = response.data.result;
			if (typeof raw !== "string" || raw.length > 8 * 1024 * 1024)
				throw new Error("Invalid architecture bridge response");
			return JSON.parse(raw);
		},
	};
}
export async function startDaemon() {
	const host = new URL(process.env.TD_WEB_SERVER_HOST ?? "http://127.0.0.1");
	const rawPort = process.env.TD_WEB_SERVER_PORT ?? "9981";
	const port = Number(rawPort);
	if (
		!["http:", "https:"].includes(host.protocol) ||
		host.username ||
		host.password ||
		host.search ||
		host.hash ||
		host.pathname !== "/" ||
		!/^\d+$/.test(rawPort) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("Invalid TouchDesigner target");
	host.port = "";

	const directory =
		process.env.TD_ARCHITECTURE_STATE_DIR ??
		join(homedir(), ".touchdesigner-mcp", "architecture");
	if (!isAbsolute(directory))
		throw new Error("Architecture state path must be absolute");
	await mkdir(directory, { mode: 0o700, recursive: true });
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		(info.mode & 0o077) !== 0 ||
		(process.getuid && info.uid !== process.getuid())
	)
		throw new Error("Architecture state directory must be private");
	const token = randomBytes(32).toString("base64url");
	const runtime = new ArchitectureRuntime(architectureExecutor(), directory);
	const service = await startArchitectureHttp({
		dispatch: (method, params) => runtime.dispatch(method, params),
		token,
	});

	const descriptor = {
		pid: process.pid,
		target: {
			host: host.origin,
			port,
		},
		token,
		url: service.url,
		version: "1",
	};
	const filename = join(directory, "service.json");
	try {
		const temporary = `${filename}.${process.pid}.tmp`;
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(descriptor));
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await link(temporary, filename);
		} finally {
			await unlink(temporary);
		}
	} catch (error) {
		await runtime.close();
		await service.close();
		throw error;
	}
	const close = async () => {
		await runtime.close();
		await service.close();
		try {
			const saved = JSON.parse(await readFile(filename, "utf8"));
			if (saved.pid === process.pid && saved.token === token)
				await unlink(filename);
		} catch {
			/* A replaced descriptor belongs to another owner. */
		}
	};
	return { close, runtime };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	startDaemon()
		.then((service) => {
			let stopping = false;
			const stop = () => {
				if (stopping) return;
				stopping = true;
				void service.close().finally(() => process.exit(0));
			};
			process.on("SIGTERM", stop);
			process.on("SIGINT", stop);
		})
		.catch(() => {
			process.stderr.write(
				"Architecture daemon startup failed. Check private state directory and bridge configuration.\n",
			);
			process.exitCode = 1;
		});
}
