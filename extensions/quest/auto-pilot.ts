/**
 * Pure auto-pilot decisions for the `agent_end` handler.
 *
 * Keeps the sequential decision tree (abort, timeout, unresolved requeue,
 * completion, stall, attempt-budget, burst, fire) free of SDK / I/O so every
 * branch is unit-testable. `register-events.ts` is the adapter: load state →
 * decide → apply side effects (persist, UI, fireStep, fireParallelBatch, …).
 *
 * ## Attempt semantics (turn-ended-without-update vs true failure)
 *
 * - `fireStep` / parallel dispatch increment `step.attempts` when a step enters
 *   `dispatching`/`running`. That count is the attempt budget unit.
 * - When a turn ends without `quest_update` leaving a step in
 *   `dispatching`/`running`, {@link planUnresolvedRequeues} requeues (or fails
 *   if `attempts > maxRetries`). Requeue itself does **not** increment attempts;
 *   the **next** fire does. So an orchestrator that ends the turn without
 *   updating the step burns one attempt per fire→unresolved→requeue cycle until
 *   the budget is exhausted (`fail_budget` / ledger fail).
 * - This is intentional fairness: the first unresolved requeue does not
 *   immediately fail the step — remaining budget is available for easy recovery
 *   if the model simply forgot to call `quest_update`. Full budget burn only
 *   happens after repeated unresolved turns.
 * - Wall-clock timeouts ({@link planTimeoutActions}) use the same requeue/fail
 *   budget and record a ledger `timeout` event. Verifying steps are included
 *   (unlike unresolved requeue, which only covers dispatching/running).
 * - True verified failures go through the verifier/ladder path, not this tree.
 */
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../../core";
import { decideVerifyFailAction } from "./ladder";
import { checkTimeout, DEFAULT_STEP_TIMEOUT_MS } from "./phase-loop";
import type { StepPhase, StepStatus } from "./types";

export { DEFAULT_STEP_TIMEOUT_MS };

/** Resolve phase from snapshot fields only (mirrors phase-loop.resolvePhase). */
function phaseOf(step: { status: StepStatus; phase?: StepPhase }): StepPhase {
	if (step.phase) return step.phase;
	if (
		step.status === "done" ||
		step.status === "failed" ||
		step.status === "skipped" ||
		step.status === "verifying"
	) {
		return step.status;
	}
	if (step.status === "running") return "running";
	return "queued";
}

// ── Snapshot inputs (plain / serializable) ───────────────────────────────────

/** Minimal step fields the decision tree reads. */
export interface AutoPilotStepSnapshot {
	content: string;
	status: StepStatus;
	phase?: StepPhase;
	agent: string;
	attempts: number;
	dependencies: number[];
	rung?: number;
	escalations?: number;
	result?: string | null;
	/** Epoch-ms when phase last changed — used for sequential timeout sweep. */
	phaseChangedAt?: number;
	/** Epoch-ms when the current attempt started — timeout fallback. */
	startedAt?: number | null;
}

/** Minimal quest fields the decision tree reads. */
export interface AutoPilotQuestSnapshot {
	name: string;
	lastFiredStepIndex: number;
	sameStepCount: number;
	stepsSincePause: number;
	steps: readonly AutoPilotStepSnapshot[];
	/** When true, sequential fire is replaced by parallel-batch fall-through handling. */
	parallelEnabled: boolean;
	/**
	 * Wall-clock budget for a sequential step in dispatching/running/verifying.
	 * Defaults to {@link DEFAULT_STEP_TIMEOUT_MS} when omitted.
	 */
	stepTimeoutMs?: number;
}

export interface AutoPilotInput {
	wasAborted: boolean;
	hasUI: boolean;
	quest: AutoPilotQuestSnapshot;
	/**
	 * Ladder length for the next pending step when it has a rung. 0 when no
	 * ladder governs the step (or the step is un-laddered). The adapter loads
	 * this from project memory; the pure tree only needs the length.
	 */
	nextStepLadderLength?: number;
	policy?: RetryPolicy;
	/** Injected clock for timeout tests (defaults to Date.now()). */
	now?: number;
}

// ── Decision variants ────────────────────────────────────────────────────────

/** Unresolved dispatching/running steps to fail or requeue first. */
export type UnresolvedAction =
	| { index: number; action: "fail" }
	| { index: number; action: "requeue" };

