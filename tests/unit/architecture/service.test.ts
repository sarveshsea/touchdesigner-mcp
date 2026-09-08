import { afterEach, describe, expect, it } from "vitest";
import { startArchitectureHttp } from "../../../src/architecture/service/http.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fixture() {
	const calls: unknown[] = [];
	const server = await startArchitectureHttp({
		dispatch: async (method, params) => {
			calls.push({ method, params });
			return { method };
		},
		token: "a".repeat(64),
	});
	servers.push(server);
	return { ...server, calls };
}
describe("private architecture RPC", () => {
	it("authenticates before dispatch and rejects browser origins", async () => {
		const s = await fixture();
		for (const headers of [
			{},
			{ authorization: "Bearer wrong" },
			{
				authorization: `Bearer ${"a".repeat(64)}`,
				origin: "https://example.com",
			},
		]) {
			const res = await fetch(`${s.url}/rpc`, {
				body: JSON.stringify({ method: "map_td_project", params: {} }),
				headers: { "content-type": "application/json", ...headers },
				method: "POST",
			});
			expect(res.status).toBe(403);
		}
		expect(s.calls).toEqual([]);
	});
	it("dispatches validated methods and wraps responses", async () => {
		const s = await fixture();
		const res = await fetch(`${s.url}/rpc`, {
			body: JSON.stringify({
				method: "map_td_project",
				params: { action: "status" },
			}),
			headers: {
				authorization: `Bearer ${"a".repeat(64)}`,
				"content-type": "application/json",
			},
			method: "POST",
		});
		expect(await res.json()).toEqual({
			ok: true,
			result: { method: "map_td_project" },
		});
		expect(s.calls).toHaveLength(1);
	});
	it("rejects unknown methods, arrays and oversized bodies", async () => {
		const s = await fixture();
		for (const body of [
			"[]",
			JSON.stringify({ method: "execute_python_script", params: {} }),
			"x".repeat(1024 * 1024 + 1),
		]) {
			const res = await fetch(`${s.url}/rpc`, {
				body,
				headers: {
					authorization: `Bearer ${"a".repeat(64)}`,
					"content-type": "application/json",
				},
				method: "POST",
			});
			expect([400, 413]).toContain(res.status);
		}
		expect(s.calls).toHaveLength(0);
	});
});

describe("HTTP boundaries and failure envelopes", () => {
	const auth = { authorization: `Bearer ${"a".repeat(64)}` };
	it("requires a strong token before binding a listener", async () => {
		await expect(
			startArchitectureHttp({ dispatch: async () => null, token: "short" }),
		).rejects.toThrow(/token/);
	});
	it("returns authenticated health and never caches private RPC results", async () => {
		const s = await fixture();
		const response = await fetch(`${s.url}/health`, { headers: auth });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({
			ok: true,
			result: { protocol: 1, service: "td-architecture" },
		});
		expect(s.calls).toHaveLength(0);
	});
	it("rejects unknown routes and wrong verbs after authentication", async () => {
		const s = await fixture();
		for (const [path, method] of [
			["/missing", "GET"],
			["/rpc", "GET"],
			["/health", "POST"],
		]) {
			const response = await fetch(s.url + path, { headers: auth, method });
			expect(response.status).toBe(404);
			expect((await response.json()).error.code).toBe("NOT_FOUND");
		}
		expect(s.calls).toHaveLength(0);
	});
	it("rejects malformed JSON and unexpected envelope fields without dispatch", async () => {
		const s = await fixture();
		for (const body of [
			"{",
			"null",
			JSON.stringify({ extra: 1, method: "inspector_state", params: [] }),
			JSON.stringify({ injected: true, method: "inspector_state" }),
		]) {
			const response = await fetch(`${s.url}/rpc`, {
				body,
				headers: auth,
				method: "POST",
			});
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe("INVALID_REQUEST");
		}
		expect(s.calls).toHaveLength(0);
	});
	it("defaults params and preserves a null result", async () => {
		let params: unknown;
		const server = await startArchitectureHttp({
			dispatch: async (_, value) => {
				params = value;
				return null;
			},
			token: "a".repeat(64),
		});
		servers.push(server);
		const response = await fetch(`${server.url}/rpc`, {
			body: JSON.stringify({ method: "inspector_state" }),
			headers: auth,
			method: "POST",
		});
		expect(await response.json()).toEqual({ ok: true, result: null });
		expect(params).toEqual({});
	});
	it("bounds operation error text and handles non-Error failures", async () => {
		for (const failure of [new Error("x".repeat(1000)), "internal failure"]) {
			const server = await startArchitectureHttp({
				dispatch: async () => {
					throw failure;
				},
				token: "a".repeat(64),
			});
			servers.push(server);
			const response = await fetch(`${server.url}/rpc`, {
				body: JSON.stringify({ method: "inspector_state" }),
				headers: auth,
				method: "POST",
			});
			expect(response.status).toBe(422);
			const envelope = await response.json();
			expect(envelope.ok).toBe(false);
			expect(envelope.error.code).toBe("OPERATION_FAILED");
			expect(envelope.error.message.length).toBeLessThanOrEqual(700);
		}
	});
	it("redacts its own bearer credential from backend error text", async () => {
		const token = "a".repeat(64);
		const server = await startArchitectureHttp({
			dispatch: async () => {
				throw new Error(`Upstream failed: Bearer ${token}`);
			},
			token,
		});
		servers.push(server);
		const response = await fetch(`${server.url}/rpc`, {
			body: JSON.stringify({ method: "inspector_state" }),
			headers: auth,
			method: "POST",
		});
		expect(await response.text()).not.toContain(token);
	});
});
