/**
 * Pure quest_update completion / verify-fail pipeline decisions.
 *
 * Keeps the checks → verify → ladder fail → parallel checking decision core
 * free of SDK / I/O so every branch is unit-testable. `register-planning.ts`
 * is the adapter: load state → decide → apply via `rt.transitionStep` /
 * `persist` / ledger writes.
 *
 * Behavior-preserving extract of the quest_update paths — no intentional
 * policy change.
 */
import type { FailureCode } from "../../core";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../../core";
import {
	buildFailureBrief,
	decideVerifyFailAction,
	renderFailureBriefs,
	rungModel,
	type FailureBrief,
} from "./ladder";
import { MAX_VERIFY_INCONCLUSIVES, parseVerifyReport } from "./verifier";
import type { StepPhase, StepStatus } from "./types";

// ── Snapshot inputs (plain / serializable) ───────────────────────────────────

/** Minimal step fields the completion / verify-fail pipeline reads. */
export interface VerifyStepSnapshot {
	content: string;
	status: StepStatus;
	phase?: StepPhase;
	agent: string;
	result: string | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	/** Inconclusive verifier replies while in verifying (see MAX_VERIFY_INCONCLUSIVES). */
	verifyInconclusives?: number;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	rung?: number;
	escalations?: number;
	model?: string;
	lastModel?: string;
	failureBriefs?: FailureBrief[];
	/** Absolute worktree path when isolated parallel branch is still owned. */
	worktreePath?: string;
}

// ── Prose-inferred / explicit outcome ────────────────────────────────────────

export type VerifyVerdict = "PASS" | "FAIL";

export interface ResolveOutcomeInput {
	/** Structured flag from quest_update(verifyOutcome=…). */
	verifyOutcome?: VerifyVerdict;
	/** Step status — prose inference only applies while status is verifying. */
	stepStatus: StepStatus;
	/** Reported result text (used for prose parse and inferred evidence). */
	resultText?: string;
	/** Explicit verifyEvidence from the tool call. */
	verifyEvidence?: string;
}

export interface ResolvedOutcome {
	/** Resolved verdict, or undefined when neither flag nor prose yields one. */
	outcome: VerifyVerdict | undefined;
	/** True when the verdict was prose-inferred rather than explicitly flagged. */
	inferred: boolean;
	/**
	 * Evidence to attribute to the verdict. Explicit verifyEvidence wins;
	 * when inferred, the result text itself is used.
	 */
	evidence: string | undefined;
}

/**
 * Resolve an effective verification verdict from the structured flag or,
 * when the step is already verifying, from machine-readable / prose parsing
 * of the result text (see parseVerifyReport; parseVerifyOutcome is the prose
 * fallback inside that helper).
 */
export function resolveEffectiveOutcome(input: ResolveOutcomeInput): ResolvedOutcome {
	let outcome: VerifyVerdict | undefined = input.verifyOutcome;
	let structuredEvidence: string | undefined;
	if (!outcome && input.stepStatus === "verifying") {
		const report = parseVerifyReport(input.resultText ?? "");
		if (report.outcome === "pass") outcome = "PASS";
		else if (report.outcome === "fail") outcome = "FAIL";
		if (report.evidence) {
			structuredEvidence = report.impact
				? `${report.evidence} | impact: ${report.impact}`
				: report.evidence;
		}
	}
	const inferred = !input.verifyOutcome && outcome !== undefined;
	const evidence =
		input.verifyEvidence ?? structuredEvidence ?? (inferred ? input.resultText : undefined);
	return { outcome, inferred, evidence };
}

// ── Phase selection (parallel PASS / terminal done) ──────────────────────────

/**
 * Whether a PASS (or terminal done without verification) should land in
 * `checking` to await worktree integration rather than `done`.
 */
export function awaitsIntegration(opts: {
	parallelEnabled: boolean;
	hasWorktree: boolean;
}): boolean {
	return Boolean(opts.parallelEnabled && opts.hasWorktree);
}

