import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) =>
	JSON.parse(readFileSync(join(rootDir, path), "utf8"));
const pkg = read("package.json");
const source = read("mcpb/manifest.json");
const archive = join(rootDir, "touchdesigner-mcp.mcpb");
// MCPB is a ZIP archive. Read the manifest without extracting arbitrary paths.
const packed = JSON.parse(
	execFileSync("unzip", ["-p", archive, "manifest.json"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	}),
);
if (
	packed.version !== pkg.version ||
	source.version !== pkg.version ||
	packed.name !== source.name
)
	throw new Error(
		"Packed MCPB identity/version does not match the current package; rebuild it.",
	);
if (JSON.stringify(packed.server) !== JSON.stringify(source.server))
	throw new Error(
		"Packed MCPB launcher does not match the current manifest; rebuild it.",
	);
const registry = read("server.json");
if (registry.version !== pkg.version)
	throw new Error(
		"Registry version is stale; run version synchronization first.",
	);
const fileSha256 = createHash("sha256")
	.update(readFileSync(archive))
	.digest("hex");
const packages = registry.packages.map(
	(entry: { registryType: string; version: string }) => {
		if (entry.registryType !== "mcpb" || entry.version !== pkg.version)
			throw new Error(
				"Registry must contain only current MCPB release metadata.",
			);
		return { ...entry, fileSha256 };
	},
);
if (packages.length !== 1)
	throw new Error("Expected exactly one MCPB registry package.");
writeFileSync(
	join(rootDir, "server.json"),
	`${JSON.stringify({ ...registry, packages }, null, 2)}\n`,
);
console.log(`Verified MCPB ${pkg.version}: ${fileSha256}`);
