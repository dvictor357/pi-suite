/**
 * quest/routing.ts — per-step runtime decision (model + thinking effort).
 *
 * The model comes from the existing precedence (explicit step.model → approved
 * ladder rung → remembered role choice); this module adds a deterministic
 * thinking policy on top: a verified quality failure on the current rung buys
 * the retry more reasoning on the same model before the ladder pays for a
 * bigger one. Mechanical failures (typecheck/lint/format) stay put — the fix is
 * cheap and thinking won't help.
 *
 * Everything is derived from persisted step state (rung, failure briefs), so the
 * steering message, the `subagent` tool_call enforcement hook, and the legacy
 * `quest_delegate` path all compute the same answer without a new stored field.
 *
 * Pure — no pi imports, no I/O.
 */

import { THINKING_LEVELS, type FailureCode, type ModelLadderConfig } from "../../core";
import type { ThinkingLevel } from "../../core";
import { rungModel, type FailureBrief } from "./ladder";

/** Tunable knobs for {@link routeThinking}; defaults live in constants.ts `ROUTING`. */
export interface RoutingConfig {
	/** Roles whose thinking may be adjusted — execution roles, same set as the ladder. */
	roles: readonly string[];
	/** Starting level for a bump when the role has no approved thinking level. */
	defaultThinking: ThinkingLevel;
	/** Bumps never raise thinking above this (an approved baseline above it is kept). */
	maxThinking: ThinkingLevel;
	/** Failure codes that earn the next same-rung attempt one more thinking level. */
	bumpOn: readonly FailureCode[];
	/**
	 * Verdicts with no failure code (a plain verifier FAIL) count as quality
	 * failures. Deterministic check failures always carry a code.
	 */
	bumpOnUncoded: boolean;
	/**
	 * Lower thinking on a small step's first attempt on a rung. Off by default
	 * until eval telemetry shows small steps keep their pass rate at the lower
	 * level. Size is the step's own `content` + `context` chars.
	 */
	downshift: { enabled: boolean; maxStepChars: number; thinking: ThinkingLevel };
}

/** Step fields routing reads — all persisted, so every caller derives the same answer. */
export interface RoutableStep {
	agent: string;
	content: string;
	context?: string;
	model?: string;
	rung?: number;
	failureBriefs?: readonly FailureBrief[];
}

/** What the next sub-agent run of a step should use. */
export interface RuntimeDecision {
	/** Model id the step must run with; undefined = none assigned yet. */
	model?: string;
	/** Thinking level override; undefined = let pi-minions resolve its default. */
	thinking?: ThinkingLevel;
	/** Human-readable why, for steering/notify text. Empty when nothing was adjusted. */
	reasons: string[];
}

