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
import type { QuestStep } from "./types";
import { MAX_VERIFY_RETRIES, FORMAT_DIRECTIVE } from "./constants";
import { buildVerificationImpactContext } from "./codebase";
import type { SandboxProfile } from "./sandbox";

// ── Types ────────────────────────────────────────────────────────────────────

export type VerifyOutcome = "pass" | "fail" | "inconclusive";

export interface VerifyResult {
	outcome: VerifyOutcome;
	/** Human-readable evidence for the decision. */
	evidence: string;
	/** How many verification retries this step has consumed (before this result). */
	retryCount: number;
}

export interface VerificationConfig {
	/** Project working directory. */
	cwd: string;
	/** Sub-agent name for the verifier role (e.g. "verifier"). */
	verifierAgent: string;
	/** Whether the step result has an impact-context block available. */
	includeImpact: boolean;
}

/**
 * Decide whether a step that just completed should enter verification.
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
 * Build a sandbox compliance checklist for the verifier prompt.
 *
 * When a sandbox profile is active, this returns additional checklist items
 * the verifier must check. Returns an empty array when sandbox is off.
 */
export function buildSandboxComplianceChecks(profile?: SandboxProfile): string[] {
	if (!profile || profile.mode === "none") return [];

	const checks: string[] = [];

	checks.push(`**Sandbox compliance** (mode: ${profile.mode}):`);

	if (profile.allowedPaths.length > 0) {
		checks.push(
			`- All changed/created files MUST be within allowed paths: ${profile.allowedPaths.map((g) => `\`${g}\``).join(", ")}`,
		);
	} else {
		checks.push(
			`- **CRITICAL:** No files should be created or modified (allowed paths is empty — deny-all).`,
		);
	}

	if (profile.deniedPaths.length > 0) {
		checks.push(
			`- No file matching a denied glob was touched: ${profile.deniedPaths
				.slice(0, 5)
				.map((g) => `\`${g}\``)
				.join(", ")}${profile.deniedPaths.length > 5 ? " …" : ""}`,
		);
	}

	if (!profile.allowNetwork) {
		checks.push(`- No network access was used (curl, git push/fetch, npm publish, etc.).`);
	}

	if (!profile.allowPackageInstall) {
		checks.push(`- No package install commands were run (npm install, pip install, etc.).`);
	}

	if (profile.denyCommands.length > 0) {
		checks.push(
			`- None of these denied commands were used: ${profile.denyCommands
				.slice(0, 5)
				.map((c) => `\`${c}\``)
				.join(", ")}`,
		);
	}

	if (profile.worktree) {
		checks.push(
			`- Worktree branch \`${profile.worktree.baseBranch}\` is consistent (no switching to other branches).`,
			`- Changes are isolated to the worktree path \`${profile.worktree.path}\`.`,
		);
	}

	checks.push(`- Any required project checks (format, lint, test) were actually run and passed.`);

	return checks;
}

/**
 * Build the prompt the orchestrator should give to the verifier sub-agent.
 *
 * This is the pure text construction — the caller (index.ts) passes the
 * returned string to `subagent(agent="verifier")`.
 */
export function buildVerificationPrompt(opts: {
	task: QuestStep;
	taskIndex: number;
	config: VerificationConfig;
	result: string;
	sandboxProfile?: SandboxProfile;
}): string {
	const lines: string[] = [];
	const { task, config, result, taskIndex } = opts;

	lines.push(
		`You are a verifier. Judge whether this completed step is correct and complete.`,
		``,
		`## Step to verify`,
		`**Index:** #${taskIndex + 1}`,
		`**Label:** ${task.content}`,
		``,
		`**Context given to the worker:** ${task.context}`,
		``,
		`## Result to verify`,
		result,
		``,
		`## Verification checklist`,
		`1. Does the result match the step requirements?`,
		`2. Is the implementation correct and complete?`,
		`3. Are there any issues or missing pieces?`,
		FORMAT_DIRECTIVE,
	);

	// Add sandbox compliance checks when a profile is active
	const sandboxChecks = buildSandboxComplianceChecks(opts.sandboxProfile);
	if (sandboxChecks.length > 0) {
		lines.push(``, ...sandboxChecks);
	}

	lines.push(``);

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
