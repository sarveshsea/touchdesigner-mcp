import { z } from "zod";
import { graphWorkItemSchema } from "./pageScript.js";

const path = z.string().min(1).max(2048);
const finite = z.number().finite();
const evidence = z.enum(["observed", "static", "unresolved"]);
export const graphNodeSchema = z.object({
	family: z.string().max(32),
	fingerprint: z.string().max(128),
	flags: z
		.record(z.string().max(64), z.boolean().nullable())
		.refine((v) => Object.keys(v).length <= 64),
	id: z.number().int().nonnegative(),
	name: z.string().max(512),
	nodeHeight: finite.optional(),
	nodeWidth: finite.optional(),
	nodeX: finite,
	nodeY: finite,
	opType: z.string().max(128),
	ownership: z.array(z.string().max(128)).max(32),
	parameterReferences: z
		.array(
			z.object({
				evidence,
				mode: z.string().max(32),
				name: z.string().max(128),
				reason: z.string().max(512).optional(),
				targetPaths: z.array(path).max(64),
			}),
		)
		.max(512)
		.optional(),
	parentPath: z.string().max(2048),
	path,
	sourceHashes: z
		.record(z.string().max(256), z.string().max(128))
		.refine((v) => Object.keys(v).length <= 4096)
		.optional(),
	subType: z.string().max(128).optional(),
	tags: z.array(z.string().max(128)).max(64),
});
export const graphEdgeSchema = z.object({
	evidence,
	id: z.string().max(128),
	inputIndex: z.number().int().nonnegative().optional(),
	kind: z.enum([
		"containment",
		"wire",
		"component-wire",
		"parameter",
		"expression",
		"binding",
		"export",
		"ownership",
	]),
	outputIndex: z.number().int().nonnegative().optional(),
	parameter: z.string().max(128).optional(),
	reason: z.string().max(512).optional(),
	source: path,
	target: path,
});
export const graphPageSchema = z.object({
	build: z.string().max(128),
	dependencyComplete: z.boolean(),
	dirtyRevision: z.number().int().nonnegative().nullable(),
	discovered: z.array(graphWorkItemSchema).max(500),
	edges: z.array(graphEdgeSchema).max(4096),
	endDirtyRevision: z.number().int().nonnegative().nullable().optional(),
	missing: z.array(path).max(500),
	nodes: z.array(graphNodeSchema).max(500),
	pending: z.array(graphWorkItemSchema).max(1000),
	projectId: z.string().min(1).max(128),
	projectPath: z.string().max(4096),
	sessionId: z.string().min(1).max(128),
	truncated: z.boolean(),
	warnings: z.array(z.string().max(512)).max(30),
});

/** Accept raw JSON or the execute endpoint's bounded result envelope. */
export function decodeBridgeResult(value: unknown): unknown {
	let current = value;
	for (let depth = 0; depth < 4; depth++) {
		if (typeof current === "string") {
			if (Buffer.byteLength(current) > 8 * 1024 * 1024)
				throw new Error("Graph bridge payload exceeds 8 MiB");
			current = JSON.parse(current);
			continue;
		}
		if (current && typeof current === "object" && "result" in current) {
			current = (current as { result: unknown }).result;
			continue;
		}
		break;
	}
	return current;
}