/**
 * Phase after a verified PASS: `checking` when parallel+worktree, else `done`.
 */
export function phaseAfterVerifyPass(opts: { parallelEnabled: boolean; hasWorktree: boolean }): {
	phase: "checking" | "done";
	reason: string;
	awaitingIntegration: boolean;
} {
	const awaitingIntegration = awaitsIntegration(opts);
	return {
		phase: awaitingIntegration ? "checking" : "done",
		reason: awaitingIntegration
			? "verification passed; awaiting integration"
			: "verification passed",
		awaitingIntegration,
	};
}

/**
 * Phase for a non-verified terminal update (params.status without verify gate).
 * Parallel branches with a worktree finish in `checking` until integration.
 */
export function phaseAfterTerminalStatus(opts: {
	status: "done" | "failed" | "skipped";
	parallelEnabled: boolean;
	hasWorktree: boolean;
}): { phase: StepPhase; reason: string } {
	if (opts.status === "done" && awaitsIntegration(opts)) {
		return { phase: "checking", reason: "quest_update" };
	}
	return { phase: opts.status, reason: "quest_update" };
}

// ── Shared bookkeeping after a verified failure ──────────────────────────────

export interface VerifyFailBookkeeping {
	verifyResult: string;
	verified: true;
	/** verifyRetries after incrementing for this failure. */
	verifyRetries: number;
	/** Brief to append onto step.failureBriefs (newest last). */
	failureBrief: FailureBrief;
}

function buildFailBookkeeping(
	step: VerifyStepSnapshot,
	evidence: string | undefined,
	inferred: boolean,
	now: number,
): VerifyFailBookkeeping {
	const verifyRetries = step.verifyRetries + 1;
	const failureBrief = buildFailureBrief({
		attempt: (step.failureBriefs?.length ?? 0) + 1,
		model: step.lastModel ?? step.model,
		rung: step.rung,
		evidence: evidence ?? "",
		attempted: step.result,
		inferred,
	});
	// Stabilize timestamp for pure callers that pass `now`.
	failureBrief.timestamp = now;
	return {
		verifyResult: `[FAIL] ${evidence || ""}`.trim(),
		verified: true,
		verifyRetries,
		failureBrief,
	};
}

// ── Event payloads (adapter maps to recordRun / recordEval) ──────────────────

export type VerifyRunEvent =
	| {
			kind: "verify_fail";
			taskIndex: number;
			taskContent: string;
			agent: "verifier";
			timestamp: number;
			evidence: string | undefined;
			verifyRetriesLeft: number;
			failureCode?: FailureCode;
	  }
	| {
			kind: "verify_pass";
			taskIndex: number;
			taskContent: string;
			agent: "verifier";
			timestamp: number;
			evidence: string | undefined;
	  }
	| {
			kind: "escalate";
			taskIndex: number;
			taskContent: string;
			agent: string;
			model: string | undefined;
			fromModel: string | undefined;
			toModel: string | undefined;
			rung: number;
			timestamp: number;
			evidence: string | undefined;
	  };

export type VerifyEvalIntent = {
	status: "done" | "failed";
	verified: boolean;
	evidence: string | undefined;
	failureCode?: FailureCode;
};

// ── Verify FAIL plan (retry / escalate / auto-fail) ──────────────────────────

export interface PlanVerifyFailInput {
	step: VerifyStepSnapshot;
	stepIndex: number;
	evidence: string | undefined;
	inferred: boolean;
	failureCode?: FailureCode;
	/**
	 * Ladder length governing the step. 0 when the step is un-laddered or no
	 * ladder is approved. Adapter: `task.rung !== undefined ? ladder.rungs.length : 0`
	 * with ladder loaded only when rung is set (matches pre-extract).
	 */
	ladderLength: number;
	/** Ladder rungs for model-id resolution on escalate; empty when none. */
	ladderRungs?: readonly string[];
	now?: number;
	policy?: RetryPolicy;
	/**
	 * Character budget for the auto-fail failure-trail block. Adapter computes
	 * via briefBudgetForModel; pure default is large.
	 */
	briefBudget?: number;
	maxBriefs?: number;
}

