import { z } from "zod";
import type { RefactorPlan } from "./planner.js";

const LIMIT = 64;
const clip = (text: string) => text.slice(0, 512);
const textSchema = z.string().max(512);
const count = z.number().int().min(0).max(1_000_000);
const comparisonSchema = z.object({
	build: textSchema,
	container: textSchema,
	id: z.string().regex(/^refactor_[a-f0-9]{32}$/),
	pathCount: count,
	paths: z
		.array(z.object({ after: textSchema, before: textSchema }))
		.max(LIMIT),
	portCount: count,
	ports: z
		.array(
			z.object({
				direction: z.enum(["in", "out"]),
				output: count,
				source: textSchema,
				targetCount: count,
				targets: z.array(textSchema).max(8),
			}),
		)
		.max(LIMIT),
	repairCount: count,
	repairs: z
		.array(
			z.object({
				after: z.array(textSchema).max(16),
				before: z.array(textSchema).max(16),
				owner: textSchema,
				parameter: textSchema,
				targetCount: count,
			}),
		)
		.max(LIMIT),
	revision: count,
	sessionId: z.string().max(512),
	wireCount: count,
});
export type RefactorComparison = z.infer<typeof comparisonSchema>;

/** Capped, source-free plan evidence survives response loss and daemon restart.
 * It is built from the revalidated server plan, never from bridge response fields. */
export function comparisonPreview(plan: RefactorPlan): RefactorComparison {
	return comparisonSchema.parse({
		build: plan.build,
		container: clip(plan.containerPath),
		id: plan.id,
		pathCount: plan.affectedPaths.length,
		paths: plan.affectedPaths.slice(0, LIMIT).map((before) => ({
			after: clip(
				`${plan.containerPath}${before.slice(plan.parentPath.length)}`,
			),
			before: clip(before),
		})),
		portCount: plan.ports.length,
		ports: plan.ports.slice(0, LIMIT).map((port) => ({
			direction: port.direction,
			output: port.outputIndex,
			source: clip(port.source),
			targetCount: port.edges.length,
			targets: port.edges
				.slice(0, 8)
				.map((edge) => clip(`${edge.target} [input ${edge.inputIndex}]`)),
		})),
		repairCount: plan.repairs.length,
		repairs: plan.repairs.slice(0, LIMIT).map((repair) => ({
			after: repair.targetsAfter.slice(0, 16).map(clip),
			before: repair.targetsBefore.slice(0, 16).map(clip),
			owner: clip(repair.owner),
			parameter: clip(repair.parameter),
			targetCount: repair.targetsBefore.length,
		})),
		revision: plan.revision,
		sessionId: plan.sessionId,
		wireCount: plan.wireCensus.length,
	});
}
const receiptSchema = z.object({
	checkpoint: z.string().max(4096),
	comparison: comparisonSchema,
	id: z.string(),
	phase: z.literal("saved"),
	sessionId: z.string(),
	staged: z.string().max(4096),
	state: z.literal("complete"),
});
const cell = (value: unknown) =>
	Array.from(String(value).slice(0, 512))
		.map((character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
				? " "
				: character,
		)
		.join("")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("|", "&#124;")
		.replaceAll("`", "&#96;")
		.replaceAll("[", "&#91;")
		.replaceAll("]", "&#93;");
const row = (...values: unknown[]) => `| ${values.map(cell).join(" | ")} |`;

/** Whitelist fields; never serialize raw errors, source, credentials or arbitrary
 * receipt extensions. Quantities are plan counts, not a post-change rescan. */
export function renderRefactorComparison(record: unknown): string | null {
	const parsed = receiptSchema.safeParse(record);
	if (!parsed.success) return null;
	const receipt = parsed.data;
	const plan = receipt.comparison;
	if (receipt.id !== plan.id || receipt.sessionId !== plan.sessionId)
		return null;
	const lines: string[] = [];
	let bytes = 0;
	let omitted = false;
	const append = (line = "") => {
		if (omitted) return;
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > 60_000) {
			omitted = true;
			lines.push(
				"",
				"Additional comparison rows omitted by the 60 KB report budget.",
			);
			return;
		}
		lines.push(line);
		bytes += size;
	};
	const table = (
		title: string,
		headers: string[],
		rows: string[],
		total: number,
	) => {
		append();
		append(`## ${title}`);
		append();
		append(row(...headers));
		append(row(...headers.map(() => "---")));
		for (const line of rows) append(line);
		if (total > rows.length)
			append(
				`${total - rows.length} additional entries omitted by the ${LIMIT}-row section limit.`,
			);
		if (!total) append("No changes in this category.");
	};
	append("# Refactor comparison");
	append();
	append("Transaction receipt: complete");
	append();
	append(`Transaction: ${cell(receipt.id)}`);
	append(`Build: ${cell(plan.build)} · Planned revision: ${plan.revision}`);
	append();
	append(
		"This compares the validated plan with the completed staging receipt. Path, wire, reference and error guards run before the staging script reports completion. It is not a new graph census, visual review or performance test.",
	);
	table(
		"Working copies",
		["Artifact", "Recorded active path"],
		[
			row("Checkpoint", receipt.checkpoint),
			row("Staged result", receipt.staged),
		],
		2,
	);
	append();
	append(`Container: ${cell(plan.container)}`);
	append(
		`Planned moved operators: ${plan.pathCount}; boundary groups: ${plan.portCount}; constant-reference repairs: ${plan.repairCount}; original wire census: ${plan.wireCount}.`,
	);
	table(
		"Operator paths",
		["Before", "After"],
		plan.paths.map((path) => row(path.before, path.after)),
		plan.pathCount,
	);
	table(
		"Boundary groups",
		["Direction", "Source", "Output", "Targets (first 8)", "Total targets"],
		plan.ports.map((port) =>
			row(
				port.direction,
				port.source,
				port.output,
				port.targets.join("; "),
				port.targetCount,
			),
		),
		plan.portCount,
	);
	table(
		"Constant OP reference repairs",
		[
			"Owner / parameter",
			"Before (first 16)",
			"After (first 16)",
			"Total targets",
		],
		plan.repairs.map((repair) =>
			row(
				`${repair.owner} / ${repair.parameter}`,
				repair.before.join("; "),
				repair.after.join("; "),
				repair.targetCount,
			),
		),
		plan.repairCount,
	);
	append();
	append(
		"Report cells are clipped to 512 characters. JSON is the authoritative transaction receipt. Keep both native save files when TD writes a numbered project and a link filename; they may have different hashes.",
	);
	append();
	append(
		"The original saved artwork and checkpoint remain recovery files. This is not an ACID rollback guarantee. No source bodies, arbitrary error strings or receipt extensions are included here.",
	);
	return `${lines.join("\n")}\n`;
}