function levelIndex(level: ThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

/** Narrow an untrusted string (memory file, tool arg) to a thinking level. */
export function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

/** Verified failures on the step's current rung that should buy more thinking. */
export function qualityFailuresOnRung(
	step: { rung?: number; failureBriefs?: readonly FailureBrief[] },
	cfg: RoutingConfig,
): number {
	let n = 0;
	for (const b of step.failureBriefs ?? []) {
		if (b.rung !== step.rung) continue;
		if (b.failureCode ? cfg.bumpOn.includes(b.failureCode) : cfg.bumpOnUncoded) n++;
	}
	return n;
}

/**
 * Thinking level for the step's next run. Without same-rung quality failures
 * this is exactly the approved role baseline (possibly undefined), so a first
 * attempt behaves as before. Each quality failure raises it one level, capped
 * at `maxThinking`; an approved baseline is never lowered.
 */
export function routeThinking(
	step: RoutableStep,
	baseline: ThinkingLevel | undefined,
	cfg: RoutingConfig,
): { thinking?: ThinkingLevel; reason?: string } {
	if (!cfg.roles.includes(step.agent)) return { thinking: baseline };
	const failures = qualityFailuresOnRung(step, cfg);
	if (failures === 0) return downshift(step, baseline, cfg);
	const start = levelIndex(baseline ?? cfg.defaultThinking);
	const target = Math.min(start + failures, levelIndex(cfg.maxThinking));
	if (target <= start) return { thinking: baseline };
	const thinking = THINKING_LEVELS[target];
	return {
		thinking,
		reason: `thinking ${baseline ?? "default"} → ${thinking} after ${failures} quality failure${failures > 1 ? "s" : ""} on this rung`,
	};
}

/** First attempt on a rung (no quality failures yet): optional small-step downshift. */
function downshift(
	step: RoutableStep,
	baseline: ThinkingLevel | undefined,
	cfg: RoutingConfig,
): { thinking?: ThinkingLevel; reason?: string } {
	const { enabled, maxStepChars, thinking } = cfg.downshift;
	if (!enabled) return { thinking: baseline };
	const chars = step.content.length + (step.context?.length ?? 0);
	if (chars > maxStepChars) return { thinking: baseline };
	const from = baseline ?? cfg.defaultThinking;
	if (levelIndex(thinking) >= levelIndex(from)) return { thinking: baseline };
	return { thinking, reason: `thinking ${from} → ${thinking} for a small step (${chars} chars)` };
}

/**
 * The model a step is steered to: explicit override, else the current approved
 * ladder rung, else the remembered role choice. Mirrors steering's precedence.
 */
export function stepModel(
	step: { model?: string; rung?: number },
	ladder: ModelLadderConfig | null | undefined,
	rememberedModel: string | undefined,
): string | undefined {
	const explicit = step.model?.trim();
	if (explicit) return explicit;
	if (ladder && step.rung !== undefined) return rungModel(ladder, step.rung).trim() || undefined;
	return rememberedModel?.trim() || undefined;
}

/** Full runtime decision for a step's next sub-agent run. */
export function routeStep(
	step: RoutableStep,
	opts: {
		ladder: ModelLadderConfig | null | undefined;
		rememberedModel?: string;
		baselineThinking?: ThinkingLevel;
		cfg: RoutingConfig;
	},
): RuntimeDecision {
	const model = stepModel(step, opts.ladder, opts.rememberedModel);
	const { thinking, reason } = routeThinking(step, opts.baselineThinking, opts.cfg);
	return { model, thinking, reasons: reason ? [reason] : [] };
}

/** One rewrite applied to a `subagent` call by {@link enforceSubagentRuntime}. */
export interface RuntimeRewrite {
	stepIndex: number;
	field: "model" | "thinking";
	/** Value the orchestrator sent; undefined when it omitted the field. */
	from?: string;
	to: string;
}

/**
 * Make a `subagent` call run each targeted step with its routed runtime,
 * mutating `input` in place (pi's tool_call contract for argument rewrites).
 * `targets` is index-aligned with the call's task entries, as produced by
 * `resolveSubagentStepTargets`. Only fields with a decided value are written —
 * an undecided model/thinking leaves the orchestrator's choice alone.
 */
export function enforceSubagentRuntime(
	input: Record<string, unknown>,
	targets: readonly (number | null)[],
	decide: (stepIndex: number) => RuntimeDecision,
): RuntimeRewrite[] {
	const rewrites: RuntimeRewrite[] = [];
	const entries: Record<string, unknown>[] =
		Array.isArray(input.tasks) && input.tasks.length > 0
			? (input.tasks as unknown[]).map((t) =>
					t && typeof t === "object" ? (t as Record<string, unknown>) : {},
				)
			: [input];
	targets.forEach((stepIndex, i) => {
		if (stepIndex == null || !entries[i]) return;
		const entry = entries[i];
		const decision = decide(stepIndex);
		for (const field of ["model", "thinking"] as const) {
			const to = decision[field];
			if (!to) continue;
			const current = typeof entry[field] === "string" ? (entry[field] as string) : undefined;
			if (current?.trim() === to) continue;
			entry[field] = to;
			rewrites.push({ stepIndex, field, from: current, to });
		}
	});
	return rewrites;
}
