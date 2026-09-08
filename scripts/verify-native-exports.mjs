import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCES = [
	"__init__.py",
	"builder.py",
	"client.py",
	"controller.py",
	"model.py",
	"observer.py",
	"provenance.py",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function regularFile(root, name, maxBytes) {
	const path = join(root, name);
	const info = await lstat(path);
	if (!info.isFile() || info.size > maxBytes || info.size === 0)
		throw new Error("Invalid native export file");
	return readFile(path);
}
/** Verify release provenance, not the behavior of arbitrary native binaries. */
export async function verifyNativeExport(root) {
	const manifest = JSON.parse(
		await regularFile(root, "inspector.build.json", 65536),
	);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.cleanExport !== true ||
		manifest.autostart !== false ||
		manifest.build !== "2025.33230"
	)
		throw new Error("Native export must have clean inert provenance");
	if (
		!manifest.sources ||
		Object.keys(manifest.sources).sort().join() !== [...SOURCES].sort().join()
	)
		throw new Error("Native export source manifest mismatch");
	for (const name of SOURCES) {
		const bytes = await regularFile(root, name, 256 * 1024);
		if (sha256(bytes) !== manifest.sources[name])
			throw new Error("Native export source hash mismatch: " + name);
	}
	if (manifest.binary?.path !== "inspector.tox")
		throw new Error("Invalid native binary path");
	const binary = await regularFile(root, "inspector.tox", 4 * 1024 * 1024);
	if (
		sha256(binary) !== manifest.binary.sha256 ||
		binary.length !== manifest.binary.bytes
	)
		throw new Error("Native export binary hash/size mismatch");
	return manifest;
}
