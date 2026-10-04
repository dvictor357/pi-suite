/**
 * quest/tiering.ts — size the quest pipeline to the task.
 *
 * Every quest used to pay the same ceremony: enhance → scout → planner → web
 * research → plan → delegated worker → LLM verifier. On a one-file fix that is
 * ~6 extra model calls before any work starts, and bench runs showed the quest
 * arm costing ~9–12× a plain agent for the same pass. Tiers keep the full
 * pipeline for complex work and strip it down for small work:
 *
 * - simple:  no research sub-agents; one step the orchestrator implements
 *            itself (inline); deterministic checks verify it.
 * - medium:  no scout/planner sub-agents or web research; a few steps the
 *            orchestrator implements in order (inline unless parallel or
 *            sandboxed); small, test-covered diffs skip the LLM verifier.
 * - complex: today's full pipeline, LLM verifier always.
 *
 * The orchestrator declares a tier at quest_create; the plan can only move it
 * UP (a plan that outgrows its tier is upgraded, never silently squeezed).
 * Pure: no I/O. Knobs live in constants.ts `TIERING`.
 */
import type { CheckResult } from "./checks";
import { TIERING, type TierConfig } from "./constants";
import type { StepEvidence } from "./evidence";

export const QUEST_TIERS = ["simple", "medium", "complex"] as const;
export type QuestTier = (typeof QUEST_TIERS)[number];

const RANK: Record<QuestTier, number> = { simple: 0, medium: 1, complex: 2 };

export function isQuestTier(value: unknown): value is QuestTier {
	return typeof value === "string" && (QUEST_TIERS as readonly string[]).includes(value);
}

/** The tier a quest runs at: its recorded tier, else the configured default. */
export function tierOf(quest: { tier?: QuestTier }): QuestTier {
	return quest.tier ?? TIERING.defaultTier;
}

/** Steps as quest_plan receives them — only the fields tiering reads. */
export interface TierPlanStep {
	agent: string;
	writeClaim?: string[];
}

/**
 * The lowest tier at or above `declared` whose limits the plan fits, with the
 * reason when it had to move up. Unbounded limits (undefined) always fit.
 */
export function resolvePlanTier(
	declared: QuestTier,
	steps: readonly TierPlanStep[],
	cfg: Record<QuestTier, TierConfig> = TIERING.tiers,
): { tier: QuestTier; reason?: string } {
	const writeFiles = new Set(steps.flatMap((s) => s.writeClaim ?? [])).size;
	for (const tier of QUEST_TIERS) {
		if (RANK[tier] < RANK[declared]) continue;
		const limits = cfg[tier];
		const tooManySteps = limits.maxSteps !== undefined && steps.length > limits.maxSteps;
		const tooManyFiles = limits.maxWriteFiles !== undefined && writeFiles > limits.maxWriteFiles;
		if (tooManySteps || tooManyFiles) continue;
		if (tier === declared) return { tier };
		const was = cfg[declared];
		const why =
			was.maxSteps !== undefined && steps.length > was.maxSteps
				? `${steps.length} steps > ${was.maxSteps}`
				: `${writeFiles} write-claimed files > ${was.maxWriteFiles}`;
		return { tier, reason: `plan outgrew "${declared}" (${why})` };
	}
	return { tier: "complex", reason: `plan outgrew "${declared}"` };
}

/**
 * Light tiers don't require acceptance, but a goal that names tests or a
 * checkable behaviour should still get harness-run proof (see acceptance.ts).
 */
const ACCEPTANCE_NUDGE = `If the goal names tests or a checkable behaviour, also pass **acceptanceCommands** to quest_plan — targeted commands (no pipes/&&) that pass only when the goal is met, e.g. \`npm test -- path/to/file.test.ts\`. Not the whole suite, typecheck or lint: quest already runs those after every step.`;

