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
	/**
	 * Base character budget for the full multi-block step context assembled by
	 * `buildStepContext` (task + briefs + deps + awareness + format). Larger than
	 * {@link awarenessBudget} so large models keep every section; scaled down for
	 * small/low-context models so the total cannot blow a tiny window.
	 */
	stepContextBudget: number;
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
	// Generous for multi-section assembly on large models; scaled like awarenessBudget.
	stepContextBudget: 6000,
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

/** Shared scale factor for model-aware budgets (low-context × small-model). */
function modelBudgetScale(model: BudgetModelInfo | undefined, cfg: ContextBudgetConfig): number {
	let scale = 1;
	if (
		typeof model?.contextWindow === "number" &&
		model.contextWindow > 0 &&
		model.contextWindow <= cfg.lowContextWindow
	) {
		scale *= cfg.lowContextScale;
	}
	if (isSmallModel(model, cfg)) scale *= cfg.smallModelScale;
	return scale;
}

/**
 * The character budget a context block should fit within for this model. Starts
 * from the base and applies (multiplicatively) a low-context-window discount and
 * a small-model discount, floored at `minBudget`. An unknown model → base.
 */
export function budgetForModel(model: BudgetModelInfo | undefined, cfg = CONTEXT_BUDGET): number {
	return Math.max(cfg.minBudget, Math.round(cfg.awarenessBudget * modelBudgetScale(model, cfg)));
}

/**
 * Character budget for the full multi-block step context (`buildStepContext`).
 * Same scale factors as {@link budgetForModel}, applied to {@link ContextBudgetConfig.stepContextBudget}.
 */
export function stepContextBudgetForModel(
	model: BudgetModelInfo | undefined,
	cfg = CONTEXT_BUDGET,
): number {
	return Math.max(cfg.minBudget, Math.round(cfg.stepContextBudget * modelBudgetScale(model, cfg)));
}

/**
 * One section of a multi-block prompt. Lower `priority` is kept longer when the
 * joined text exceeds the budget (0 = never drop until only priority-0 remains).
 */
export interface BudgetSection {
	/** Section body; empty/whitespace-only sections are ignored. */
	text: string;
	/**
	 * Keep-order rank. Drop highest numbers first (whole section). Convention for
	 * step context: task=0, failure briefs=1, dep handoffs=2, awareness=3, format=4.
	 */
	priority: number;
}

/**
 * Fit sections into a character budget by dropping whole low-priority sections
 * first, then line-safe {@link clampToBudget} if still over. Never mid-line cuts
 * except as clampToBudget's last resort on a single oversized line.
 *
 * Sections are joined with a blank line between non-empty survivors, preserving
 * the input order of whatever remains.
 */
export function fitSectionsToBudget(
	sections: ReadonlyArray<BudgetSection>,
	budget: number,
	marker = "\n…",
): string {
	const active = sections
		.map((s, index) => ({ text: s.text.trimEnd(), priority: s.priority, index }))
		.filter((s) => s.text.length > 0);

	const join = (list: typeof active): string =>
		list
			.slice()
			.sort((a, b) => a.index - b.index)
			.map((s) => s.text)
			.join("\n\n");

	const kept = [...active];
	while (kept.length > 0) {
		const joined = join(kept);
		if (joined.length <= budget) return joined;

		// Drop the lowest-priority (highest number) section; among ties, drop the
		// later insertion so earlier structural sections win.
		let dropAt = -1;
		let dropPriority = -Infinity;
		let dropIndex = -Infinity;
		for (let i = 0; i < kept.length; i++) {
			const s = kept[i];
			if (s.priority > dropPriority || (s.priority === dropPriority && s.index > dropIndex)) {
				dropPriority = s.priority;
				dropIndex = s.index;
				dropAt = i;
			}
		}
		// Only priority-0 (or a single section) left — stop dropping and clamp.
		if (dropAt < 0 || dropPriority <= 0 || kept.length === 1) {
			return clampToBudget(joined, budget, marker);
		}
		kept.splice(dropAt, 1);
	}
	return "";
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