export type PlanVerifyFailResult =
	| {
			kind: "retry";
			bookkeeping: VerifyFailBookkeeping;
			beginRetryReason: "verification failed";
			nextPhase: "queued";
			transitionReason: "bounded verification retry";
			patches: {
				attempts: 0;
				startedAt: null;
				completedAt: null;
				result: string;
			};
			retriesLeft: number;
			events: VerifyRunEvent[];
			/** Reset lastFiredStepIndex / sameStepCount after apply. */
			resetFireCounters: true;
			details: {
				verified: false;
				outcome: "FAIL";
				retriesLeft: number;
				failureCode?: FailureCode;
			};
			messageLines: string[];
	  }
	| {
			kind: "escalate";
			bookkeeping: VerifyFailBookkeeping;
			beginRetryReason: "model escalation";
			nextPhase: "queued";
			transitionReason: "escalated retry queued";
			patches: {
				attempts: 0;
				verifyRetries: 0;
				rung: number;
				escalations: number;
				startedAt: null;
				completedAt: null;
				result: string;
			};
			fromRung: number | undefined;
			nextRung: number;
			fromModel: string | undefined;
			toModel: string | undefined;
			events: VerifyRunEvent[];
			resetFireCounters: true;
			details: {
				verified: false;
				outcome: "FAIL";
				escalated: true;
				fromRung: number | undefined;
				nextRung: number;
				fromModel: string | undefined;
				toModel: string | undefined;
				escalations: number;
				failureCode?: FailureCode;
			};
			messageLines: string[];
	  }
	| {
			kind: "fail";
			bookkeeping: VerifyFailBookkeeping;
			nextPhase: "failed";
			transitionReason: "retry budget exhausted";
			patches: {
				completedAt: number;
				result: string;
			};
			failureTrail: string;
			events: VerifyRunEvent[];
			evalIntent: VerifyEvalIntent;
			/** Adapter should release claims/dispatch (also done by transitionStep). */
			releaseClaims: true;
			resetFireCounters: true;
			details: {
				verified: false;
				outcome: "FAIL";
				exhausted: true;
				failureCode?: FailureCode;
			};
			messageLines: string[];
	  };

/**
 * Plan the shared verified-failure machine: bookkeeping + retry / escalate /
 * auto-fail. Adapter applies beginStepRetry (I/O), transitionStep, ledger,
 * and persist. Used by both LLM verdict FAIL and deterministic check failures.
 */
