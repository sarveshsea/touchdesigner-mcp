import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectGraph } from "../types.js";
import { redact } from "./privacy.js";
import { projectIdSchema } from "./schemas.js";

const digest = z.string().regex(/^[a-f0-9]{32,128}$/);
const path = z.string().min(1).max(512);
const graphNode = z.object({
	family: z.string().max(16),
	fingerprint: digest,
	id: z.number().int(),
	name: z.string().max(128),
	nodeX: z.number().finite(),
	nodeY: z.number().finite(),
	opType: z.string().max(64),
	parentPath: path,
	path,
});
const graphEdge = z.object({
	evidence: z.enum(["observed", "static", "unresolved"]),
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
	source: path,
	target: path,
});
export const graphSchema = z
	.object({
		build: z.string().regex(/^\d{4}\.?\d{1,10}$/),
		complete: z.boolean(),
		dependencyComplete: z.boolean(),
		edges: z.array(graphEdge).max(16384),
		graphFingerprint: digest,
		nodes: z.array(graphNode).max(4096),
		observedAt: z.iso.datetime(),
		originalCounts: z
			.object({
				edges: z.number().int().nonnegative(),
				nodes: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		projectId: projectIdSchema,
		revision: z.number().int().min(0),
		rootPath: path,
		schemaVersion: z.literal(1),
		sourceIdentity: digest,
		status: z.enum(["fresh", "stale", "disconnected", "scanning"]),
	})
	.strict();
export type RetainedGraph = z.infer<typeof graphSchema>;
export function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Whitelist topology only; DAT bodies, OP storage, expressions, media and
 * arbitrary metadata never enter the retained graph. File paths are hashed. */
export function retainGraph(graph: ProjectGraph): RetainedGraph {
	projectIdSchema.parse(graph.projectId);
	if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
		throw new Error("Invalid graph topology arrays.");
	if (typeof graph.projectPath !== "string" || graph.projectPath.length > 4096)
		throw new Error("Invalid graph source identity.");
	// The byte budget also protects graphs with maximum-length operator paths.
	// Reserve the remaining MiB for graph metadata and JSON container overhead.
	let bytes = 0;
	const fits = (value: unknown): boolean => {
		const size = Buffer.byteLength(JSON.stringify(value)) + 1;
		if (bytes + size > 3 * 1024 * 1024) return false;
		bytes += size;
		return true;
	};
	const nodes: z.infer<typeof graphNode>[] = [];
	for (const node of graph.nodes.slice(0, 4096)) {
		const retained = graphNode.parse({
			family: redact(node.family),
			fingerprint: node.fingerprint,
			id: node.id,
			name: redact(node.name),
			nodeX: node.nodeX,
			nodeY: node.nodeY,
			opType: redact(node.opType),
			parentPath: redact(node.parentPath),
			path: redact(node.path),
		});
		if (!fits(retained)) break;
		nodes.push(retained);
	}
	const paths = new Set(nodes.map((node) => node.path));
	const edges: z.infer<typeof graphEdge>[] = [];
	for (const edge of graph.edges) {
		if (edges.length >= 16384) break;
		const source = redact(edge.source);
		const target = redact(edge.target);
		if (!paths.has(source) || !paths.has(target)) continue;
		const retained = graphEdge.parse({
			evidence: edge.evidence,
			kind: edge.kind,
			source,
			target,
		});
		if (!fits(retained)) break;
		edges.push(retained);
	}
	const clipped =
		nodes.length !== graph.nodes.length || edges.length !== graph.edges.length;
	return graphSchema.parse({
		build: graph.build,
		complete: graph.complete && !clipped,
		dependencyComplete: graph.dependencyComplete && !clipped,
		edges,
		graphFingerprint: hash(
			JSON.stringify({
				edges: edges
					.map((edge) => [edge.kind, edge.source, edge.target, edge.evidence])
					.sort(),
				nodes: nodes.map((node) => [node.path, node.fingerprint]).sort(),
			}),
		),
		nodes,
		observedAt: graph.observedAt,
		originalCounts: { edges: graph.edges.length, nodes: graph.nodes.length },
		projectId: graph.projectId,
		revision: graph.revision,
		rootPath: redact(graph.rootPath),
		schemaVersion: 1,
		sourceIdentity: hash(
			JSON.stringify([graph.projectId, graph.projectPath, graph.rootPath]),
		),
		status: graph.status,
	});
}
