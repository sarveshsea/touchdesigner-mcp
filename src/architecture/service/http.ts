import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
export const rpcMethods = [
	"get_td_operator_catalog",
	"map_td_project",
	"classify_td_network",
	"plan_td_refactor",
	"stage_td_refactor",
	"get_td_memory",
	"record_td_memory",
	"inspector_state",
] as const;
const requestSchema = z.strictObject({
	method: z.enum(rpcMethods),
	params: z.record(z.string(), z.unknown()).default({}),
});
export async function startArchitectureHttp(options: {
	token: string;
	dispatch: (
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>;
}) {
	if (options.token.length < 32)
		throw new Error("Architecture token must be at least32 characters");
	let active = 0;
	let windowStart = Date.now();
	let requests = 0;
	const server = createServer(async (req, res) => {
		res.setHeader("Content-Type", "application/json");
		res.setHeader("Cache-Control", "no-store");
		const reply = (status: number, value: unknown) => {
			if (!res.writableEnded) {
				res.statusCode = status;
				const encoded = JSON.stringify(value);
				if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) {
					res.statusCode = 413;
					res.end(
						JSON.stringify({
							error: {
								code: "RESULT_TOO_LARGE",
								message:
									"Result exceeds4MiB; request a smaller page or summaryOnly",
							},
							ok: false,
						}),
					);
				} else res.end(encoded);
			}
		};
		const credential = Buffer.from(req.headers.authorization || "");
		const expected = Buffer.from("Bearer " + options.token);
		if (
			req.headers.origin ||
			credential.length !== expected.length ||
			!timingSafeEqual(credential, expected)
		) {
			reply(403, {
				error: { code: "FORBIDDEN", message: "Local authorization required" },
				ok: false,
			});
			return;
		}
		if (req.url === "/health" && req.method === "GET") {
			reply(200, {
				ok: true,
				result: { protocol: 1, service: "td-architecture" },
			});
			return;
		}
		if (req.url !== "/rpc" || req.method !== "POST") {
			reply(404, {
				error: { code: "NOT_FOUND", message: "Unknown route" },
				ok: false,
			});
			return;
		}
		if (Date.now() - windowStart > 60000) {
			windowStart = Date.now();
			requests = 0;
		}
		if (++requests > 300 || active >= 4) {
			reply(429, {
				error: {
					code: "BUSY",
					message:
						"Architecture service is busy; inspect status before retrying a mutation",
				},
				ok: false,
			});
			return;
		}
		active++;
		let released = false;
		const release = () => {
			if (!released) {
				released = true;
				active--;
			}
		};

		let size = 0;
		const chunks: Buffer[] = [];
		try {
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 1024 * 1024) {
					reply(413, {
						error: { code: "TOO_LARGE", message: "Request exceeds1MiB" },
						ok: false,
					});
					return;
				}
				chunks.push(Buffer.from(chunk));
			}
			const parsed = requestSchema.safeParse(
				JSON.parse(Buffer.concat(chunks).toString("utf8")),
			);
			if (!parsed.success) {
				reply(400, {
					error: {
						code: "INVALID_REQUEST",
						message: "Invalid RPC method or parameters",
					},
					ok: false,
				});
				return;
			}
			const result = await options.dispatch(
				parsed.data.method,
				parsed.data.params,
			);
			reply(200, { ok: true, result });
		} catch (error) {
			const invalid =
				error instanceof SyntaxError || error instanceof z.ZodError;
			reply(invalid ? 400 : 422, {
				error: {
					code: invalid ? "INVALID_REQUEST" : "OPERATION_FAILED",
					message: invalid
						? "Invalid request"
						: error instanceof Error
							? error.message
									.replaceAll(options.token, "[REDACTED]")
									.slice(0, 700)
							: "Architecture operation failed",
				},
				ok: false,
			});
		} finally {
			release();
		}
	});
	server.requestTimeout = 15000;
	server.headersTimeout = 10000;
	server.maxConnections = 16;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}
