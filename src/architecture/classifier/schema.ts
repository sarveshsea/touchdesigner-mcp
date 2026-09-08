import { z } from "zod";

export const roles = [
	"input",
	"audio",
	"timing",
	"control",
	"geometry",
	"simulation",
	"materials",
	"rendering",
	"post",
	"typography",
	"output",
	"ui",
	"utilities",
	"documentation",
	"mixed",
	"unknown",
] as const;
export const roleSchema = z.enum(roles);
const selectors = z.array(z.string().min(1).max(128)).min(1).max(128);
export const ruleSchema = z
	.object({
		id: z.string().min(1).max(100),
		match: z
			.object({
				families: selectors.optional(),
				nameRegex: z.string().min(1).max(256).optional(),
				opTypes: selectors.optional(),
				pathRegex: z.string().min(1).max(256).optional(),
				tags: selectors.optional(),
			})
			.strict()
			.refine(
				(value) => Object.keys(value).length > 0,
				"A rule requires at least one selector",
			),
		priority: z.number().int().min(0).max(99).default(10),
		role: roleSchema,
	})
	.strict();
export const rulePackSchema = z
	.object({ rules: z.array(ruleSchema).max(128), version: z.literal(1) })
	.strict()
	.refine(
		(pack) =>
			new Set(pack.rules.map((rule) => rule.id)).size === pack.rules.length,
		"Rule IDs must be unique",
	);
export const classifierOptionsSchema = z
	.object({
		columnGap: z.number().finite().min(20).max(2000).default(100),
		overrides: z.record(z.string().min(1).max(2048), roleSchema).default({}),
		pins: z.array(z.string().min(1).max(2048)).max(50000).default([]),
		regexTimeoutMs: z.number().int().min(25).max(2000).default(500),
		rowGap: z.number().finite().min(20).max(2000).default(60),
		rulePack: rulePackSchema.optional(),
	})
	.strict();
export type ClassifierOptions = z.input<typeof classifierOptionsSchema>;
export type Rule = z.output<typeof ruleSchema>;
export type RulePack = z.input<typeof rulePackSchema>;
