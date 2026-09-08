import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeExecutor, ProjectGraph } from "../types.js";
import {
	graphDigest,
	planRefactor,
	type RefactorPlan,
	type VerifiedToolingAdapter,
} from "./planner.js";
import {
	comparisonPreview,
	type RefactorComparison,
	renderRefactorComparison,
} from "./report.js";
import { buildCanaryScript, buildStageScript } from "./scripts.js";
export interface RefactorTransaction {
	id: string;
	state: "running" | "complete" | "failed" | "uncertain";
	checkpoint: string;
	checkpointRequested?: string;
	staged: string;
	stagedRequested?: string;
	sessionId: string;
	phase: string;
	comparison?: RefactorComparison;
	comparisonReport?: "written" | "unavailable";
	comparisonStatusPersisted?: boolean;
	error?: string;
	recovery?: string;
	[key: string]: unknown;
}
export function decodeBridge(value: unknown): unknown {
	let v = value;
	for (let i = 0; i < 4; i++) {
		if (typeof v === "string") {
			v = JSON.parse(v);
			continue;
		}
		if (v && typeof v === "object" && "result" in v) {
			v = (v as { result: unknown }).result;
			continue;
		}
		break;
	}
	return v;
}
export async function runRefactorCanary(executor: BridgeExecutor) {
	const result = decodeBridge(await executor.execute(buildCanaryScript())) as {
		passed?: boolean;
		build?: string;
		receiptId?: string;
	};
	if (
		result?.passed !== true ||
		!result.receiptId ||
		!["2025.33230", "202533230"].includes(result.build ?? "")
	)
		throw new Error("Native collapse canary did not pass on build 2025.33230");
	return Object.freeze({ ...result });
}
let serial: Promise<unknown> = Promise.resolve();
const validId = (id: string) => /^refactor_[a-f0-9]{32}$/.test(id);
/** Journals progress, not ACID rollback. A transport failure is an uncertain action,
 * never a reason to submit the mutation again. The retained checkpoint is recovery.
 */
export class RefactorStager {
	constructor(
		private readonly executor: BridgeExecutor,
		private readonly stateRoot: string,
		private readonly adapters: VerifiedToolingAdapter[] = [],
	) {}
	private file(id: string) {
		if (!validId(id)) throw new Error("Invalid refactor transaction ID");
		return path.join(this.stateRoot, "refactor", `${id}.json`);
	}
	private async read(id: string): Promise<RefactorTransaction | null> {
		try {
			return JSON.parse(await readFile(this.file(id), "utf8"));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}
	private async persist(record: RefactorTransaction, initial = false) {
		const filename = this.file(record.id);
		await mkdir(path.dirname(filename), { mode: 0o700, recursive: true });
		if (initial) {
			await writeFile(filename, JSON.stringify(record, null, 2), {
				flag: "wx",
				mode: 0o600,
			});
			return;
		}
		const temp = `${filename}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(record, null, 2), {
			flag: "wx",
			mode: 0o600,
		});
		await rename(temp, filename);
	}
	private async persistResult(
		record: RefactorTransaction,
	): Promise<RefactorTransaction> {
		await this.persist(record);
		const markdown = renderRefactorComparison(record);
		if (markdown === null) return record;
		const filename = this.file(record.id).replace(/\.json$/, ".md");
		const temporary = `${filename}.${randomUUID()}.tmp`;
		let comparisonReport: "written" | "unavailable" = "written";
		try {
			await writeFile(temporary, markdown, { flag: "wx", mode: 0o600 });
			await rename(temporary, filename);
		} catch {
			comparisonReport = "unavailable";
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
		const next = { ...record, comparisonReport };
		try {
			await this.persist(next);
			return next;
		} catch {
			// The authoritative native receipt was already persisted above. Failure
			// to add ancillary report metadata must never reclassify its outcome.
			return { ...next, comparisonStatusPersisted: false };
		}
	}
	async status(id: string): Promise<RefactorTransaction | null> {
		const record = await this.read(id);
		if (!record) return null;
		if (record.state !== "running" && record.state !== "uncertain")
			return structuredClone(record);
		// Read-only reconciliation; no duplicate stage script is ever dispatched.
		try {
			const value = decodeBridge(
				await this.executor.execute(
					`import json,sys\nm=sys.modules.get('_td_mcp_architecture')\nresult=json.dumps(getattr(m,'refactor_transactions',{}).get('${id}'))`,
				),
			) as RefactorTransaction | null;
			if (
				value?.id === id &&
				value.sessionId === record.sessionId &&
				["complete", "failed"].includes(value.state)
			) {
				const next = await this.persistResult({
					...record,
					...value,
					comparison: record.comparison,
				});
				return structuredClone(next);
			}
		} catch {
			/* Keep the journal's explicit uncertainty when the bridge is unavailable. */
		}
		return {
			...record,
			recovery:
				"Outcome is not confirmed. Retain checkpoint and inspect this transaction; never retry blindly.",
			state: "uncertain",
		};
	}
	stage(
		plan: RefactorPlan,
		currentGraph: ProjectGraph,
	): Promise<RefactorTransaction> {
		const task = serial.then(() => this.perform(plan, currentGraph));
		serial = task.catch(() => undefined);
		return task;
	}
	private async perform(
		plan: RefactorPlan,
		currentGraph: ProjectGraph,
	): Promise<RefactorTransaction> {
		const prior = await this.read(plan.id);
		if (prior) return (await this.status(plan.id)) ?? prior;
		const checked = planRefactor(currentGraph, plan.input, this.adapters);
		if (
			checked.id !== plan.id ||
			graphDigest(currentGraph) !== plan.graphDigest
		)
			throw new Error("Stale or altered plan: rescan and preview again");
		if (checked.blockedReasons.length)
			throw new Error(`Refactor blocked: ${checked.blockedReasons.join("; ")}`);
		const original = path.parse(checked.projectPath);
		const stem = path.join(original.dir, `${original.name}.${checked.id}`);
		const record: RefactorTransaction = {
			checkpoint: `${stem}.checkpoint.toe`,
			checkpointRequested: `${stem}.checkpoint.toe`,
			comparison: comparisonPreview(checked),
			id: checked.id,
			phase: "dispatching",
			sessionId: checked.sessionId,
			staged: `${stem}.staged.toe`,
			stagedRequested: `${stem}.staged.toe`,
			state: "running",
		};
		try {
			await this.persist(record, true);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST")
				return (
					(await this.status(plan.id)) ?? {
						checkpoint: "",
						id: checked.id,
						phase: "journal-conflict",
						sessionId: checked.sessionId,
						staged: "",
						state: "uncertain",
					}
				);
			throw e;
		}
		try {
			const response = decodeBridge(
				await this.executor.execute(
					buildStageScript(checked, record.checkpoint, record.staged),
				),
			) as RefactorTransaction;
			if (
				response?.id !== record.id ||
				response.sessionId !== record.sessionId ||
				!["complete", "failed"].includes(response.state)
			)
				throw new Error(
					"Bridge returned no conclusive matching transaction receipt",
				);
			const final = await this.persistResult({
				...record,
				...response,
				comparison: record.comparison,
			});
			return structuredClone(final);
		} catch (error) {
			const uncertain: RefactorTransaction = {
				...record,
				error:
					error instanceof Error ? error.message : "Bridge outcome unavailable",
				recovery:
					"Mutation may have run. Query this ID; no automatic retry. Checkpoint, if created, remains available.",
				state: "uncertain",
			};
			await this.persist(uncertain);
			return structuredClone(uncertain);
		}
	}
}