export function planVerifyFail(input: PlanVerifyFailInput): PlanVerifyFailResult {
	const policy = input.policy ?? DEFAULT_RETRY_POLICY;
	const now = input.now ?? Date.now();
	const step = input.step;
	const bookkeeping = buildFailBookkeeping(step, input.evidence, input.inferred, now);
	const ladderRungs = input.ladderRungs ?? [];
	const ladderLength = input.ladderLength;
	const decision = decideVerifyFailAction({
		verifyRetries: bookkeeping.verifyRetries,
		rung: step.rung,
		escalations: step.escalations ?? 0,
		ladderLength,
		policy,
	});
	const retriesLeft = decision.retriesLeft;
	const maxVerifyRetries = policy.maxVerifyRetries;

	const failEvent = (verifyRetriesLeft: number): VerifyRunEvent => ({
		kind: "verify_fail",
		taskIndex: input.stepIndex,
		taskContent: step.content,
		agent: "verifier",
		timestamp: now,
		evidence: input.evidence,
		verifyRetriesLeft,
		failureCode: input.failureCode,
	});

	if (decision.action === "retry") {
		const result = `Verification FAIL #${bookkeeping.verifyRetries}: ${input.evidence || "no details"}. Fix and retry (${retriesLeft} retries left).`;
		return {
			kind: "retry",
			bookkeeping,
			beginRetryReason: "verification failed",
			nextPhase: "queued",
			transitionReason: "bounded verification retry",
			patches: {
				attempts: 0,
				startedAt: null,
				completedAt: null,
				result,
			},
			retriesLeft,
			events: [failEvent(retriesLeft)],
			resetFireCounters: true,
			details: {
				verified: false,
				outcome: "FAIL",
				retriesLeft,
				failureCode: input.failureCode,
			},
			messageLines: [
				`❌ Step #${input.stepIndex + 1} **VERIFICATION FAIL**: ${step.content}`,
				input.evidence ? `  Evidence: ${input.evidence}` : "",
				``,
				`Retry ${bookkeeping.verifyRetries}/${maxVerifyRetries}. Step reset to pending with fix context.`,
				`${retriesLeft} verification retries remaining before auto-fail.`,
			],
		};
	}

	if (decision.action === "escalate" && decision.nextRung !== undefined && ladderLength > 0) {
		const fromRung = step.rung;
		const ladderLike = {
			rungs: [...ladderRungs],
			approvedAt: 0,
		};
		const fromModel =
			step.lastModel ??
			step.model ??
			(fromRung !== undefined && ladderRungs.length > 0
				? rungModel(ladderLike, fromRung)
				: undefined);
		const toModel = ladderRungs.length > 0 ? rungModel(ladderLike, decision.nextRung) : undefined;
		const result = `Verification FAIL on ${fromModel ?? "previous model"}: ${input.evidence || "no details"}. Escalating to rung ${decision.nextRung} (${toModel}).`;
		const escalations = (step.escalations ?? 0) + 1;
		return {
			kind: "escalate",
			bookkeeping,
			beginRetryReason: "model escalation",
			nextPhase: "queued",
			transitionReason: "escalated retry queued",
			patches: {
				attempts: 0,
				verifyRetries: 0,
				rung: decision.nextRung,
				escalations,
				startedAt: null,
				completedAt: null,
				result,
			},
			fromRung,
			nextRung: decision.nextRung,
			fromModel,
			toModel,
			events: [
				failEvent(0),
				{
					kind: "escalate",
					taskIndex: input.stepIndex,
					taskContent: step.content,
					agent: step.agent,
					model: fromModel,
					fromModel,
					toModel,
					rung: decision.nextRung,
					timestamp: now,
					evidence: input.evidence,
				},
			],
			resetFireCounters: true,
			details: {
				verified: false,
				outcome: "FAIL",
				escalated: true,
				fromRung,
				nextRung: decision.nextRung,
				fromModel,
				toModel,
				escalations,
				failureCode: input.failureCode,
			},
			messageLines: [
				`⬆️ Step #${input.stepIndex + 1} **VERIFICATION FAIL — ESCALATING**: ${step.content}`,
				input.evidence ? `  Evidence: ${input.evidence}` : "",
				``,
				`Rung ${fromRung ?? "?"} (${fromModel ?? "unknown"}) exhausted. Next delegation will use rung ${decision.nextRung}/${ladderLength - 1} (${toModel}).`,
				`Per-rung verification retry budget reset; failure briefs will be included in the next prompt.`,
			],
		};
	}

	// No retries/escalations left: auto-fail.
	const briefsAfter = [...(step.failureBriefs ?? []), bookkeeping.failureBrief];
	const briefBudget = input.briefBudget ?? 10_000;
	const maxBriefs = input.maxBriefs ?? 3;
	const failureTrail = renderFailureBriefs(briefsAfter, briefBudget, maxBriefs);
	const result = [
		`Verification FAIL after ${maxVerifyRetries} retries${step.escalations ? ` and ${step.escalations} escalation(s)` : ""}: ${input.evidence || "no details"}`,
		failureTrail,
	]
		.filter(Boolean)
		.join("\n\n");

	return {
		kind: "fail",
		bookkeeping,
		nextPhase: "failed",
		transitionReason: "retry budget exhausted",
		patches: {
			completedAt: now,
			result,
		},
		failureTrail,
		events: [failEvent(0)],
		evalIntent: {
			status: "failed",
			verified: false,
			evidence: result,
			failureCode: input.failureCode,
		},
		releaseClaims: true,
		resetFireCounters: true,
		details: {
			verified: false,
			outcome: "FAIL",
			exhausted: true,
			failureCode: input.failureCode,
		},
		messageLines: [
			`❌ Step #${input.stepIndex + 1} **AUTO-FAILED** (${maxVerifyRetries} verification retries exhausted): ${step.content}`,
			input.evidence ? `  Last evidence: ${input.evidence}` : "",
			failureTrail,
		].filter(Boolean),
	};
}

