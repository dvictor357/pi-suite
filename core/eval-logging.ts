/**
 * Per-task eval audit trail in JSONL format.
 *
 * Every time a quest task reaches a terminal state (done, failed, skipped,
 * verified), one record is appended to an eval log. Over many quests this
 * builds a post-mortem dataset: which agents/models succeeded at which tasks,
 * average completion time, token budgets, verification pass/fail rates.
 *
 * Path: `~/.pi/agent/quests/<cwdHash>/evals/<questSlug>/evals.jsonl`
 *
 * Pure Node.js — no pi-* imports.
 */
import { join } from "node:path";
import { appendLine } from "./fs";
import { runsDir } from "./run-ledger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvalEntry {
	/** Quest name. */
	quest: string;
	/** The quest's slug (filesystem-safe name). */
	questSlug: string;
	/** 0-based task index. */
	taskIndex: number;
	/** Short task description. */
	taskContent: string;
	/** Sub-agent role. */
	agent: string;
	/** Model id, when known. */
	model?: string;
	/** Terminal status of the task. */
	status: "done" | "failed" | "skipped";
	/** Whether a verifier approved the output. */
	verified: boolean;
	/** Human-readable verification evidence (pass or fail reason). */
	verifyEvidence: string | null;
	/** Wall-clock duration in ms. */
	durationMs: number;
	/** Token usage for the sub-agent run, when tracked. */
	tokensIn: number;
	tokensOut: number;
	/** How many sub-agent attempts were made (0 means first try succeeded). */
	attempts: number;
	/** Epoch-ms timestamp. */
	timestamp: number;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Full path to the eval JSONL file for a quest. */
export function evalLogPath(cwd: string, questSlug: string): string {
	return join(runsDir(cwd), "..", "evals", questSlug, "evals.jsonl");
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Lightweight eval recorder for one quest. Create it at quest start, call
 * `record(entry)` on every terminal task outcome.
 */
export class EvalLog {
	private readonly path: string;

	constructor(cwd: string, questSlug: string) {
		this.path = evalLogPath(cwd, questSlug);
	}

	/** Append one eval entry as JSONL. Best-effort — never throws. */
	record(entry: EvalEntry): void {
		try {
			appendLine(this.path, JSON.stringify(entry));
		} catch {
			/* best-effort observability */
		}
	}
}
