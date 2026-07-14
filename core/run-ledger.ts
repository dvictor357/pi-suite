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
import type { FailureCode } from "./eval-logging";

export type RunEventKind =
	| "task_start"
	| "task_complete"
	| "task_fail"
	| "verify_start"
	| "verify_pass"
	| "verify_fail"
	| "checks"
	| "escalate"
	| "timeout"
	| "conflict"
	| "phase_transition";

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
	/** Durable phase transition metadata. */
	fromPhase?: string;
	toPhase?: string;
	dispatchId?: string;
	reason?: string;

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
	/** "checks" / "verify_fail": typed failure reason (see FailureCode). */
	failureCode?: FailureCode;
	/**
	 * "checks": compact per-check outcome summary, e.g.
	 * "test:pass typecheck:fail lint:skipped".
	 */
	checksSummary?: string;
}

/** Append callback for one quest run ledger. */
export type RunLedger = (event: RunEvent) => void;

/** Base dir for run ledgers: ~/.pi/agent/quests/<cwdHash>/runs/. */
export function runsDir(cwd: string): string {
	return join(AGENT_DIR, "quests", cwdHash(cwd), "runs");
}

/** Full path to the JSONL file for a specific quest, identified by its slug. */
export function runLedgerPath(cwd: string, questSlug: string): string {
	return join(runsDir(cwd), questSlug, "run.jsonl");
}

/** Append one event as a JSON line. Best-effort — never throws. */
export function recordRunEvent(path: string, event: RunEvent): void {
	try {
		appendLine(path, JSON.stringify(event));
	} catch {
		/* best-effort observability */
	}
}

/** Create an append callback for one quest's run ledger. */
export function createRunLedger(cwd: string, questSlug: string): RunLedger {
	const path = runLedgerPath(cwd, questSlug);
	return (event) => recordRunEvent(path, event);
}