/** Timed-out dispatching/running/verifying steps to fail or requeue. */
export type TimeoutAction =
	| { index: number; action: "fail"; elapsedMs: number }
	| { index: number; action: "requeue"; elapsedMs: number };

/**
 * Terminal outcome after timeout/unresolved requeues (and optional parallel try).
 * Adapter applies I/O for each kind; pure function never touches disk/UI.
 */
export type SequentialDecision =
	| { kind: "complete" }
	| {
			kind: "verifying";
			indices: number[];
			/** Every step is done/skipped/failed/verifying — no open pending deps. */
			allResolved: boolean;
			/** When true and allResolved, adapter may offer verify/skip/pause UI. */
			offerPrompt: boolean;
	  }
	| {
			kind: "failed_steps";
			indices: number[];
			/** When true, adapter may offer retry/skip/pause UI. */
			offerPrompt: boolean;
	  }
	| { kind: "blocked" }
	| {
			kind: "stall";
			index: number;
			content: string;
			sameStepCount: number;
			offerPrompt: boolean;
	  }
	| { kind: "fail_budget"; index: number }
	| {
			/**
			 * Attempt budget exhausted but ladder can escalate. Adapter applies
			 * escalate mutations, then continues with `then` (burst/fire) — matching
			 * the pre-extract fall-through (no return after successful escalate).
			 */
			kind: "escalate";
			index: number;
			nextRung: number;
			/** sameStepCount after escalate reset (always 0). */
			sameStepCount: number;
			then: ReadyDecision;
	  }
	| ({ kind: "ready" } & ReadyDecision);

/** Fire/burst decision when a next step is ready (and not stalled / failed). */
export interface ReadyDecision {
	index: number;
	content: string;
	agent: string;
	/** Stall counter to stamp before fire / burst (1 when index changed, else +1). */
	sameStepCount: number;
	/**
	 * Burst checkpoint: stepsSincePause >= maxBurst.
	 * - offerConfirm: hasUI → confirm dialog; continue resets burst counters then fires.
	 * - !offerConfirm: auto-pause (no UI).
	 */
	burst: { hit: false } | { hit: true; offerConfirm: boolean; stepsSincePause: number };
	/** Sequential fire vs parallel-mode conflict pause. */
	fire: "step" | "parallel_conflict";
	doneCount: number;
	totalCount: number;
}

export type AutoPilotDecision =
	| { kind: "abort_pause" }
	| {
			kind: "proceed";
			/** Wall-clock timeouts applied before unresolved requeues. */
			timeouts: TimeoutAction[];
			unresolved: UnresolvedAction[];
			/**
			 * When true, adapter calls `fireParallelBatch`. If that returns true,
			 * stop — do not apply `sequential`. If false, apply `sequential`.
			 */
			tryParallel: boolean;
			sequential: SequentialDecision;
	  };

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Plan fail/requeue for steps still in dispatching/running after a turn ends. */
export function planUnresolvedRequeues(
	steps: readonly AutoPilotStepSnapshot[],
	maxRetries: number,
): UnresolvedAction[] {
	const plan: UnresolvedAction[] = [];
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const phase = phaseOf(step);
		if (phase !== "dispatching" && phase !== "running") continue;
		if (step.attempts > maxRetries) {
			plan.push({ index, action: "fail" });
		} else {
			plan.push({ index, action: "requeue" });
		}
	}
	return plan;
}

/**
 * Plan fail/requeue for steps past the wall-clock phase deadline.
 * Covers dispatching/running/verifying (same phases as {@link checkTimeout}).
 */
export function planTimeoutActions(
	steps: readonly AutoPilotStepSnapshot[],
	maxRetries: number,
	timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
	now: number = Date.now(),
): TimeoutAction[] {
	const plan: TimeoutAction[] = [];
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const elapsedMs = checkTimeout(step, timeoutMs, now);
		if (!elapsedMs) continue;
		if (step.attempts > maxRetries) {
			plan.push({ index, action: "fail", elapsedMs });
		} else {
			plan.push({ index, action: "requeue", elapsedMs });
		}
	}
	return plan;
}

/**
 * Simulate post-requeue step statuses so nextPendingStep can be computed purely.
 * Requeued → pending/queued; failed → failed. Does not mutate the input.
 */
