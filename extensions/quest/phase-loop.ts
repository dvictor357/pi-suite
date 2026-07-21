import { randomUUID } from "node:crypto";
import type { QuestStep, StepPhase, StepStatus } from "./types";

export type { StepPhase } from "./types";

const TRANSITIONS: Readonly<Record<StepPhase, readonly StepPhase[]>> = {
	queued: ["dispatching", "retrying", "blocked", "failed", "skipped"],
	dispatching: ["running", "retrying", "blocked", "failed"],
	running: ["checking", "verifying", "done", "retrying", "failed", "skipped"],
	checking: ["verifying", "done", "retrying", "blocked", "failed", "skipped"],
	verifying: ["checking", "done", "retrying", "failed"],
	retrying: ["queued", "blocked", "failed"],
	blocked: ["queued", "retrying", "failed", "skipped"],
	done: [],
	failed: ["retrying", "skipped"],
	skipped: [],
};

export interface TransitionResult {
	ok: boolean;
	error?: string;
	from: StepPhase;
	to: StepPhase;
}

export function toCanonicalStatus(phase: StepPhase | "pending"): StepStatus {
	if (phase === "done" || phase === "failed" || phase === "skipped") return phase;
	if (phase === "running" || phase === "checking") return "running";
	if (phase === "verifying") return "verifying";
	return "pending";
}

export function resolvePhase(step: Pick<QuestStep, "status"> & { phase?: StepPhase }): StepPhase {
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

/** Validate and durably-project one lifecycle hop onto the step. */
export function validateTransition(
	step: QuestStep,
	toInput: StepPhase | "pending",
	now: number = Date.now(),
): TransitionResult {
	const from = resolvePhase(step);
	const to = toInput === "pending" ? "queued" : toInput;
	if (!TRANSITIONS[from].includes(to)) {
		return { ok: false, error: `Invalid transition: ${from} → ${to} is not allowed.`, from, to };
	}
	step.phase = to;
	step.status = toCanonicalStatus(to);
	step.phaseChangedAt = now;
	return { ok: true, from, to };
}

export interface StaleRecoveryResult {
	recovered: number[];
	skipped: number[];
}

/** Dead sessions cannot still own child processes; consume the attempt and queue a bounded retry. */
export function recoverStaleRuns(steps: QuestStep[], maxAttempts = 3): StaleRecoveryResult {
	const recovered: number[] = [];
	const skipped: number[] = [];
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const phase = resolvePhase(step);
		if (phase === "done" || phase === "failed" || phase === "skipped") {
			skipped.push(index);
			continue;
		}
		if (!["dispatching", "running", "checking", "verifying", "retrying"].includes(phase)) continue;
		step.phase = step.attempts >= maxAttempts ? "failed" : "queued";
		step.status = toCanonicalStatus(step.phase);
		step.phaseChangedAt = Date.now();
		step.startedAt = null;
		step.dispatchId = undefined;
		if (step.phase === "failed") {
			step.completedAt = Date.now();
			step.result =
				`${step.result ?? ""}\n[RECOVERY] Attempt budget exhausted after a stale run.`.trim();
		}
		recovered.push(index);
	}
	return { recovered, skipped };
}

export class DispatchGuard {
	private inFlight = new Map<string, Map<number, string>>();

	acquire(cwd: string, stepIndex: number, dispatchId = randomUUID()): boolean {
		let slots = this.inFlight.get(cwd);
		if (!slots) {
			slots = new Map();
			this.inFlight.set(cwd, slots);
		}
		if (slots.has(stepIndex)) return false;
		slots.set(stepIndex, dispatchId);
		return true;
	}

	dispatchId(cwd: string, stepIndex: number): string | undefined {
		return this.inFlight.get(cwd)?.get(stepIndex);
	}

	release(cwd: string, stepIndex: number): void {
		this.inFlight.get(cwd)?.delete(stepIndex);
	}

