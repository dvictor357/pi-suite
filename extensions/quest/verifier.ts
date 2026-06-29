/**
 * quest/verifier.ts — structured verification loop.
 *
 * Before this module, the "verify on complete" flow was inlined into
 * quest_update() within index.ts: 150 lines of impact-context building,
 * verifier prompt construction, PASS/FAIL/retry logic mixed with the main
 * status-handling switch.
 *
 * This module extracts the pure decisions and prompt building into a testable
 * surface, leaving only the actual sub-agent spawn (which requires SDK values)
 * in the caller.
 */
import type { QuestTask } from "./types";
import { MAX_VERIFY_RETRIES, FORMAT_DIRECTIVE } from "./constants";
import { buildVerificationImpactContext } from "./codebase";

// ── Types ────────────────────────────────────────────────────────────────────

export type VerifyOutcome = "pass" | "fail" | "inconclusive";

export interface VerifyResult {
	outcome: VerifyOutcome;
	/** Human-readable evidence for the decision. */
	evidence: string;
	/** How many verification retries this task has consumed (before this result). */
	retryCount: number;
}

export interface VerificationConfig {
	/** Project working directory. */
	cwd: string;
	/** Sub-agent name for the verifier role (e.g. "verifier"). */
	verifierAgent: string;
	/** Whether the task result has an impact-context block available. */
	includeImpact: boolean;
}

/**
 * Decide whether a task that just completed should enter verification.
 *
 * Returns `true` when the quest's `verifyOnComplete` is set AND the team
 * (if any) has verification enabled.
 */
export function shouldVerify(opts: {
	verifyOnComplete: boolean;
	teamVerificationEnabled: boolean;
}): boolean {
	return opts.verifyOnComplete && opts.teamVerificationEnabled;
}

/**
 * Build the prompt the orchestrator should give to the verifier sub-agent.
 *
 * This is the pure text construction — the caller (index.ts) passes the
 * returned string to `subagent(agent="verifier")`.
 */
export function buildVerificationPrompt(opts: {
	task: QuestTask;
	taskIndex: number;
	config: VerificationConfig;
	result: string;
}): string {
	const lines: string[] = [];
	const { task, config, result, taskIndex } = opts;

	lines.push(
		`You are a verifier. Judge whether this completed task is correct and complete.`,
		``,
		`## Task to verify`,
		`**Index:** #${taskIndex + 1}`,
		`**Label:** ${task.content}`,
		``,
		`**Context given to the worker:** ${task.context}`,
		``,
		`## Result to verify`,
		result,
		``,
		`## Verification checklist`,
		`1. Does the result match the task requirements?`,
		`2. Is the implementation correct and complete?`,
		`3. Are there any issues or missing pieces?`,
		FORMAT_DIRECTIVE,
		``,
	);

	if (config.includeImpact) {
		const impact = buildVerificationImpactContext(
			config.cwd,
			`${task.content}\n${task.context}\n${result}`,
		);
		lines.push(`## Codebase impact`);
		lines.push(impact);
		lines.push(``);
	}

	lines.push(
		`## How to respond`,
		`1. Run any relevant checks (format, lint, tests).`,
		`2. Inspect the output for correctness.`,
		`3. Start your reply with **PASS** or **FAIL**, then a one-paragraph explanation.`,
	);

	return lines.join("\n");
}

/**
 * Return the retry count for the next attempt, plus whether retries remain.
 */
export function nextVerifyAttempt(verifyRetries: number): {
	nextCount: number;
	retriesLeft: number;
	canRetry: boolean;
} {
	const next = verifyRetries + 1;
	const left = MAX_VERIFY_RETRIES - next;
	return { nextCount: next, retriesLeft: left, canRetry: left > 0 };
}

/**
 * Parse the outcome from the verifier's raw text output. The verifier is
 * instructed to start with **PASS** or **FAIL** — this extracts it.
 */
export function parseVerifyOutcome(rawOutput: string): VerifyOutcome {
	const upper = rawOutput.trim().toUpperCase();
	if (upper.startsWith("PASS")) return "pass";
	if (upper.startsWith("FAIL")) return "fail";
	return "inconclusive";
}