/**
 * Plan a deterministic check-gate failure (same machine as LLM verify FAIL,
 * with a taxonomy failureCode).
 */
export function planCheckFail(
	input: Omit<PlanVerifyFailInput, "inferred"> & {
		/** Pre-built evidence text describing the failed check. */
		evidence: string;
	},
): PlanVerifyFailResult {
	return planVerifyFail({ ...input, inferred: false });
}

// ── Verify PASS plan ─────────────────────────────────────────────────────────

export interface PlanVerifyPassInput {
	step: VerifyStepSnapshot;
	stepIndex: number;
	evidence: string | undefined;
	parallelEnabled: boolean;
	now?: number;
}

export interface PlanVerifyPassResult {
	kind: "pass";
	nextPhase: "checking" | "done";
	transitionReason: string;
	awaitingIntegration: boolean;
	patches: {
		verifyResult: string;
		verified: true;
		completedAt: number;
	};
	events: VerifyRunEvent[];
	evalIntent: VerifyEvalIntent;
	/** Release claims only when not awaiting integration. */
	releaseClaims: boolean;
	resetFireCounters: true;
	details: {
		verified: true;
		outcome: "PASS";
	};
}

/** Plan a verified PASS: phase checking (parallel worktree) or done. */
export function planVerifyPass(input: PlanVerifyPassInput): PlanVerifyPassResult {
	const now = input.now ?? Date.now();
	const step = input.step;
	const { phase, reason, awaitingIntegration } = phaseAfterVerifyPass({
		parallelEnabled: input.parallelEnabled,
		hasWorktree: Boolean(step.worktreePath),
	});
	return {
		kind: "pass",
		nextPhase: phase,
		transitionReason: reason,
		awaitingIntegration,
		patches: {
			verifyResult: `[PASS] ${input.evidence || ""}`.trim(),
			verified: true,
			completedAt: now,
		},
		events: [
			{
				kind: "verify_pass",
				taskIndex: input.stepIndex,
				taskContent: step.content,
				agent: "verifier",
				timestamp: now,
				evidence: input.evidence,
			},
		],
		evalIntent: {
			status: "done",
			verified: true,
			evidence: input.evidence,
		},
		releaseClaims: !awaitingIntegration,
		resetFireCounters: true,
		details: {
			verified: true,
			outcome: "PASS",
		},
	};
}

/** Format the tool response for a verified PASS (post-apply progress / next). */
export function formatVerifyPassMessage(opts: {
	stepIndex: number;
	content: string;
	evidence?: string;
	progress: string;
	nextLabel?: string | null;
	gitPrompt?: string;
}): string {
	return [
		`✅ Step #${opts.stepIndex + 1} **VERIFIED PASS**: ${opts.content}`,
		opts.evidence ? `  Evidence: ${opts.evidence}` : "",
		``,
		`Step marked done. Progress: ${opts.progress} done`,
		opts.nextLabel ? `Next: ${opts.nextLabel}` : "All steps done or blocked!",
		opts.gitPrompt ?? "",
	]
		.filter(Boolean)
		.join("\n");
}

// ── Inconclusive verify plan (one re-prompt, then fail) ───────────────────────

