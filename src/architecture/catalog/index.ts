import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BridgeExecutor } from "../types.js";
import { COMMUNITY_REFERENCES } from "./community.js";
import { getLocalDocIndex } from "./localDocs.js";
import { catalogHeaderScript, catalogPageScript } from "./runtime.js";

export interface CatalogOptions {
	query?: string;
	family?: string;
	limit?: number;
	offset?: number;
	docRoot?: string;
}
const optionsSchema = z
	.object({
		docRoot: z
			.string()
			.max(4096)
			.refine(isAbsolute, "docRoot must be an explicit absolute directory")
			.optional(),
		family: z.string().min(1).max(80).optional(),
		limit: z.number().int().min(1).max(200).default(50),
		offset: z.number().int().min(0).max(8192).default(0),
		query: z.string().max(160).optional(),
	})
	.strict();
const name = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_ .:+-]+$/);
const headerSchema = z.object({
	build: z.string().min(1).max(120),
	families: z.array(name).max(128),
	registryCount: z.number().int().min(0).max(8192),
	truncated: z.boolean(),
});
const rowSchema = z.object({
	family: name.optional(),
	isFilter: z.boolean().optional(),
	isMultiInputs: z.boolean().optional(),
	isSupported: z.boolean().optional(),
	label: z.string().max(200).optional(),
	maxInputs: z.number().int().min(0).max(65536).optional(),
	maxOutputs: z.number().int().min(0).max(65536).optional(),
	minInputs: z.number().int().min(0).max(65536).optional(),
	minOutputs: z.number().int().min(0).max(65536).optional(),
	opType: name,
	subType: z.string().max(80).optional(),
	supported: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});
type RuntimeRow = z.infer<typeof rowSchema>;
export interface OperatorEntry extends RuntimeRow {
	kind: "filter" | "generator" | "unknown";
	support: "reported-supported" | "reported-unsupported" | "unknown";
	supportSource?: "isSupported" | "supported";
	availability: "registered";
	tested: false;
}
interface CatalogData {
	entries: OperatorEntry[];
	complete: boolean;
}
interface CacheEntry {
	signature: string;
	expires: number;
	pending: Promise<CatalogData>;
}
const runtimeCache = new WeakMap<BridgeExecutor, CacheEntry>();
const CACHE_MS = 30_000;

function decoded(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.length > 2_000_000) throw new Error("Oversized catalog response");
		return JSON.parse(value);
	}
	return value;
}

async function loadRuntime(
	executor: BridgeExecutor,
	header: z.infer<typeof headerSchema>,
): Promise<CatalogData> {
	const entries: OperatorEntry[] = [];
	const seen = new Set<string>();
	let offset = 0;
	let truncated = header.truncated;
	for (let page = 0; page < 64; page++) {
		const raw = z
			.object({
				build: z.string(),
				entries: z.array(rowSchema).max(128),
				nextOffset: z.number().int().min(1).max(8192).nullable(),
				truncated: z.boolean(),
			})
			.parse(decoded(await executor.execute(catalogPageScript(offset))));
		if (raw.build !== header.build)
			throw new Error("TouchDesigner build changed during catalog scan");
		for (const row of raw.entries) {
			if (seen.has(row.opType))
				throw new Error("Duplicate catalog registry entry");
			seen.add(row.opType);
			const observedSupport = row.isSupported ?? row.supported;
			entries.push({
				...row,
				availability: "registered",
				kind:
					row.isFilter === undefined
						? "unknown"
						: row.isFilter
							? "filter"
							: "generator",
				support:
					observedSupport === undefined
						? "unknown"
						: observedSupport
							? "reported-supported"
							: "reported-unsupported",
				...(observedSupport === undefined
					? {}
					: {
							supportSource:
								row.isSupported === undefined
									? ("supported" as const)
									: ("isSupported" as const),
						}),
				tested: false,
			});
		}
		truncated ||= raw.truncated;
		if (raw.nextOffset === null)
			return {
				complete: !truncated && entries.length === header.registryCount,
				entries,
			};
		if (raw.nextOffset !== offset + 128 || raw.entries.length !== 128)
			throw new Error("Invalid catalog pagination");
		offset = raw.nextOffset;
	}
	return { complete: false, entries };
}

/** Registry discovery is observed metadata, not an operator compatibility test. */
export async function getOperatorCatalog(
	executor: BridgeExecutor,
	options: CatalogOptions = {},
) {
	const opts = optionsSchema.parse(options);
	const header = headerSchema.parse(
		decoded(await executor.execute(catalogHeaderScript())),
	);
	const signature = JSON.stringify([
		header.build,
		header.registryCount,
		header.families,
		header.truncated,
	]);
	let cached = runtimeCache.get(executor);
	if (
		!cached ||
		cached.signature !== signature ||
		cached.expires < Date.now()
	) {
		const pending = loadRuntime(executor, header);
		cached = { expires: Date.now() + CACHE_MS, pending, signature };
		runtimeCache.set(executor, cached);
	}
	let data: CatalogData;
	try {
		data = await cached.pending;
	} catch (error) {
		if (runtimeCache.get(executor) === cached) runtimeCache.delete(executor);
		throw new Error("Invalid operator catalog response", { cause: error });
	}
	const query = (opts.query ?? "").trim().toLocaleLowerCase();
	const family = opts.family?.toLocaleLowerCase();
	const matches = data.entries.filter(
		(row) =>
			(!family || row.family?.toLocaleLowerCase() === family) &&
			(!query ||
				[row.opType, row.family, row.label, row.subType].some((v) =>
					v?.toLocaleLowerCase().includes(query),
				)),
	);
	const operators = matches
		.slice(opts.offset, opts.offset + opts.limit)
		.map((row) => ({ ...row }));
	const docs = opts.docRoot
		? await getLocalDocIndex(opts.docRoot, query, opts.limit, opts.offset)
		: undefined;
	return {
		build: header.build,
		complete: data.complete,
		evidence: "observed-registry" as const,
		families: [
			...new Set([
				...header.families,
				...data.entries.flatMap((r) => (r.family ? [r.family] : [])),
			]),
		],
		limit: opts.limit,
		nextOffset:
			opts.offset + operators.length < matches.length
				? opts.offset + operators.length
				: null,
		offset: opts.offset,
		operators,
		schemaVersion: 1 as const,
		total: matches.length,
		...(docs ? { docs } : {}),
		community: COMMUNITY_REFERENCES.map((r) => ({ ...r })),
		warnings: data.complete
			? []
			: ["Registry discovery was bounded or changed; catalog is incomplete."],
	};
}
