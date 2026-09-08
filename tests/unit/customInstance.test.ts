import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AxiosAdapter } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AXIOS_INSTANCE,
	customInstance,
} from "../../src/api/customInstance.js";

const originalAdapter = AXIOS_INSTANCE.defaults.adapter;
const adapter = vi.fn<AxiosAdapter>(async (config) => ({
	config,
	data: { ok: true },
	headers: {},
	status: 200,
	statusText: "OK",
}));

beforeEach(() => {
	vi.stubEnv("TD_WEB_SERVER_HOST", undefined);
	vi.stubEnv("TD_WEB_SERVER_PORT", undefined);
	vi.stubEnv("TD_WEB_SERVER_TIMEOUT_MS", undefined);
	adapter.mockClear();
	AXIOS_INSTANCE.defaults.adapter = adapter;
});
afterEach(() => {
	AXIOS_INSTANCE.defaults.adapter = originalAdapter;
	vi.unstubAllEnvs();
});

describe("TouchDesigner Axios runtime configuration", () => {
	it("dispatches relative API routes to localhost with a bounded default timeout", async () => {
		await expect(customInstance({ url: "/api/nodes" })).resolves.toEqual({
			ok: true,
		});
		const config = adapter.mock.calls[0][0];
		expect(AXIOS_INSTANCE.getUri(config)).toBe(
			"http://127.0.0.1:9981/api/nodes",
		);
		expect(config.timeout).toBe(30000);
	});

	it("reads environment configuration at request time, after module import", async () => {
		vi.stubEnv("TD_WEB_SERVER_HOST", "https://td.example.test/");
		vi.stubEnv("TD_WEB_SERVER_PORT", "9443");
		vi.stubEnv("TD_WEB_SERVER_TIMEOUT_MS", "120000");
		await customInstance({ method: "POST", url: "/api/td/server/exec" });
		expect(AXIOS_INSTANCE.getUri(adapter.mock.calls[0][0])).toBe(
			"https://td.example.test:9443/api/td/server/exec",
		);
		expect(adapter.mock.calls[0][0].timeout).toBe(120000);
		vi.stubEnv("TD_WEB_SERVER_HOST", "http://[::1]");
		vi.stubEnv("TD_WEB_SERVER_PORT", "9982");
		await customInstance({ url: "/api/nodes" });
		expect(AXIOS_INSTANCE.getUri(adapter.mock.calls[1][0])).toBe(
			"http://[::1]:9982/api/nodes",
		);
	});

	it("keeps the validated connection and deadline authoritative over request options", async () => {
		vi.stubEnv("TD_WEB_SERVER_HOST", "http://localhost:7777");
		vi.stubEnv("TD_WEB_SERVER_PORT", "9981");
		await customInstance(
			{ url: "/api/nodes" },
			{ baseURL: "https://other.invalid", timeout: 0 },
		);
		expect(adapter.mock.calls[0][0].baseURL).toBe("http://localhost:9981");
		expect(adapter.mock.calls[0][0].timeout).toBe(30000);
	});

	it.each([
		"localhost",
		"ftp://localhost",
		"http://user:password@localhost",
		"http://@localhost",
		"http://[broken",
		"http://localhost/api",
		"http://localhost/a/..",
		"http://localhost?token=x",
		"http://localhost#fragment",
		" http://localhost",
		"http://localhost\\api",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: regression input must remain literal
		"${process.env.TD_WEB_SERVER_HOST}",
		"http://localhost/`process.exit()`",
	])("rejects malformed or executable-looking host %s before dispatch", (host) => {
		vi.stubEnv("TD_WEB_SERVER_HOST", host);
		expect(() => customInstance({ url: "/api/nodes" })).toThrow(
			/TD_WEB_SERVER_HOST/,
		);
		expect(adapter).not.toHaveBeenCalled();
	});

	it.each([
		"0",
		"65536",
		"1.5",
		"9981oops",
		"",
		"-1",
		"1e3",
		"9981; process.exit()",
	])("rejects invalid port %s", (port) => {
		vi.stubEnv("TD_WEB_SERVER_PORT", port);
		expect(() => customInstance({ url: "/api/nodes" })).toThrow(
			/TD_WEB_SERVER_PORT/,
		);
		expect(adapter).not.toHaveBeenCalled();
	});

	it.each([
		"999",
		"120001",
		"NaN",
		"",
		"1000.5",
	])("rejects invalid timeout %s", (timeout) => {
		vi.stubEnv("TD_WEB_SERVER_TIMEOUT_MS", timeout);
		expect(() => customInstance({ url: "/api/nodes" })).toThrow(
			/TD_WEB_SERVER_TIMEOUT_MS/,
		);
		expect(adapter).not.toHaveBeenCalled();
	});

	it("passes the configured timeout to Axios and never retries a timed-out mutation", async () => {
		let requests = 0;
		const server = createServer((_request, _response) => {
			requests++;
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		vi.stubEnv(
			"TD_WEB_SERVER_PORT",
			String((server.address() as AddressInfo).port),
		);
		vi.stubEnv("TD_WEB_SERVER_TIMEOUT_MS", "1000");
		AXIOS_INSTANCE.defaults.adapter = originalAdapter;
		try {
			await expect(
				customInstance({
					data: { script: "pass" },
					method: "POST",
					url: "/api/td/server/exec",
				}),
			).rejects.toMatchObject({ code: "ECONNABORTED" });
			expect(requests).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