export interface PlanVerifyInconclusiveInput {
	step: VerifyStepSnapshot;
	stepIndex: number;
	/** Unclear verifier text that triggered this decision. */
	resultText?: string;
	now?: number;
	/** Override default MAX_VERIFY_INCONCLUSIVES (tests). */
	maxInconclusives?: number;
}

export type PlanVerifyInconclusiveResult =
	| {
			kind: "reprompt";
			/** verifyInconclusives after this attempt. */
			nextInconclusives: number;
			details: {
				verifying: true;
				inconclusive: true;
				rePrompt: true;
				verifyInconclusives: number;
			};
	  }
	| {
			kind: "fail";
			nextPhase: "failed";
			transitionReason: "inconclusive verification exhausted";
			patches: {
				verifyResult: string;
				verified: true;
				verifyInconclusives: number;
				completedAt: number;
				result: string;
			};
			events: VerifyRunEvent[];
			evalIntent: VerifyEvalIntent;
			releaseClaims: true;
			resetFireCounters: true;
			details: {
				verified: false;
				outcome: "INCONCLUSIVE";
				exhausted: true;
				failureCode: FailureCode;
			};
			messageLines: string[];
			failureCode: FailureCode;
	  };

/**
 * Plan the inconclusive path: first unclear reply → re-prompt once; second
 * (or beyond) → auto-fail with MODEL_QUALITY. Does not consume the
 * verifyRetries budget (that budget is for explicit FAIL verdicts).
 */
export function planVerifyInconclusive(
	input: PlanVerifyInconclusiveInput,
): PlanVerifyInconclusiveResult {
	const now = input.now ?? Date.now();
	const max = input.maxInconclusives ?? MAX_VERIFY_INCONCLUSIVES;
	const current = input.step.verifyInconclusives ?? 0;
	const nextInconclusives = current + 1;
	const unclear = (input.resultText ?? "").trim().slice(0, 500);

	if (current < max) {
		return {
			kind: "reprompt",
			nextInconclusives,
			details: {
				verifying: true,
				inconclusive: true,
				rePrompt: true,
				verifyInconclusives: nextInconclusives,
			},
		};
	}

	const failureCode: FailureCode = "MODEL_QUALITY";
	const evidence = [
		`Verifier reply inconclusive after ${nextInconclusives} attempt(s) (max re-prompts: ${max}).`,
		unclear ? `Last unclear output: ${unclear}` : "No verifier output provided.",
	].join(" ");
	const result = `Verification INCONCLUSIVE after re-prompt: ${evidence}`;

	return {
		kind: "fail",
		nextPhase: "failed",
		transitionReason: "inconclusive verification exhausted",
		patches: {
			verifyResult: `[INCONCLUSIVE] ${evidence}`.trim(),
			verified: true,
			verifyInconclusives: nextInconclusives,
			completedAt: now,
			result,
		},
		events: [
			{
				kind: "verify_fail",
				taskIndex: input.stepIndex,
				taskContent: input.step.content,
				agent: "verifier",
				timestamp: now,
				evidence,
				verifyRetriesLeft: 0,
				failureCode,
			},
		],
		evalIntent: {
			status: "failed",
			verified: false,
			evidence: result,
			failureCode,
		},
		releaseClaims: true,
		resetFireCounters: true,
		details: {
			verified: false,
			outcome: "INCONCLUSIVE",
			exhausted: true,
			failureCode,
		},
		messageLines: [
			`❌ Step #${input.stepIndex + 1} **AUTO-FAILED** (inconclusive verification after re-prompt): ${input.step.content}`,
			`  FailureCode: ${failureCode}`,
			unclear ? `  Last unclear output: ${unclear}` : "",
		].filter(Boolean),
		failureCode,
	};
}

// ── Terminal non-verify update plan ──────────────────────────────────────────

export interface PlanTerminalUpdateInput {
	step: VerifyStepSnapshot;
	stepIndex: number;
	status: "done" | "failed" | "skipped";
	result?: string;
	parallelEnabled: boolean;
	now?: number;
}

