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

export function resolvePhase(step: QuestStep): StepPhase {
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
	step: QuestStep,
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
