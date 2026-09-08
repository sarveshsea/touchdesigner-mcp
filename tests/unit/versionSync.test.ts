import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const version = "2.1.0-setdesign.1";
const repository = "https://github.com/sarveshsea/touchdesigner-mcp";
const roots: string[] = [];
function write(root: string, path: string, data: unknown) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(
		join(root, path),
		typeof data === "string" ? data : JSON.stringify(data),
	);
}
function read(root: string, path: string) {
	return JSON.parse(readFileSync(join(root, path), "utf8"));
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "td-version-test-"));
	roots.push(root);
	write(root, "package.json", {
		mcpCompatibility: { expectedApiVersion: "1.5.0" },
		mcpName: "io.github.sarveshsea/touchdesigner-mcp",
		name: "@sarveshsea/touchdesigner-mcp",
		repository: { url: `git+${repository}.git` },
		type: "module",
		version,
	});
	write(root, "mcpb/manifest.json", {
		name: "touchdesigner-mcp-setdesign",
		server: {
			mcp_config: {
				args: ["-y", "touchdesigner-mcp-server@latest", "--stdio"],
				command: "npx",
			},
		},
		version: "2.0.0",
	});
	write(root, "server.json", {
		packages: [
			{ identifier: "touchdesigner-mcp-server", registryType: "npm" },
			{
				fileSha256: "stale",
				identifier: `${repository}/releases/download/v2.0.0/touchdesigner-mcp.mcpb`,
				registryType: "mcpb",
				version: "2.0.0",
			},
		],
		version: "2.0.0",
	});
	return root;
}
function run(root: string, name: string) {
	mkdirSync(join(root, "scripts"), { recursive: true });
	copyFileSync(resolve("scripts", name), join(root, "scripts", name));
	return execFileSync(process.execPath, [join(root, "scripts", name)], {
		encoding: "utf8",
		stdio: "pipe",
	});
}
function pack(root: string, manifest: unknown) {
	write(root, "packed/manifest.json", manifest);
	execFileSync(
		"zip",
		["-q", join(root, "touchdesigner-mcp.mcpb"), "manifest.json"],
		{ cwd: join(root, "packed") },
	);
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { force: true, recursive: true });
});

describe("fork release metadata", () => {
	it("preserves the bridge API axis without rewriting package metadata", () => {
		const root = fixture();
		write(root, "pyproject.toml", '[project]\nversion = "1.4.0"\n');
		write(root, "td/modules/utils/version.py", 'MCP_API_VERSION = "1.4.0"\n');
		write(root, "src/api/index.yml", "info:\n  version: 1.4.0\n");
		const before = readFileSync(join(root, "package.json"), "utf8");
		run(root, "syncApiServerVersions.ts");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
		for (const file of [
			"pyproject.toml",
			"td/modules/utils/version.py",
			"src/api/index.yml",
		])
			expect(readFileSync(join(root, file), "utf8")).toContain("1.5.0");
	});
	it("prepares exact GitHub launcher metadata before a bundle exists", () => {
		const root = fixture();
		run(root, "syncMcpServerVersions.ts");
		const manifest = read(root, "mcpb/manifest.json");
		expect(manifest.version).toBe(version);
		expect(manifest.server.mcp_config.args).toEqual([
			"--yes",
			`${repository}/releases/download/v${version}/sarveshsea-touchdesigner-mcp-${version}.tgz`,
			"--stdio",
		]);
		const registry = read(root, "server.json");
		expect(registry.packages).toHaveLength(1);
		expect(registry.packages[0].registryType).toBe("mcpb");
		expect(registry.packages[0].fileSha256).toBeUndefined();
		expect(registry.name).toBe("io.github.sarveshsea/touchdesigner-mcp");
	});
	it("hashes final bytes only after verifying the embedded manifest", () => {
		const root = fixture();
		run(root, "syncMcpServerVersions.ts");
		pack(root, read(root, "mcpb/manifest.json"));
		run(root, "syncReleaseHashes.ts");
		expect(read(root, "server.json").packages[0].fileSha256).toBe(
			createHash("sha256")
				.update(readFileSync(join(root, "touchdesigner-mcp.mcpb")))
				.digest("hex"),
		);
	});
	it("rejects a stale packed version without changing registry metadata", () => {
		const root = fixture();
		run(root, "syncMcpServerVersions.ts");
		pack(root, { ...read(root, "mcpb/manifest.json"), version: "2.0.0" });
		const before = readFileSync(join(root, "server.json"), "utf8");
		expect(() => run(root, "syncReleaseHashes.ts")).toThrow();
		expect(readFileSync(join(root, "server.json"), "utf8")).toBe(before);
	});
	it("rejects a same-version launcher pointing to upstream", () => {
		const root = fixture();
		run(root, "syncMcpServerVersions.ts");
		pack(root, {
			...read(root, "mcpb/manifest.json"),
			server: {
				mcp_config: {
					args: ["touchdesigner-mcp-server@latest"],
					command: "npx",
				},
			},
		});
		expect(() => run(root, "syncReleaseHashes.ts")).toThrow();
	});
});
