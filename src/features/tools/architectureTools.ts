import { z } from "zod";
import { classifierOptionsSchema } from "../../architecture/classifier/schema.js";
import {
	getMemoryInput,
	recordMemoryInput,
} from "../../architecture/memory/schemas.js";
import { refactorInputSchema } from "../../architecture/refactor/index.js";
import { callArchitecture } from "../../architecture/service/client.js";
import { TOOL_NAMES } from "../../core/constants.js";
import type { ToolDefinition } from "./toolDefinitions.js";

const rootPath = z
	.string()
	.min(1)
	.max(2048)
	.refine(
		(p) => p.startsWith("/") && !p.includes("\0"),
		"Use an absolute TouchDesigner operator path",
	)
	.default("/project1");
const responsePage = {
	limit: z.number().int().min(1).max(500).default(200),
	offset: z.number().int().min(0).max(50000).default(0),
	summaryOnly: z
		.boolean()
		.default(false)
		.describe("Return counts/status without graph or classification rows."),
};
export const projectMapSchema = z.strictObject({
	...responsePage,
	action: z
		.enum(["refresh", "watch", "stop", "status", "diff"])
		.default("refresh"),
	dependencyAnalysis: z.boolean().default(false),
	intervalMs: z.number().int().min(1000).max(60000).default(2000),
	maxDurationMs: z.number().int().min(1).max(3600000).default(60000),
	maxNodes: z.number().int().min(1).max(50000).default(10000),
	pageSize: z.number().int().min(1).max(500).default(100),
	rootPath,
	wait: z
		.boolean()
		.default(true)
		.describe(
			"Wait for a refresh result; false returns a background scan job immediately.",
		),
});
export const classifyNetworkSchema = z.strictObject({
	...responsePage,
	classifierOptions: classifierOptionsSchema.default(() =>
		classifierOptionsSchema.parse({}),
	),
	rootPath,
});
const refactorId = z.string().regex(/^refactor_[a-f0-9]{32}$/);
export const stageRefactorSchema = z
	.strictObject({
		action: z.enum(["apply", "status"]),
		planId: refactorId.optional(),
		transactionId: refactorId.optional(),
	})
	.superRefine((value, ctx) => {
		if (value.action === "apply" && (!value.planId || value.transactionId))
			ctx.addIssue({
				code: "custom",
				message: "Apply requires only planId",
				path: ["planId"],
			});
		if (value.action === "status" && (!value.transactionId || value.planId))
			ctx.addIssue({
				code: "custom",
				message: "Status requires only transactionId",
				path: ["transactionId"],
			});
	});
const catalogSchema = z.strictObject({
	family: z.string().min(1).max(80).optional(),
	limit: z.number().int().min(1).max(200).default(50),
	offset: z.number().int().min(0).max(8192).default(0),
	query: z.string().max(160).optional(),
});
export const recordArchitectureMemorySchema = z.strictObject({
	record: recordMemoryInput,
});

