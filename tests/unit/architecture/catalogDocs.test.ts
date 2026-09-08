import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DOC_LIMITS,
	getLocalDocIndex,
} from "../../../src/architecture/catalog/localDocs.js";

const roots: string[] = [];
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "td-catalog-")));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((r) => rm(r, { force: true, recursive: true })),
	);
});
describe("bounded local documentation index", () => {
	it("returns short text and relative filenames, never raw HTML or scripts", async () => {
		const root = await fixture();
		await writeFile(
			join(root, "noiseTOP.htm"),
			"<title>Noise TOP</title><script>SECRET_SCRIPT</script><style>BODY_STYLE</style><h1>Noise</h1><p>Creates &lt;b&gt; texture.</p>",
		);
		const result = await getLocalDocIndex(root, "noise");
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].filename).toBe("noiseTOP.htm");
		expect(JSON.stringify(result)).not.toMatch(
			/SECRET_SCRIPT|BODY_STYLE|<|>|\/private/,
		);
	});
	it("ignores symlink files/directories and non-document files; query is not a path", async () => {
		const root = await fixture();
		const outside = await fixture();
		await writeFile(join(outside, "secret.htm"), "<title>Secret</title>");
		await symlink(outside, join(root, "external"));
		await symlink(join(outside, "secret.htm"), join(root, "linked.htm"));
		await writeFile(join(root, "credentials.json"), "secret");
		await writeFile(join(root, "guide.md"), "Safe guide");
		expect(
			(await getLocalDocIndex(root)).entries.map((e) => e.filename),
		).toEqual(["guide.md"]);
		expect((await getLocalDocIndex(root, "../")).entries).toEqual([]);
		await expect(getLocalDocIndex(join(root, "external"))).rejects.toThrow(
			"unsafe",
		);
	});
	it("bounds indexed files and summary length, and pages cached data", async () => {
		const root = await fixture();
		await Promise.all(
			Array.from({ length: DOC_LIMITS.files + 5 }, (_, i) =>
				writeFile(join(root, `doc-${i}.md`), "a".repeat(1000)),
			),
		);
		const first = await getLocalDocIndex(root, "", 2);
		expect(first.entries).toHaveLength(2);
		expect(first.total).toBe(DOC_LIMITS.files);
		expect(first.truncated).toBe(true);
		expect(first.entries[0].summary.length).toBeLessThanOrEqual(280);
		await writeFile(join(root, "new.md"), "New");
		expect((await getLocalDocIndex(root, "new.md")).entries).toEqual([]);
		const next = await getLocalDocIndex(root, "", 2, 2);
		expect(next.entries[0].filename).not.toBe(first.entries[0].filename);
	});
	it("bounds nesting and read bytes", async () => {
		const root = await fixture();
		let current = root;
		for (let i = 0; i < 6; i++) {
			current = join(current, "deep");
			await mkdir(current);
		}
		await writeFile(join(current, "hidden.md"), "hidden");
		await writeFile(
			join(root, "large.md"),
			`START ${"x".repeat(DOC_LIMITS.fileBytes + 10)} TRAILING_SECRET`,
		);
		const result = await getLocalDocIndex(root);
		expect(result.truncated).toBe(true);
		expect(result.entries).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("TRAILING_SECRET");
	});
	it("does not leak filesystem error details and rejects invalid direct query bounds", async () => {
		await expect(getLocalDocIndex("/unavailable-private-root")).rejects.toThrow(
			"Documentation root unavailable or unsafe",
		);
		await expect(getLocalDocIndex("relative")).rejects.toThrow("unsafe");
		const root = await fixture();
		await expect(getLocalDocIndex(root, "", 201)).rejects.toThrow(
			"Invalid documentation query",
		);
	});
});
