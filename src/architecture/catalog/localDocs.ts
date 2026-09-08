import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

export const DOC_LIMITS = Object.freeze({
	bytes: 1_048_576,
	cacheMs: 300_000,
	depth: 4,
	entries: 1024,
	fileBytes: 32_768,
	files: 256,
	roots: 4,
});
export interface LocalDoc {
	filename: string;
	title: string;
	summary: string;
}
interface Index {
	entries: LocalDoc[];
	truncated: boolean;
}
const cache = new Map<string, { expires: number; pending: Promise<Index> }>();

async function verifiedRoot(root: string): Promise<string> {
	if (!isAbsolute(root) || root.includes("\0"))
		throw new Error("Invalid documentation root");
	const full = resolve(root);
	for (let path = full; ; path = dirname(path)) {
		if ((await lstat(path)).isSymbolicLink())
			throw new Error("Documentation roots must not traverse symlinks");
		if (dirname(path) === path) break;
	}
	if (!(await lstat(full)).isDirectory())
		throw new Error("Documentation root must be a directory");
	return full;
}

function plain(value: string): string {
	return value
		.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(
			/&(?:nbsp|amp|lt|gt|quot|#39);/g,
			(m) =>
				({
					"&#39;": "'",
					"&amp;": "&",
					"&gt;": " ",
					"&lt;": " ",
					"&nbsp;": " ",
					"&quot;": '"',
				})[m] ?? " ",
		)
		.replace(/[<>]/g, " ")
		.split("")
		.map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

async function readDocument(
	root: string,
	path: string,
	budget: number,
): Promise<{ doc: LocalDoc; bytes: number } | null> {
	// Compare real paths and reject a symlink leaf. O_NOFOLLOW also closes leaf swaps.
	if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
		return null;
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return null;
		const size = Math.min(stat.size, DOC_LIMITS.fileBytes, budget);
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		const raw = buffer.subarray(0, bytesRead).toString("utf8");
		const filename = relative(root, path).split("\\").join("/");
		const title = plain(
			raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
				filename.replace(/\.(?:html?|md)$/i, ""),
		).slice(0, 160);
		return {
			bytes: bytesRead,
			doc: { filename, summary: plain(raw).slice(0, 280), title },
		};
	} finally {
		await handle.close();
	}
}

async function buildIndex(root: string): Promise<Index> {
	const queue = [{ depth: 0, path: root }];
	const entries: LocalDoc[] = [];
	let scanned = 0;
	let bytes = 0;
	let truncated = false;
	while (
		queue.length &&
		scanned < DOC_LIMITS.entries &&
		entries.length < DOC_LIMITS.files &&
		bytes < DOC_LIMITS.bytes
	) {
		const current = queue.shift();
		if (!current) break;
		if ((await realpath(current.path)) !== current.path) {
			truncated = true;
			continue;
		}
		const directory = await opendir(current.path);
		try {
			for await (const entry of directory) {
				if (
					++scanned > DOC_LIMITS.entries ||
					entries.length >= DOC_LIMITS.files ||
					bytes >= DOC_LIMITS.bytes
				) {
					truncated = true;
					break;
				}
				if (entry.isSymbolicLink()) continue;
				const path = join(current.path, entry.name);
				if (entry.isDirectory()) {
					if (current.depth < DOC_LIMITS.depth)
						queue.push({ depth: current.depth + 1, path });
					else truncated = true;
				} else if (
					entry.isFile() &&
					/\.(?:html?|md)$/i.test(extname(entry.name))
				) {
					try {
						const item = await readDocument(
							root,
							path,
							DOC_LIMITS.bytes - bytes,
						);
						if (item) {
							entries.push(item.doc);
							bytes += item.bytes;
						}
					} catch {
						truncated = true;
					}
				}
			}
		} catch {
			truncated = true;
		}
	}
	return {
		entries: entries.sort((a, b) => a.filename.localeCompare(b.filename)),
		truncated: truncated || queue.length > 0,
	};
}

/** Caller must authorize docRoot. Queries only filter this bounded index. */
export async function getLocalDocIndex(
	root: string,
	query = "",
	limit = 50,
	offset = 0,
) {
	if (
		query.length > 160 ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 200 ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 8192
	)
		throw new Error("Invalid documentation query");
	let full: string;
	try {
		full = await verifiedRoot(root);
	} catch {
		throw new Error("Documentation root unavailable or unsafe");
	}
	let cached = cache.get(full);
	if (!cached || cached.expires < Date.now()) {
		const pending = buildIndex(full);
		cached = { expires: Date.now() + DOC_LIMITS.cacheMs, pending };
		cache.delete(full);
		cache.set(full, cached);
		while (cache.size > DOC_LIMITS.roots) {
			const oldest = cache.keys().next().value;
			if (oldest) cache.delete(oldest);
		}
	}
	let index: Index;
	try {
		index = await cached.pending;
	} catch {
		cache.delete(full);
		throw new Error("Documentation index unavailable");
	}
	const q = query.toLocaleLowerCase();
	const matches = index.entries.filter((e) =>
		[e.filename, e.title, e.summary].some((s) =>
			s.toLocaleLowerCase().includes(q),
		),
	);
	const entries = matches.slice(offset, offset + limit).map((e) => ({ ...e }));
	return {
		entries,
		nextOffset:
			offset + entries.length < matches.length ? offset + entries.length : null,
		source: "local-documents" as const,
		total: matches.length,
		truncated: index.truncated,
	};
}
