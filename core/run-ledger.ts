/**
 * Append-only per-quest execution log in JSONL format.
 *
 * Each line is a self-contained JSON event recording one unit of progress
 * (task delegation, result, verification). The ledger lives under
 * `~/.pi/agent/quests/<cwdHash>/runs/<questSlug>/run.jsonl` — one file per
 * quest, scoped by cwdHash so two projects can't collide.
 *
 * Pure Node.js module — no pi-* imports so it stays testable and safe to
 * import from any extension.
 */
import { join } from "node:path";
import { AGENT_DIR } from "./paths";
import { cwdHash } from "./hash";
import { appendLine } from "./fs";

// ── Types ────────────────────────────────────────────────────────────────────

export type RunEventKind =
	| "task_start"
	| "task_complete"
	| "task_fail"
	| "verify_start"
	| "verify_pass"
	| "verify_fail"
	| "escalate";

export interface RunEvent {
	/** Discriminator — the event "shape" in the union below. */
	kind: RunEventKind;
	/** 0-based task index within the quest. */
	taskIndex: number;
	/** Short task label for human scanning. */
	taskContent: string;
	/** Sub-agent role that executed (or verified) the task. */
	agent: string;
	/** Model id the sub-agent ran with, when known. */
	model?: string;
	/** Epoch-ms timestamp. */
	timestamp: number;

	// ── kind-specific payloads ───────────────────────────────────────────

	/** "task_complete": final output. */
	result?: string;
	/** "task_fail": error message. */
	error?: string;
	/** Duration in ms, set on completion events. */
	durationMs?: number;
	/** Token count for the sub-agent run, when available. */
	tokensIn?: number;
	tokensOut?: number;
	/** Retry / attempt counters. */
	attempt?: number;
	/** verify_pass / verify_fail: human-readable evidence. */
	evidence?: string;
	/** verify_fail: how many retries remain after this failure. */
	verifyRetriesLeft?: number;
	/** "escalate": model the failing attempts ran with. */
	fromModel?: string;
	/** "escalate": model the task escalates to. */
	toModel?: string;
	/** "escalate": ladder rung index the task moves to. */
	rung?: number;
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Base dir for run ledgers: ~/.pi/agent/quests/<cwdHash>/runs/. */
export function runsDir(cwd: string): string {
	return join(AGENT_DIR, "quests", cwdHash(cwd), "runs");
}

/** Full path to the JSONL file for a specific quest, identified by its slug. */
export function runLedgerPath(cwd: string, questSlug: string): string {
	return join(runsDir(cwd), questSlug, "run.jsonl");
}

// ── Ledger factory ───────────────────────────────────────────────────────────

/**
 * Lightweight ledger for a single quest. Callers create one per active quest
 * and call `record(event)` for each meaningful lifecycle transition.
 *
 * Design note: we use a class rather than a bare function so the `cwd` and
 * `questSlug` are stored once and the caller never spells the path again.
 */
export class RunLedger {
	private readonly path: string;

	constructor(cwd: string, questSlug: string) {
		this.path = runLedgerPath(cwd, questSlug);
	}

	/** Append one event as a JSON line. Best-effort — never throws. */
	record(event: RunEvent): void {
		try {
			appendLine(this.path, JSON.stringify(event));
		} catch {
			/* best-effort observability */
		}
	}
}
