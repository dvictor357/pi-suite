/**
 * Pure model-ladder logic: verified escalation from cheap models to frontier
 * models.
 *
 * The ladder is an ordered list of model ids (rung 0 = cheapest) the user
 * approved once per project (`quest_assign_ladder` → ProjectMemory.modelLadder).
 * Ladder-eligible steps start on the cheapest rung whose history clears the
 * pass-rate floor, retry on the same rung with a distilled failure brief, and
 * escalate to the next rung only after verified failure exhausts the per-rung
 * retry budget. Read-only judge roles (verifier, reviewer, …) are never
 * laddered — the gate that decides escalation must not itself be downgraded.
 *
 * No SDK imports (mirrors delegate.ts) so every decision here is unit-testable.
 */
import {
	clampToBudget,
	statsFor,
	DEFAULT_RETRY_POLICY,
	type EvalStatsIndex,
	type ModelLadderConfig,
	type RetryPolicy,
} from "../../core";
import { asRecord, boolOr, numOr, optNum, optStr, strOr } from "../../core";

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Agent roles the ladder applies to by default: the roles that produce work
 * which the verification gate then judges. Judge/exploration roles keep their
 * explicit `agentModels` assignment untouched.
 */
export const DEFAULT_LADDER_ROLES = ["worker"];

