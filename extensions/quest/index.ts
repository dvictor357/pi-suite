/**
 * quest/index.ts — proactive AI project manager for pi
 *
 * Entry point for the quest extension. Builds the shared {@link QuestRuntime}
 * (which owns the quest cache, auto-pilot lock, and observability ledgers) and
 * hands it to each `register*` module. The tools, events, and command that used
 * to live in one ~2900-line closure now live beside their state in:
 *
 *   - register-create.ts    quest_create, quest_decide
 *   - register-planning.ts  quest_plan, quest_update, quest_approve
 *   - register-status.ts    quest_status, quest_commit, quest_git_summary,
 *                           quest_team, quest_history, quest_memory_save
 *   - register-delegate.ts  quest_assign_model, quest_delegate, quest_abort,
 *                           quest_task_detail
 *   - register-events.ts    agent_end auto-pilot, session_start, model_select
 *   - register-command.ts   the /quest command + kanban board
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuestRuntime } from "./runtime";
import { registerCreateTools } from "./register-create";
import { registerPlanningTools } from "./register-planning";
import { registerStatusTools } from "./register-status";
import { registerDelegateTools } from "./register-delegate";
import { registerEvents } from "./register-events";
import { registerQuestCommand } from "./register-command";

export default function (pi: ExtensionAPI) {
	const rt = createQuestRuntime(pi);
	registerCreateTools(pi, rt);
	registerPlanningTools(pi, rt);
	registerStatusTools(pi, rt);
	registerDelegateTools(pi, rt);
	registerEvents(pi, rt);
	registerQuestCommand(pi, rt);
}