export function simulateAfterUnresolved(
	steps: readonly AutoPilotStepSnapshot[],
	unresolved: readonly UnresolvedAction[],
): AutoPilotStepSnapshot[] {
	const out = steps.map((s) => ({ ...s }));
	for (const u of unresolved) {
		const step = out[u.index];
		if (!step) continue;
		if (u.action === "fail") {
			step.status = "failed";
			step.phase = "failed";
		} else {
			step.status = "pending";
			step.phase = "queued";
		}
	}
	return out;
}

/** Apply timeout plan then unresolved plan onto a snapshot (pure). */
export function simulateAfterTimeoutsAndUnresolved(
	steps: readonly AutoPilotStepSnapshot[],
	timeouts: readonly TimeoutAction[],
	unresolved: readonly UnresolvedAction[],
): AutoPilotStepSnapshot[] {
	const afterTimeouts = simulateAfterUnresolved(
		steps,
		timeouts.map((t) => ({ index: t.index, action: t.action })),
	);
	return simulateAfterUnresolved(afterTimeouts, unresolved);
}

/** Pure next-pending selection over a snapshot (mirrors steering.nextPendingStep). */
export function nextPendingFromSnapshot(
	steps: readonly AutoPilotStepSnapshot[],
): { step: AutoPilotStepSnapshot; index: number } | null {
	for (let i = 0; i < steps.length; i++) {
		const t = steps[i];
		if (t.status !== "pending" || phaseOf(t) !== "queued") continue;
		const allDepsMet = t.dependencies.every((d) => {
			const s = steps[d]?.status;
			return s === "done" || s === "skipped";
		});
		if (!allDepsMet) continue;
		return { step: t, index: i };
	}
	return null;
}

function decideWhenNoNext(
	steps: readonly AutoPilotStepSnapshot[],
	hasUI: boolean,
): SequentialDecision {
	const verifyingIndices = steps
		.map((t, i) => (t.status === "verifying" ? i : -1))
		.filter((i) => i >= 0);

	if (verifyingIndices.length > 0) {
		const allResolved = steps.every(
			(t) =>
				t.status === "done" ||
				t.status === "skipped" ||
				t.status === "failed" ||
				t.status === "verifying",
		);
		return {
			kind: "verifying",
			indices: verifyingIndices,
			allResolved,
			offerPrompt: hasUI && allResolved,
		};
	}

	const allDone = steps.every((t) => t.status === "done" || t.status === "skipped");
	const failedIndices = steps.map((t, i) => (t.status === "failed" ? i : -1)).filter((i) => i >= 0);

	if (allDone && failedIndices.length === 0) {
		return { kind: "complete" };
	}
	if (failedIndices.length > 0) {
		return {
			kind: "failed_steps",
			indices: failedIndices,
			offerPrompt: hasUI,
		};
	}
	return { kind: "blocked" };
}

function buildReady(
	quest: AutoPilotQuestSnapshot,
	index: number,
	step: AutoPilotStepSnapshot,
	sameStepCount: number,
	hasUI: boolean,
	maxBurst: number,
): ReadyDecision {
	const burstHit = quest.stepsSincePause >= maxBurst;
	return {
		index,
		content: step.content,
		agent: step.agent,
		sameStepCount,
		burst: burstHit
			? { hit: true, offerConfirm: hasUI, stepsSincePause: quest.stepsSincePause }
			: { hit: false },
		fire: quest.parallelEnabled ? "parallel_conflict" : "step",
		doneCount: quest.steps.filter((t) => t.status === "done").length,
		totalCount: quest.steps.length,
	};
}

/**
 * Sequential decision once a next pending step is known (stall → budget → burst → fire).
 */