	isInFlight(cwd: string, stepIndex: number): boolean {
		return this.inFlight.get(cwd)?.has(stepIndex) ?? false;
	}

	inFlightCount(cwd: string): number {
		return this.inFlight.get(cwd)?.size ?? 0;
	}

	clear(cwd: string): void {
		this.inFlight.delete(cwd);
	}

	reset(): void {
		this.inFlight.clear();
	}
}

export const DEFAULT_STEP_TIMEOUT_MS = 600_000;

export function checkTimeout(
	step: Pick<QuestStep, "status"> & {
		phase?: StepPhase;
		phaseChangedAt?: number;
		startedAt?: number | null;
	},
	timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
	now: number = Date.now(),
): number {
	const phase = resolvePhase(step);
	if (!["dispatching", "running", "verifying"].includes(phase)) return 0;
	const since = step.phaseChangedAt ?? step.startedAt;
	if (!since) return 0;
	const elapsed = now - since;
	return elapsed > timeoutMs ? elapsed : 0;
}

// ── Blocked worktree recovery (R6) ───────────────────────────────────────────

/** Step stuck in `blocked` with a retained owned worktree path. */
export interface BlockedWorktreeInfo {
	index: number;
	content: string;
	worktreePath: string;
}

/** Minimal step fields for {@link listBlockedWithWorktree}. */
export interface BlockedWorktreeStepSnapshot {
	content: string;
	status: StepStatus;
	phase?: StepPhase;
	sandboxArtifacts?: { worktreePath?: string } | null;
}

/**
 * List steps in phase `blocked` that still record a worktree path.
 * Resume/auto-pilot only fire `queued` steps, so these are silent-stuck without
 * an explicit recover action.
 */
export function listBlockedWithWorktree(
	steps: readonly BlockedWorktreeStepSnapshot[],
): BlockedWorktreeInfo[] {
	const out: BlockedWorktreeInfo[] = [];
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		if (resolvePhase(step) !== "blocked") continue;
		const worktreePath = step.sandboxArtifacts?.worktreePath?.trim();
		if (!worktreePath) continue;
		out.push({ index, content: step.content, worktreePath });
	}
	return out;
}

export type RecoverBlockedMode = "safe" | "force";

/**
 * Pure decision for recovering a blocked step after optional worktree I/O.
 *
 * - `safe`: requeue only when there is no worktree path, or when a clean
 *   `removeStepWorktree` already succeeded (`removeSucceeded: true`). Dirty or
 *   unowned worktrees stay blocked as evidence.
 * - `force`: requeue and clear the worktree path without requiring removal
 *   (directory may remain on disk as evidence; the step detaches and re-runs).
 */
export function decideBlockedRecovery(input: {
	phase: StepPhase;
	hasWorktreePath: boolean;
	mode: RecoverBlockedMode;
	/** Outcome of safe remove when a path was present; ignored for force. */
	removeSucceeded?: boolean;
}):
	| { action: "requeue"; clearWorktreePath: boolean; reason: string }
	| { action: "stay_blocked"; reason: string }
	| { action: "reject"; reason: string } {
	if (input.phase !== "blocked") {
		return {
			action: "reject",
			reason: `Step is not blocked (phase=${input.phase}); nothing to recover.`,
		};
	}

	if (input.mode === "force") {
		return {
			action: "requeue",
			clearWorktreePath: input.hasWorktreePath,
			reason: "force requeue; worktree detached without removal",
		};
	}

	// safe
	if (!input.hasWorktreePath) {
		return {
			action: "requeue",
			clearWorktreePath: false,
			reason: "blocked without worktree path; requeue",
		};
	}
	if (input.removeSucceeded) {
		return {
			action: "requeue",
			clearWorktreePath: true,
			reason: "safe worktree remove succeeded; requeue",
		};
	}
	return {
		action: "stay_blocked",
		reason:
			"Safe recover refused: worktree is dirty, missing, or not removable. Use mode=force to detach and requeue, or clean the worktree first.",
	};
}
