/**
 * quest/usage.ts — per-step sub-agent token/cost telemetry.
 *
 * Sub-agents run outside the parent session (pi-minions child processes, or the
 * legacy `quest_delegate` in-process session), so quest never sees their token
 * spend unless it reads it back from the tool result. This module is the pure
 * half: coerce untrusted usage blobs, accumulate them onto a step across
 * attempts, and attribute a `subagent` tool result to the quest steps it ran.
 *
 * The accumulated {@link StepUsage} is consumed once by `makeEval`, so the eval
 * ledger can answer "what did a verified success cost", not just "how often".
 *
 * Pure — no pi imports, no I/O.
 */

import { asRecord, optStr } from "../../core";

/** Token/cost totals for all sub-agent runs attributed to one step. */
export interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Provider-reported cost in USD. */
	cost: number;
	/** Peak context size (tokens) seen in any single run — max, not sum. */
	contextTokens: number;
	/** Assistant turns across all runs. */
	turns: number;
	/** Sub-agent runs merged into this total. */
	runs: number;
}

/** Non-negative finite number, else 0 — usage blobs are untrusted. */
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Coerce a persisted {@link StepUsage} (quest file) or a pi-minions
 * `SingleResult.usage` blob. Returns undefined when nothing was spent, so an
 * absent or all-zero blob never materializes as a fake measurement.
 */
export function coerceStepUsage(value: unknown): StepUsage | undefined {
	const rec = asRecord(value);
	const usage: StepUsage = {
		input: count(rec.input),
		output: count(rec.output),
		cacheRead: count(rec.cacheRead),
		cacheWrite: count(rec.cacheWrite),
		cost: count(rec.cost),
		contextTokens: count(rec.contextTokens),
		turns: count(rec.turns),
		runs: Math.max(1, count(rec.runs)),
	};
	const spent = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.cost;
	return spent > 0 || usage.turns > 0 ? usage : undefined;
}

/** Merge a run's usage into a step total. */
export function addUsage(total: StepUsage | undefined, run: StepUsage): StepUsage {
	if (!total) return { ...run };
	return {
		input: total.input + run.input,
		output: total.output + run.output,
		cacheRead: total.cacheRead + run.cacheRead,
		cacheWrite: total.cacheWrite + run.cacheWrite,
		cost: total.cost + run.cost,
		contextTokens: Math.max(total.contextTokens, run.contextTokens),
		turns: total.turns + run.turns,
		runs: total.runs + run.runs,
	};
}

/** Usage plus the thinking level one attributed run actually used. */
export interface AttributedUsage {
	usage: StepUsage;
	thinking?: string;
}

/**
 * Attribute a pi-minions `subagent` tool result to quest steps.
 *
 * `targets` is aligned with the call's task entries (see
 * `resolveSubagentStepTargets`): `targets[i]` is the step `tasks[i]` ran, or
 * null when it matched no step. Parallel results are index-aligned with
 * `tasks[]`, so each result goes to its own step. Single/chain/pipeline calls
 * produce results that don't map one-to-one onto entries; those are summed onto
 * the call's step only when exactly one step was targeted — anything ambiguous
 * is dropped rather than guessed.
 */
export function attributeSubagentUsage(
	targets: readonly (number | null)[],
	details: unknown,
): Map<number, AttributedUsage> {
	const out = new Map<number, AttributedUsage>();
	const rec = asRecord(details);
	const results = Array.isArray(rec.results) ? rec.results : [];
	if (results.length === 0) return out;

	const credit = (stepIndex: number, result: unknown) => {
		const r = asRecord(result);
		const usage = coerceStepUsage(r.usage);
		if (!usage) return;
		const prev = out.get(stepIndex);
		out.set(stepIndex, {
			usage: addUsage(prev?.usage, usage),
			thinking: optStr(r.thinking) ?? prev?.thinking,
		});
	};

	if (rec.mode === "parallel") {
		results.forEach((result, i) => {
			const stepIndex = targets[i];
			if (stepIndex != null) credit(stepIndex, result);
		});
		return out;
	}

	const steps = new Set(targets.filter((t): t is number => t != null));
	if (steps.size !== 1) return out;
	const [stepIndex] = steps;
	for (const result of results) credit(stepIndex, result);
	return out;
}

/** Minimal shape of pi's `AgentSession.getSessionStats()` used by the legacy path. */
export interface SessionStatsLike {
	assistantMessages?: number;
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	contextUsage?: { tokens?: number | null };
}

/** Convert legacy `quest_delegate` session stats into a {@link StepUsage}. */
export function usageFromSessionStats(stats: SessionStatsLike | undefined): StepUsage | undefined {
	if (!stats) return undefined;
	return coerceStepUsage({
		input: stats.tokens?.input,
		output: stats.tokens?.output,
		cacheRead: stats.tokens?.cacheRead,
		cacheWrite: stats.tokens?.cacheWrite,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens ?? undefined,
		turns: stats.assistantMessages,
	});
}

/**
 * Credit attributed usage onto quest steps. Returns whether any step changed so
 * the caller can skip a redundant persist. Out-of-range indices are ignored —
 * the quest may have been replanned while the sub-agent ran.
 */
export function applyAttributedUsage(
	steps: { usage?: StepUsage; lastThinking?: string }[],
	attributed: ReadonlyMap<number, AttributedUsage>,
): boolean {
	let changed = false;
	for (const [stepIndex, { usage, thinking }] of attributed) {
		const step = steps[stepIndex];
		if (!step) continue;
		step.usage = addUsage(step.usage, usage);
		if (thinking) step.lastThinking = thinking;
		changed = true;
	}
	return changed;
}