/** Tunable ladder knobs; the shipped values live in constants.ts (`LADDER`). */
export interface LadderConfig {
	/** Default agent roles the ladder applies to (a ladder may override via its own `roles`). */
	roles: string[];
	/** Eval samples needed for a (role, rung) before adaptive start-rung skipping engages. */
	minSamples: number;
	/** Verified-pass rate below which a rung is skipped as a starting point. */
	passRateFloor: number;
	/** Character budget for the rendered failure-brief block. */
	briefBudget: number;
	/** How many of the newest failure briefs are rendered into prompts. */
	maxBriefs: number;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Whether the ladder governs this step's model. An explicit step model is the
 * most specific user intent and always bypasses the ladder.
 */
export function ladderApplies(
	ladder: ModelLadderConfig | null | undefined,
	agent: string,
	explicitStepModel: string | undefined,
	cfg: LadderConfig,
): boolean {
	if (!ladder || ladder.rungs.length === 0) return false;
	if (explicitStepModel?.trim()) return false;
	const roles = ladder.roles && ladder.roles.length > 0 ? ladder.roles : cfg.roles;
	const wanted = agent.trim().toLowerCase();
	return roles.some((r) => r.trim().toLowerCase() === wanted);
}

/** The model id for a rung, clamped so a stale persisted index can't overflow. */
export function rungModel(ladder: ModelLadderConfig, rung: number): string {
	return ladder.rungs[Math.max(0, Math.min(rung, ladder.rungs.length - 1))];
}

// ── Adaptive start rung ──────────────────────────────────────────────────────

/**
 * Pick the starting rung for a role from real project history: walk rungs from
 * cheapest, skipping any whose verified-pass rate for this role is proven (at
 * least `minSamples` outcomes) to sit below the floor. With no or thin history
 * this returns 0 — trust the cheap model until the ledger says otherwise. The
 * last rung is always an acceptable floor.
 */
export function pickStartRung(
	ladder: ModelLadderConfig,
	agent: string,
	stats: EvalStatsIndex,
	cfg: LadderConfig,
): number {
	for (let i = 0; i < ladder.rungs.length - 1; i++) {
		const history = statsFor(stats, agent, ladder.rungs[i]);
		const disqualified =
			history && history.samples >= cfg.minSamples && history.passRate < cfg.passRateFloor;
		if (!disqualified) return i;
	}
	return ladder.rungs.length - 1;
}

// ── Escalation decision ──────────────────────────────────────────────────────

export interface VerifyFailDecision {
	action: "retry" | "escalate" | "fail";
	/** Set when action is "escalate": the rung the step moves to. */
	nextRung?: number;
	/** Same-rung verification retries remaining (matches today's messaging). */
	retriesLeft: number;
}

/**
 * Decide what a verified failure does to a step. Retry budgets are per-rung:
 * with retries left the step retries on the same rung (brief-informed); once
 * exhausted, a laddered step with rungs remaining and escalations under the
 * policy cap escalates (which resets the per-rung budget); otherwise it fails.
 * Un-laddered steps (`rung === undefined`) and one-rung ladders degrade exactly
 * to today's retry/fail behaviour.
 */
export function decideVerifyFailAction(opts: {
	/** Verify retries consumed on the current rung, after incrementing for this failure. */
	verifyRetries: number;
	rung: number | undefined;
	escalations: number;
	/** Rung count of the applicable ladder; 0 when no ladder governs the step. */
	ladderLength: number;
	policy?: RetryPolicy;
}): VerifyFailDecision {
	const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
	const retriesLeft = Math.max(0, policy.maxVerifyRetries - opts.verifyRetries);
	if (retriesLeft > 0) return { action: "retry", retriesLeft };
	if (
		opts.rung !== undefined &&
		opts.rung + 1 < opts.ladderLength &&
		opts.escalations < policy.maxEscalations
	) {
		return { action: "escalate", nextRung: opts.rung + 1, retriesLeft: 0 };
	}
	return { action: "fail", retriesLeft: 0 };
}

// ── Failure briefs ───────────────────────────────────────────────────────────

/**
 * A distilled record of one verified failure, rendered into the retry (or
 * escalated) prompt so the next attempt starts from what went wrong instead of
 * re-running blind. Replaces the old unbounded evidence append onto
 * `step.context`.
 */
export interface FailureBrief {
	/** 1-based verified-failure number on this step, across rungs. */
	attempt: number;
	/** Model that produced the failing attempt, when known. */
	model?: string;
	/** Ladder rung at the time of failure, when laddered. */
	rung?: number;
	/** Verifier evidence (or the task failure reason). */
	evidence: string;
	/** What the worker reported it did (step.result snapshot). */
	attempted: string;
	/** True when the verdict was prose-inferred rather than explicitly flagged. */
	inferred: boolean;
	timestamp: number;
}

export function buildFailureBrief(opts: {
	attempt: number;
	model?: string;
	rung?: number;
	evidence: string;
	attempted: string | null;
	inferred: boolean;
}): FailureBrief {
	return {
		attempt: opts.attempt,
		model: opts.model,
		rung: opts.rung,
		evidence: opts.evidence.trim() || "no details recorded",
		attempted: (opts.attempted ?? "").trim(),
		inferred: opts.inferred,
		timestamp: Date.now(),
	};
}

/**
 * Render the newest failure briefs as a prompt block, newest first, clamped to
 * `budget` characters on line boundaries. Returns "" when there is nothing to
 * say, so callers can splice it in unconditionally.
 */
export function renderFailureBriefs(
	briefs: readonly FailureBrief[] | undefined,
	budget: number,
	maxBriefs: number,
): string {
	if (!briefs || briefs.length === 0) return "";
	const newest = briefs.slice(-maxBriefs).reverse();
	const lines: string[] = ["**Prior failed attempts — address these specifically:**"];
	for (const b of newest) {
		const origin = [
			b.model ? `model ${b.model}` : "",
			b.rung !== undefined ? `rung ${b.rung}` : "",
			b.inferred ? "verdict inferred from prose" : "",
		]
			.filter(Boolean)
			.join(", ");
		lines.push(`- Attempt ${b.attempt}${origin ? ` (${origin})` : ""}: ${b.evidence}`);
		if (b.attempted) lines.push(`  Attempted: ${b.attempted}`);
	}
	return clampToBudget(lines.join("\n"), budget);
}

/** Narrow one untrusted persisted brief, or null when it isn't usable. */
export function coerceFailureBrief(value: unknown): FailureBrief | null {
	const rec = asRecord(value);
	const evidence = strOr(rec.evidence, "");
	if (!evidence) return null;
	return {
		attempt: numOr(rec.attempt, 1),
		model: optStr(rec.model),
		rung: optNum(rec.rung),
		evidence,
		attempted: strOr(rec.attempted, ""),
		inferred: boolOr(rec.inferred, false),
		timestamp: numOr(rec.timestamp, 0),
	};
}
