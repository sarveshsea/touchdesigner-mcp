import { z } from "zod";

export const projectIdSchema = z
	.string()
	.regex(
		/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
	);
const digest = z.string().regex(/^[a-f0-9]{32,128}$/);
const noteId = z.string().regex(/^[a-f0-9]{32}$/);
export const memoryKind = z.enum([
	"observed",
	"inferred",
	"decision",
	"verified",
]);
export const provenanceSchema = z
	.object({
		build: z.string().regex(/^\d{4}\.?\d{1,10}$/),
		fingerprint: digest,
		nodePath: z
			.string()
			.max(512)
			.regex(/^\/[\w /.-]*$/)
			.optional(),
		sourceIdentity: digest,
	})
	.strict();
const title = z.string().trim().min(1).max(120);
const text = z.string().trim().min(1).max(2000);
const scope = z.enum(["project", "personal"]).default("project");
const target = { id: noteId, projectId: projectIdSchema };

/** Personal records can only originate from the explicit promote action. */
export const recordMemoryInput = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("record"),
			kind: memoryKind,
			projectId: projectIdSchema,
			provenance: provenanceSchema.optional(),
			scope: z.literal("project").optional(),
			text,
			title,
		})
		.strict(),
	z
		.object({
			action: z.literal("correct"),
			...target,
			kind: memoryKind.optional(),
			provenance: provenanceSchema.optional(),
			scope,
			text,
			title: title.optional(),
		})
		.strict(),
	z.object({ action: z.literal("retire"), ...target, scope }).strict(),
	z.object({ action: z.literal("promote"), ...target }).strict(),
]);
export const getMemoryInput = z
	.object({
		includeRetired: z.boolean().default(false),
		limit: z.number().int().min(1).max(50).default(20),
		projectId: projectIdSchema,
		scope,
		search: z.string().max(200).default(""),
	})
	.strict();

export const memoryRecordSchema = z
	.object({
		createdAt: z.iso.datetime(),
		id: noteId,
		kind: memoryKind,
		projectId: projectIdSchema,
		promotedFrom: z
			.object({
				id: noteId,
				projectId: projectIdSchema,
				version: z.number().int().min(1),
			})
			.strict()
			.optional(),
		provenance: provenanceSchema.optional(),
		schemaVersion: z.literal(1),
		scope: z.enum(["project", "personal"]),
		status: z.enum(["active", "retired"]),
		text,
		title,
		updatedAt: z.iso.datetime(),
		version: z.number().int().min(1),
	})
	.strict();
export const memoryFileSchema = z
	.object({
		records: z.array(memoryRecordSchema).max(512),
		schemaVersion: z.literal(1),
	})
	.strict();
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type RecordMemoryInput = z.input<typeof recordMemoryInput>;
export type GetMemoryInput = z.input<typeof getMemoryInput>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type MemoryResult = MemoryRecord & {
	freshness: "current" | "stale" | "unverified";
	staleReasons: string[];
};
export interface MemoryQueryResult {
	records: MemoryResult[];
	total: number;
	limit: number;
}