/** Lines quest_create shows the orchestrator for how to plan at this tier. */
export function planningGuidance(tier: QuestTier): string[] {
	const max = TIERING.tiers[tier];
	switch (tier) {
		case "simple":
			return [
				`**Tier: simple** — keep this light. Skip quest_enhance, scout/planner sub-agents and web research.`,
				`Read only the files you need, then call **quest_plan** with exactly ${max.maxSteps ?? 1} step`,
				`(agent "worker", writeClaim = the file(s) you will change) and autoStart: true.`,
				`You will implement that step yourself — no sub-agent — and the project's checks verify it.`,
				ACCEPTANCE_NUDGE,
			];
		case "medium":
			return [
				`**Tier: medium** — skip scout/planner sub-agents and web research.`,
				`Explore directly (codebase query or a few reads), then call **quest_plan** with at most`,
				`${max.maxSteps ?? "a few"} focused steps, each with a writeClaim, and autoStart: true.`,
				`You will implement the steps yourself in order${max.inline ? "" : " via sub-agents"}; checks verify each one.`,
				ACCEPTANCE_NUDGE,
			];
		case "complex":
			return [
				`**Tier: complex** — call **quest_enhance** first to enrich the goal with`,
				`project context (memory, conventions, prior research, past quests, git state),`,
				`then use subagent(agent="scout") to explore the codebase,`,
				`then subagent(agent="planner") to create a step breakdown. Save the plan`,
				`with **quest_plan** — pass the steps array and set autoStart: true.`,
				``,
				`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
			];
	}
}

/** True when this quest's steps run inline in the orchestrator, not via a sub-agent. */
export function runsInline(
	quest: { tier?: QuestTier; parallel?: { enabled: boolean } },
	sandboxActive: boolean,
): boolean {
	// Sandboxed steps keep the guarded quest_delegate path (inline work would
	// bypass the per-step sandbox policy); parallel quests need workers to run
	// steps concurrently.
	if (sandboxActive || quest.parallel?.enabled) return false;
	return TIERING.tiers[tierOf(quest)].inline;
}

/** Total changed lines (insertions + deletions) from a `git diff --stat` summary. */
export function diffLines(diffStat: string): number | null {
	const ins = diffStat.match(/(\d+) insertions?\(\+\)/);
	const del = diffStat.match(/(\d+) deletions?\(-\)/);
	if (!ins && !del) return null;
	return Number(ins?.[1] ?? 0) + Number(del?.[1] ?? 0);
}

/**
 * Whether a step at this tier can be verified by its deterministic evidence
 * alone, skipping the LLM verifier. Requires: the tier allows it, at least one
 * check the step didn't inherit passed (a test, when the tier says so), and a
 * diff within the tier's size cap. Pre-existing failures don't block — the
 * gate already established the step didn't cause them.
 */
export function autoPassDecision(
	tier: QuestTier,
	evidence: Pick<StepEvidence, "checks" | "diffStat" | "changedFiles">,
): { pass: boolean; reason: string } {
	const cfg = TIERING.tiers[tier];
	if (cfg.autoPassMaxDiffLines <= 0)
		return { pass: false, reason: `tier ${tier} always uses the verifier` };
	const passed = (kind?: CheckResult["kind"]) =>
		evidence.checks.some(
			(c) => c.status === "pass" && !c.preexisting && (!kind || c.kind === kind),
		);
	if (!passed()) return { pass: false, reason: "no deterministic check passed" };
	if (cfg.autoPassRequiresTest && !passed("test")) {
		return { pass: false, reason: "no test check passed" };
	}
	if (evidence.changedFiles.length === 0) return { pass: false, reason: "no files changed" };
	const lines = diffLines(evidence.diffStat);
	if (lines === null) return { pass: false, reason: "diff size unknown" };
	if (lines > cfg.autoPassMaxDiffLines) {
		return { pass: false, reason: `diff ${lines} lines > ${cfg.autoPassMaxDiffLines}` };
	}
	const checks = evidence.checks
		.filter((c) => c.status !== "skipped")
		.map((c) => `${c.kind}:${c.preexisting ? "preexisting" : c.status}`)
		.join(" ");
	return {
		pass: true,
		reason: `auto-verified (tier ${tier}): checks ${checks}; diff ${lines} lines ≤ ${cfg.autoPassMaxDiffLines}`,
	};
}