function architectureTool(
	input: Omit<ToolDefinition, "run" | "category">,
): ToolDefinition {
	return {
		...input,
		category: "state",
		run: async ({ params }) =>
			JSON.stringify(
				await callArchitecture(input.name, input.schema.parse(params)),
			),
	};
}
const readOnly = {
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	readOnlyHint: true,
};
export const ARCHITECTURE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	architectureTool({
		annotations: readOnly,
		description:
			"Discover exact operator registry metadata for the connected TD build, with bounded search and pagination. Includes offline-help summaries when configured and reference-only community links; never imports or creates operators.",
		example: "get_td_operator_catalog({family:'POP',limit:50})",
		name: TOOL_NAMES.GET_TD_OPERATOR_CATALOG,
		notes:
			"Registration and reported support are not execution tests. The offline documentation root is service-owned configuration and cannot be supplied through this tool.",
		returns:
			"JSON operator catalog with exact families/types, observed support or unknown, tested=false, pagination and completeness.",
		schema: catalogSchema,
	}),
	architectureTool({
		annotations: { ...readOnly, idempotentHint: false, readOnlyHint: false },
		description:
			"Refresh, watch, stop, inspect status or diff a bounded source-free TD project graph. Dependency analysis is explicit opt-in; watching may install a local dirty-state observer.",
		example:
			"map_td_project({action:'refresh',rootPath:'/',dependencyAnalysis:true,wait:false,maxDurationMs:3600000})",
		name: TOOL_NAMES.MAP_TD_PROJECT,
		notes:
			"Default root is /project1. Whole-project dependency closure requires rootPath=/ and dependencyAnalysis=true. Source analysis yields dependency evidence and hashes, not raw script contents. No layout or structural refactor is applied. Response paging defaults to limit=200, including status; follow nextOffset for remaining rows or request summaryOnly=true. wait=false returns a background refresh job; inspect action=status for that root. Service limits scans to one job per root and two concurrent jobs. maxDurationMs is a scan budget, not a completion guarantee.",
		returns:
			"JSON bounded graph page, changes or graph/job status; background refresh returns accepted/jobId/progress. Includes totals, nextOffset, scope, freshness and warnings.",
		schema: projectMapSchema,
	}),
	architectureTool({
		annotations: readOnly,
		description:
			"Classify operator roles using explicit tags, exact types and bounded user rules; return deterministic layout proposals with evidence, conflicts and pins. Does not move nodes.",
		example:
			"classify_td_network({rootPath:'/project1',classifierOptions:{pins:['/project1/OUT']}})",
		name: TOOL_NAMES.CLASSIFY_TD_NETWORK,
		notes:
			"Rule matches are explanatory inference, not ownership or measured performance. Overrides and pins are supplied inside classifierOptions. Follow nextOffset to retrieve all classifications; summaryOnly=true omits rows.",
		returns:
			"JSON bounded classification/layout page with totalClassifications and nextOffset; unresolved or mixed roles stay explicit.",
		schema: classifyNetworkSchema,
	}),
	architectureTool({
		annotations: readOnly,
		description:
			"Plan grouping selected sibling operators into a named COMP using a fresh whole-project dependency census. Returns blockers, ports and repairs without applying the change.",
		example:
			"plan_td_refactor({paths:['/project1/noise1','/project1/null1'],name:'TEXTURE_SOURCE'})",
		name: TOOL_NAMES.PLAN_TD_REFACTOR,
		notes:
			"Unknown expressions, ownership or unsupported build evidence can block the plan. A generated plan is not approval or an applied transaction.",
		returns:
			"Immutable refactor plan ID, expected read set, grouping/port preview and explicit blocked reasons.",
		schema: refactorInputSchema,
	}),
	architectureTool({
		annotations: { ...readOnly, destructiveHint: true, readOnlyHint: false },
		description:
			"Apply a previously reviewed server-owned refactor plan, or inspect a durable transaction after an uncertain response. Revalidates fingerprints and requires supported canary/checkpoint safeguards.",
		example:
			"stage_td_refactor({action:'status',transactionId:'refactor_0123456789abcdef0123456789abcdef'})",
		name: TOOL_NAMES.STAGE_TD_REFACTOR,
		notes:
			"Apply requires planId; status requires transactionId. Inspect status after a timeout rather than blindly retrying mutation. Caller-supplied adapter trust or repair scripts are not accepted.",
		returns:
			"JSON transaction status, mutation receipt, checkpoint and rollback/verification outcome.",
		schema: stageRefactorSchema,
	}),
	architectureTool({
		annotations: readOnly,
		description:
			"Read bounded project or explicitly promoted personal architecture notes, labeled by provenance and freshness. Returns no project script or credential contents.",
		example:
			"get_td_memory({projectId:'0123456789abcdef0123456789abcdef',limit:20})",
		name: TOOL_NAMES.GET_TD_MEMORY,
		notes:
			"Project identity is required; personal scope does not mean scanning the user filesystem.",
		returns:
			"JSON notes with observed/inferred/decision/verified kinds and current/stale/unverified provenance.",
		schema: getMemoryInput,
	}),
	architectureTool({
		annotations: { ...readOnly, idempotentHint: false, readOnlyHint: false },
		description:
			"Record, correct, retire or explicitly promote a bounded architecture note. Strict action schemas preserve provenance and prevent implicit personal-memory writes.",
		example:
			"record_td_memory({record:{action:'record',projectId:'0123456789abcdef0123456789abcdef',kind:'decision',title:'Output boundary',text:'Keep OUT as the presentation interface.'}})",
		name: TOOL_NAMES.RECORD_TD_MEMORY,
		notes:
			"The action payload is nested under record. New notes are project-scoped; personal promotion requires action=promote and an existing record ID. Do not store credentials or raw project sources.",
		returns: "JSON memory action result with versioned note and provenance.",
		schema: recordArchitectureMemorySchema,
	}),
];
