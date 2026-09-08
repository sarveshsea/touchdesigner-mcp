import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) =>
	JSON.parse(readFileSync(join(rootDir, path), "utf8"));
const write = (path: string, data: unknown) =>
	writeFileSync(join(rootDir, path), `${JSON.stringify(data, null, 2)}\n`);
const pkg = read("package.json");
const version: string = pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
	throw new Error("Invalid package release version.");
const repository: string = pkg.repository.url
	.replace(/^git\+/, "")
	.replace(/\.git$/, "");
if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repository))
	throw new Error("Expected a GitHub repository URL.");
const release = `${repository}/releases/download/v${version}`;
const tarball = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
const manifest = read("mcpb/manifest.json");
const config = manifest.server.mcp_config;
const nextManifest = {
	...manifest,
	homepage: repository,
	repository: { type: "git", url: repository },
	server: {
		...manifest.server,
		mcp_config: {
			...config,
			args: ["--yes", `${release}/${tarball}`, ...config.args.slice(2)],
			command: "npx",
		},
	},
	version,
};
const registry = read("server.json");
interface PackageEntry {
	registryType: string;
	identifier: string;
	version: string;
	fileSha256?: string;
}
const previous = registry.packages?.find(
	(entry: PackageEntry) => entry.registryType === "mcpb",
);
const identifier = `${release}/touchdesigner-mcp.mcpb`;
const nextPackage = {
	identifier,
	registryType: "mcpb",
	version,
	...(previous?.version === version &&
	previous?.identifier === identifier &&
	previous.fileSha256
		? { fileSha256: previous.fileSha256 }
		: {}),
	transport: { type: "stdio" },
};
write("mcpb/manifest.json", nextManifest);
write("server.json", {
	...registry,
	name: pkg.mcpName,
	packages: [nextPackage],
	repository: { source: "github", url: `${repository}.git` },
	version,
});
console.log(
	`Prepared MCP release metadata ${version}; package artifacts before running syncReleaseHashes.ts.`,
);