export function decideForNextStep(
	quest: AutoPilotQuestSnapshot,
	nextIndex: number,
	nextStep: AutoPilotStepSnapshot,
	opts: {
		hasUI: boolean;
		ladderLength: number;
		policy: RetryPolicy;
	},
): SequentialDecision {
	const { hasUI, ladderLength, policy } = opts;
	const maxRetries = policy.maxRetries;
	const maxBurst = policy.maxBurst;

	// Stall detection
	let sameStepCount: number;
	if (nextIndex === quest.lastFiredStepIndex) {
		sameStepCount = quest.sameStepCount + 1;
		if (sameStepCount > 2) {
			return {
				kind: "stall",
				index: nextIndex,
				content: nextStep.content,
				sameStepCount,
				offerPrompt: hasUI,
			};
		}
	} else {
		sameStepCount = 1;
	}

	// Attempt budget
	if (nextStep.attempts > maxRetries) {
		const decision = decideVerifyFailAction({
			// Attempts already exhausted; only escalation-vs-fail (no same-rung retry).
			verifyRetries: policy.maxVerifyRetries,
			rung: nextStep.rung,
			escalations: nextStep.escalations ?? 0,
			ladderLength,
			policy,
		});

		if (decision.action === "escalate" && decision.nextRung !== undefined && ladderLength > 0) {
			// After escalate the original handler resets counters then falls through.
			const then = buildReady(
				{ ...quest, lastFiredStepIndex: -1, sameStepCount: 0 },
				nextIndex,
				// Escalated step is requeued with attempts cleared for the fire path.
				{ ...nextStep, attempts: 0 },
				0,
				hasUI,
				maxBurst,
			);
			return {
				kind: "escalate",
				index: nextIndex,
				nextRung: decision.nextRung,
				sameStepCount: 0,
				then,
			};
		}

		return { kind: "fail_budget", index: nextIndex };
	}

	return {
		kind: "ready",
		...buildReady(quest, nextIndex, nextStep, sameStepCount, hasUI, maxBurst),
	};
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Pure decision for one `agent_end` turn on an active quest.
 *
 * Preconditions (enforced by the adapter, not here):
 * - auto-pilot lock is free
 * - quest exists and `status === "active"`
 */
export function decideAfterAgentEnd(input: AutoPilotInput): AutoPilotDecision {
	const policy = input.policy ?? DEFAULT_RETRY_POLICY;
	const { quest, hasUI, wasAborted } = input;
	const now = input.now ?? Date.now();
	const timeoutMs = quest.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

	if (wasAborted) {
		return { kind: "abort_pause" };
	}

	// Wall-clock timeouts first; unresolved requeue skips indices already timed out.
	const timeouts = planTimeoutActions(quest.steps, policy.maxRetries, timeoutMs, now);
	const timedOut = new Set(timeouts.map((t) => t.index));
	const unresolved = planUnresolvedRequeues(quest.steps, policy.maxRetries).filter(
		(u) => !timedOut.has(u.index),
	);
	const simulated = simulateAfterTimeoutsAndUnresolved(quest.steps, timeouts, unresolved);
	const tryParallel = quest.parallelEnabled;

	const next = nextPendingFromSnapshot(simulated);
	if (!next) {
		return {
			kind: "proceed",
			timeouts,
			unresolved,
			tryParallel,
			sequential: decideWhenNoNext(simulated, hasUI),
		};
	}

	const ladderLength = next.step.rung !== undefined ? (input.nextStepLadderLength ?? 0) : 0;

	const sequential = decideForNextStep({ ...quest, steps: simulated }, next.index, next.step, {
		hasUI,
		ladderLength,
		policy,
	});

	return {
		kind: "proceed",
		timeouts,
		unresolved,
		tryParallel,
		sequential,
	};
}

/** Snapshot a live quest for {@link decideAfterAgentEnd}. */
export function snapshotQuestForAutoPilot(quest: {
	name: string;
	lastFiredStepIndex: number;
	sameStepCount: number;
	stepsSincePause: number;
	steps: readonly {
		content: string;
		status: StepStatus;
		phase?: StepPhase;
		agent: string;
		attempts: number;
		dependencies: number[];
		rung?: number;
		escalations?: number;
		result?: string | null;
		phaseChangedAt?: number;
		startedAt?: number | null;
	}[];
	parallel?: { enabled?: boolean; stepTimeoutMs?: number } | null;
}): AutoPilotQuestSnapshot {
	return {
		name: quest.name,
		lastFiredStepIndex: quest.lastFiredStepIndex,
		sameStepCount: quest.sameStepCount,
		stepsSincePause: quest.stepsSincePause,
		parallelEnabled: !!quest.parallel?.enabled,
		// Honor parallel.stepTimeoutMs when set; sequential path uses the same default.
		stepTimeoutMs: quest.parallel?.stepTimeoutMs,
		steps: quest.steps.map((s) => ({
			content: s.content,
			status: s.status,
			phase: s.phase,
			agent: s.agent,
			attempts: s.attempts,
			dependencies: s.dependencies,
			rung: s.rung,
			escalations: s.escalations,
			result: s.result,
			phaseChangedAt: s.phaseChangedAt,
			startedAt: s.startedAt,
		})),
	};
}
