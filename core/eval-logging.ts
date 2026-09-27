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

/**
 * Typed reason a step reached a non-passing terminal state. Turns eval stats
 * from "how often did this fail" into "why did it fail", so routing and
 * diagnostics can act on the cause. The deterministic verification gate emits
 * the *_FAILURE codes; the others are available for the orchestrator/verifier
 * to attribute non-check failures.
 */
export type FailureCode =
	| "TEST_FAILURE"
	| "TYPECHECK_FAILURE"
	| "LINT_FAILURE"
	| "FORMAT_FAILURE"
	| "BAD_PLAN"
	| "CONTEXT_MISSING"
	| "TOOL_FAILURE"
	| "POLICY_BLOCKED"
	| "MODEL_QUALITY"
	| "HUMAN_DECISION_REQUIRED";

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
	/**
	 * Sub-agent token usage attributed to this entry (all attempts since the
	 * step's previous entry). 0 when untracked — legacy rows, or a run whose
	 * tool result carried no usage; check {@link turns} to tell the two apart.
	 */
	tokensIn: number;
	tokensOut: number;
	/** Prompt-cache tokens read / written. Absent when usage was not tracked. */
	cacheRead?: number;
	cacheWrite?: number;
	/** Provider-reported cost in USD. Absent when usage was not tracked. */
	cost?: number;
	/** Peak context size (tokens) of any attributed run. */
	contextTokens?: number;
	/** Assistant turns across attributed runs; present iff usage was tracked. */
	turns?: number;
	/** Thinking level the sub-agent ran with, when reported. */
	thinking?: string;
	/** How many sub-agent attempts were made (0 means first try succeeded). */
	attempts: number;
	/** Model-ladder rung the task finished on, when laddered. */
	rung?: number;
	/** How many rung escalations the task consumed, when laddered. */
	escalations?: number;
	/**
	 * Typed failure reason, when the terminal state was not a clean pass. Set by
	 * the deterministic verification gate (TEST_FAILURE, …) and available for the
	 * orchestrator to attribute other failures. Absent on a verified pass.
	 */
	failureCode?: FailureCode;
	/**
	 * Files the step changed, from git diff at verification time. Machine-checkable
	 * evidence of what the step actually touched — absent when nothing changed or
	 * git was unavailable.
	 */
	changedFiles?: string[];
	/**
	 * One-line summary of the deterministic checks that ran (e.g.
	 * "test:pass typecheck:pass lint:skipped"). Absent when no checks ran.
	 */
	checksSummary?: string;
	/** Epoch-ms timestamp. */
	timestamp: number;
}

/** Append callback for one quest eval log. */
export type EvalLog = (entry: EvalEntry) => void;

/** Base dir for eval logs: ~/.pi/agent/quests/<cwdHash>/evals/. */
export function evalsDir(cwd: string): string {
	return join(runsDir(cwd), "..", "evals");
}

/** Full path to the eval JSONL file for a quest. */
export function evalLogPath(cwd: string, questSlug: string): string {
	return join(evalsDir(cwd), questSlug, "evals.jsonl");
}

/** Append one eval entry as JSONL. Best-effort — never throws. */
function recordEvalEntry(path: string, entry: EvalEntry): void {
	try {
		appendLine(path, JSON.stringify(entry));
	} catch {
		/* best-effort observability */
	}
}

/** Create an append callback for one quest's eval log. */
export function createEvalLog(cwd: string, questSlug: string): EvalLog {
	const path = evalLogPath(cwd, questSlug);
	return (entry) => recordEvalEntry(path, entry);
}
