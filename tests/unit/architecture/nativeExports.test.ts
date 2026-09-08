import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Standalone release helper is JavaScript outside the TS build.
import { verifyNativeExport } from "../../../scripts/verify-native-exports.mjs";

const roots: string[] = [];
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "td-native-export-"));
	roots.push(root);
	const sources = Object.fromEntries(
		[
			"__init__.py",
			"builder.py",
			"client.py",
			"controller.py",
			"model.py",
			"observer.py",
			"provenance.py",
		].map((name) => [name, hash(name)]),
	);
	for (const name of Object.keys(sources))
		await writeFile(join(root, name), name);
	await writeFile(join(root, "inspector.tox"), "native-binary");
	const manifest = {
		autostart: false,
		binary: { bytes: 13, path: "inspector.tox", sha256: hash("native-binary") },
		build: "2025.33230",
		cleanExport: true,
		schemaVersion: 1,
		sources,
	};
	await writeFile(join(root, "inspector.build.json"), JSON.stringify(manifest));
	return { manifest, root };
}
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
	);
});
describe("native export provenance", () => {
	it("accepts a clean export matching every embedded source and binary", async () => {
		const { root } = await fixture();
		expect((await verifyNativeExport(root)).build).toBe("2025.33230");
	});
	it("rejects source drift after export", async () => {
		const { root } = await fixture();
		await writeFile(join(root, "controller.py"), "changed");
		await expect(verifyNativeExport(root)).rejects.toThrow(/hash/);
	});
	it("rejects binary drift", async () => {
		const { root } = await fixture();
		await writeFile(join(root, "inspector.tox"), "other");
		await expect(verifyNativeExport(root)).rejects.toThrow(/binary/);
	});
	it("rejects live or incomplete provenance", async () => {
		const { root, manifest } = await fixture();
		await writeFile(
			join(root, "inspector.build.json"),
			JSON.stringify({ ...manifest, autostart: true }),
		);
		await expect(verifyNativeExport(root)).rejects.toThrow(/clean/);
	});
	it("rejects missing source and arbitrary paths", async () => {
		const { root, manifest } = await fixture();
		const sources = { ...manifest.sources, "../private": hash("private") };
		await writeFile(
			join(root, "inspector.build.json"),
			JSON.stringify({ ...manifest, sources }),
		);
		await expect(verifyNativeExport(root)).rejects.toThrow(/source/);
	});
});
