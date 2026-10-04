/**
 * quest/loadout.ts — declare quest-run tools only while a quest is live.
 *
 * Every declared tool's schema rides along on every model request. pi-suite
 * declares ~33 tools (~35k chars); bench runs showed loading the suite roughly
 * doubling tokens per task even when no quest tool was used. Most quest tools
 * only make sense once a quest exists, so they are registered inactive and
 * switched on/off with the quest's lifecycle. Entry points (quest_create,
 * quest_status) and cheap read-only reports stay declared at all times.
 */
import type { Quest } from "./types";

/** Tools only declared to the model while a quest is live. */
export const QUEST_RUN_TOOLS: readonly string[] = [
	"quest_enhance",
	"quest_decide",
	"quest_plan",
	"quest_update",
	"quest_approve",
	"quest_assign_model",
	"quest_assign_ladder",
	"quest_delegate",
	"quest_abort",
	"quest_task_detail",
	"quest_step_detail",
	"quest_commit",
	"quest_git_summary",
	"quest_team",
	"quest_memory_save",
	"quest_claims",
	"quest_recover_step",
];

const RUN_TOOL_SET = new Set(QUEST_RUN_TOOLS);

/** Whether a tool registration should start inactive. */
export function startsInactive(toolName: string): boolean {
	return RUN_TOOL_SET.has(toolName);
}

/** A quest that can still take tool calls (planning, running, or paused). */
export function questIsLive(quest: Pick<Quest, "status"> | null | undefined): boolean {
	return !!quest && quest.status !== "done" && quest.status !== "idle";
}

/**
 * The active tool list with quest-run tools switched `on`/off, preserving every
 * other tool and its order. Null when nothing changes, so callers can skip the
 * update (a tool-set change can invalidate the provider's prompt cache).
 */
export function nextActiveTools(current: readonly string[], on: boolean): string[] | null {
	const has = new Set(current);
	if (on) {
		const missing = QUEST_RUN_TOOLS.filter((t) => !has.has(t));
		return missing.length ? [...current, ...missing] : null;
	}
	const kept = current.filter((t) => !RUN_TOOL_SET.has(t));
	return kept.length === current.length ? null : kept;
}

/** The slice of pi's API the loadout needs; optional so older pi versions no-op. */
export interface ToolLoadoutApi {
	getActiveTools?: () => string[];
	setActiveTools?: (names: string[]) => void;
}

/** Apply the loadout for `quest`. Best-effort: never throws. */
export function syncQuestLoadout(pi: ToolLoadoutApi, quest: Pick<Quest, "status"> | null): void {
	if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
	try {
		const next = nextActiveTools(pi.getActiveTools(), questIsLive(quest));
		if (next) pi.setActiveTools(next);
	} catch {
		/* a loadout hiccup must never break quest state handling */
	}
}
