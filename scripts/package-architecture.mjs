#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { verifyNativeExport } from "./verify-native-exports.mjs";

const root = resolve(import.meta.dirname, "..");
await verifyNativeExport(join(root, "td/architecture"));
const { version } = JSON.parse(
	await readFile(join(root, "package.json"), "utf8"),
);
const target = join(root, "tmp", `architecture-bundle-${version}`);
await mkdir(join(root, "tmp"), { recursive: true });
await mkdir(target, { recursive: false });
for (const path of [
	"td/mcp_webserver_base.tox",
	"td/import_modules.py",
	"td/modules",
	"td/architecture",
	"examples/architecture",
	"rules",
	"LICENSE",
]) {
	await cp(join(root, path), join(target, path), {
		filter: (source) =>
			!source
				.split(/[\\/]/)
				.some(
					(piece) =>
						piece === "__pycache__" ||
						piece === ".DS_Store" ||
						piece.endsWith(".pyc"),
				),
		recursive: true,
	});
}
for (const name of [
	"architecture-service.md",
	"migration-architecture.md",
	"inspector.md",
	"rules.md",
	"community-catalog.md",
])
	await cp(join(root, "docs", name), join(target, "docs", name), {
		recursive: true,
	});
await cp(join(root, "docs/validation"), join(target, "docs/validation"), {
	recursive: true,
});
await verifyNativeExport(join(target, "td/architecture"));
const binaries = [
	"td/mcp_webserver_base.tox",
	"td/architecture/inspector.tox",
	"examples/architecture/architecture_example.tox",
];
const receipts = [];
for (const name of binaries) {
	const path = join(target, name);
	const info = await stat(path);
	if (info.size === 0) throw new Error(`Empty native export: ${name}`);
	receipts.push({
		bytes: info.size,
		path: name,
		sha256: createHash("sha256")
			.update(await readFile(path))
			.digest("hex"),
	});
}
await writeFile(
	join(target, "bundle.json"),
	JSON.stringify(
		{
			apiVersion: "1.5.0",
			architectureObserver: 1,
			receipts,
			refactorSupport: "experimental-not-certified",
			schemaVersion: 1,
			validatedNativeBuild: "2025.33230",
			version,
		},
		null,
		2,
	) + "\n",
);
execFileSync(
	"zip",
	["-qr", join(root, `touchdesigner-architecture-${version}.zip`), "."],
	{ cwd: target },
);
process.stdout.write(`Packaged architecture bundle ${version}\n`);