export interface PlanTerminalUpdateResult {
	kind: "terminal";
	nextPhase: StepPhase;
	transitionReason: string;
	patches: {
		result?: string;
		completedAt?: number;
	};
	/** True when phase is done/failed/skipped (adapter releases claims). */
	releaseClaims: boolean;
	resetFireCounters: true;
}

/**
 * Plan a normal quest_update status change without the verification gate
 * (or after the gate was skipped / disabled).
 */
export function planTerminalUpdate(input: PlanTerminalUpdateInput): PlanTerminalUpdateResult {
	const now = input.now ?? Date.now();
	const { phase, reason } = phaseAfterTerminalStatus({
		status: input.status,
		parallelEnabled: input.parallelEnabled,
		hasWorktree: Boolean(input.step.worktreePath),
	});
	const patches: PlanTerminalUpdateResult["patches"] = {};
	if (input.result) patches.result = input.result;
	if (input.status === "done" || input.status === "failed") {
		patches.completedAt = now;
	}
	const releaseClaims = phase === "done" || phase === "failed" || phase === "skipped";
	return {
		kind: "terminal",
		nextPhase: phase,
		transitionReason: reason,
		patches,
		releaseClaims,
		resetFireCounters: true,
	};
}

/** Format the tool response for a terminal (non-verify) status update. */
export function formatTerminalUpdateMessage(opts: {
	stepIndex: number;
	content: string;
	status: "done" | "failed" | "skipped";
	result?: string;
	progress: string;
	nextLabel?: string | null;
	questActive: boolean;
	gitPrompt?: string;
}): string {
	return [
		`Step #${opts.stepIndex + 1} → **${opts.status.toUpperCase()}**: ${opts.content}`,
		opts.result ? `  Result: ${opts.result}` : "",
		``,
		`Progress: ${opts.progress} done`,
		opts.nextLabel ? `Next: ${opts.nextLabel}` : "All steps done or blocked!",
		``,
		opts.questActive
			? "Auto-pilot will fire the next step."
			: "Quest is paused. /quest resume to continue.",
		opts.gitPrompt ?? "",
	]
		.filter(Boolean)
		.join("\n");
}

// ── Snapshot helper ──────────────────────────────────────────────────────────

/** Snapshot a live quest step for pure verify/completion decisions. */
export function snapshotStepForVerify(step: {
	content: string;
	status: StepStatus;
	phase?: StepPhase;
	agent: string;
	result: string | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	verifyInconclusives?: number;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	rung?: number;
	escalations?: number;
	model?: string;
	lastModel?: string;
	failureBriefs?: FailureBrief[];
	sandboxArtifacts?: { worktreePath?: string } | null;
}): VerifyStepSnapshot {
	return {
		content: step.content,
		status: step.status,
		phase: step.phase,
		agent: step.agent,
		result: step.result,
		verified: step.verified,
		verifyResult: step.verifyResult,
		verifyRetries: step.verifyRetries,
		verifyInconclusives: step.verifyInconclusives,
		attempts: step.attempts,
		startedAt: step.startedAt,
		completedAt: step.completedAt,
		rung: step.rung,
		escalations: step.escalations,
		model: step.model,
		lastModel: step.lastModel,
		failureBriefs: step.failureBriefs,
		worktreePath: step.sandboxArtifacts?.worktreePath,
	};
}

/**
 * Apply verify-fail bookkeeping onto a mutable step (adapter use).
 * Appends the failure brief; does not transition phase.
 */
export function applyVerifyFailBookkeeping(
	step: {
		verifyResult: string | null;
		verified: boolean;
		verifyRetries: number;
		failureBriefs?: FailureBrief[];
	},
	bookkeeping: VerifyFailBookkeeping,
): void {
	step.verifyResult = bookkeeping.verifyResult;
	step.verified = bookkeeping.verified;
	step.verifyRetries = bookkeeping.verifyRetries;
	step.failureBriefs = [...(step.failureBriefs ?? []), bookkeeping.failureBrief];
}
