/**
 * core/context-budget.ts — model-aware, structure-safe prompt budgeting.
 *
 * Two extensions inject context blocks into agent prompts: pi-quest (the
 * steering/awareness block that leads a sub-agent turn) and pi-memory (the
 * profile block appended to the system prompt). On small models or low-context
 * runtimes an oversized block wastes budget, and a mid-line character cut (the
 * previous `slice(0, n)` behaviour) emits malformed markdown that confuses the
 * model exactly when it can least afford it.
 *
 * This module centralises the two decisions:
 *   1. How big a context block may be for a given model (`budgetForModel`),
 *      derived from the model's real `contextWindow` plus a small "small-model"
 *      marker list — not brittle name guessing. All thresholds live in
 *      `CONTEXT_BUDGET` and can be overridden per call.
 *   2. How to trim a block to that budget without cutting a line in half
 *      (`clampToBudget`).
 *
 * Pure Node: the model is passed structurally so `core/` keeps no pi-ai
 * dependency (a real `Model` is assignable to `BudgetModelInfo`).
 */

/** The subset of a model this module needs. A real pi `Model` satisfies it. */
export interface BudgetModelInfo {
	/** Model id, e.g. "claude-haiku-4-5". */
	id?: string;
	/** The model's context window in tokens, when known. */
	contextWindow?: number;
}

export interface ContextBudgetConfig {
	/** Base character budget for a context block on a large, ample-context model. */
	awarenessBudget: number;
	/** Never trim below this many characters. */
	minBudget: number;
	/** Context windows at or below this (tokens) are treated as low-context. */
	lowContextWindow: number;
	/** Budget multiplier applied for a low-context model. */
	lowContextScale: number;
	/** Lowercased id substrings that mark a "small" model (more easily distracted by bloat). */
	smallModelMarkers: string[];
	/** Budget multiplier applied for a small-marked model. */
	smallModelScale: number;
}

/**
 * Default budgeting configuration. Tunable knobs are surfaced here (not buried
 * as magic numbers) so budgeting behaviour is configured in one place. The base
 * 1200 preserves the historical awareness-block cap; scales only ever *reduce*
 * it for constrained models, so large models are never starved.
 */
export const CONTEXT_BUDGET: ContextBudgetConfig = {
	awarenessBudget: 1200,
	minBudget: 400,
	lowContextWindow: 32768,
	lowContextScale: 0.5,
	smallModelMarkers: ["haiku", "mini", "small", "nano", "tiny"],
	smallModelScale: 0.6,
};

/** Whether a model id matches a configured "small model" marker. */
export function isSmallModel(model: BudgetModelInfo | undefined, cfg = CONTEXT_BUDGET): boolean {
	const id = model?.id?.toLowerCase();
	return !!id && cfg.smallModelMarkers.some((m) => id.includes(m));
}

/** Whether a model is constrained (small OR low-context) and should get leaner prompts. */
export function isConstrainedModel(
	model: BudgetModelInfo | undefined,
	cfg = CONTEXT_BUDGET,
): boolean {
	if (isSmallModel(model, cfg)) return true;
	return (
		typeof model?.contextWindow === "number" &&
		model.contextWindow > 0 &&
		model.contextWindow <= cfg.lowContextWindow
	);
}

/** Prompt verbosity level. */
export type Verbosity = "full" | "compact";

/**
 * Which directive/verbosity a model should receive: constrained models (small
 * or low-context) get the `compact` variant so fixed boilerplate doesn't crowd
 * out the actual task, larger models get the `full` explanatory text.
 */
export function verbosityForModel(
	model: BudgetModelInfo | undefined,
	cfg = CONTEXT_BUDGET,
): Verbosity {
	return isConstrainedModel(model, cfg) ? "compact" : "full";
}

/**
 * The character budget a context block should fit within for this model. Starts
 * from the base and applies (multiplicatively) a low-context-window discount and
 * a small-model discount, floored at `minBudget`. An unknown model → base.
 */
export function budgetForModel(model: BudgetModelInfo | undefined, cfg = CONTEXT_BUDGET): number {
	let scale = 1;
	if (
		typeof model?.contextWindow === "number" &&
		model.contextWindow > 0 &&
		model.contextWindow <= cfg.lowContextWindow
	) {
		scale *= cfg.lowContextScale;
	}
	if (isSmallModel(model, cfg)) scale *= cfg.smallModelScale;
	return Math.max(cfg.minBudget, Math.round(cfg.awarenessBudget * scale));
}

/**
 * Trim `text` to at most `budget` characters WITHOUT cutting a line in half:
 * keep whole leading lines (the first line is usually a header) until the next
 * one wouldn't fit, then append `marker`. Only when a single line alone already
 * exceeds the budget does it fall back to a hard character cut. The returned
 * string is always ≤ `budget`.
 */
export function clampToBudget(text: string, budget: number, marker = "\n…"): string {
	if (text.length <= budget) return text;

	const lines = text.split("\n");
	const kept: string[] = [];
	let len = 0;
	for (const line of lines) {
		const add = (kept.length ? 1 : 0) + line.length; // +1 for the rejoining newline
		if (len + add + marker.length > budget) break;
		kept.push(line);
		len += add;
	}

	if (kept.length === 0) {
		// A single oversized line: hard cut, but keep it tidy.
		return text.slice(0, Math.max(0, budget - marker.length)).trimEnd() + marker;
	}
	return kept.join("\n") + marker;
}
