import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { TEAMS_DIR } from "./constants";
import { archiveQuest, clearActiveQuest, emptyQuest, listArchives, loadQuest } from "./storage";
import { clearQuestFromTodo, compactAwarenessBlock } from "./todo-sync";
import { ensureBuiltInTeams, loadTeams, teamInstallFromGit } from "./teams";
import { formatQuestStatus, nextPendingStep } from "./steering";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { listBlockedWithWorktree } from "./phase-loop";
import type { QuestRuntime } from "./runtime";

export function registerQuestCommand(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, launchKanban, claims: claimReg } = rt;

	pi.registerCommand("quest", {
		description:
			"Quest: proactive AI project manager. /quest create|start|pause|resume|approve|cancel|kanban|status|history|git|team [list|create]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			switch (sub) {
				case "": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest. Use /quest create <name>: <goal> to start.", "info");
						return;
					}
					if (ctx.hasUI) {
						await launchKanban(ctx, quest);
					} else {
						ctx.ui.notify(formatQuestStatus(quest), "info");
					}
					return;
				}
				case "create": {
					const colonIdx = rest.indexOf(":");
					const name = colonIdx === -1 ? rest : rest.slice(0, colonIdx).trim();
					const goal = colonIdx === -1 ? "" : rest.slice(colonIdx + 1).trim();

					if (!name) {
						ctx.ui.notify("Usage: /quest create <name>: <goal description>", "error");
						return;
					}

					if (getQuest(ctx.cwd)?.status === "active") {
						ctx.ui.notify("A quest is already active. /quest pause first.", "error");
						return;
					}

					const quest = emptyQuest(name, goal || name);
					persist(ctx, quest);

					ctx.ui.notify(
						`Quest created: "${name}"\n\nPlan it with quest_plan or let the agent explore and plan.\n/quest start when ready.`,
						"info",
					);

					rt.setAutoPilotLocked(true);
					try {
						pi.sendUserMessage(
							[
								`## New Quest: ${name}`,
								goal ? `**Goal:** ${goal}` : "",
								compactAwarenessBlock(ctx.cwd, ctx.model),
								``,
								`Plan this quest. Use subagent(agent="scout") to explore the codebase,`,
								`then subagent(agent="planner") to create a step breakdown.`,
								`Save the plan with **quest_plan(steps=[...], autoStart=true)**.`,
								``,
								`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
							]
								.filter(Boolean)
								.join("\n"),
							{ deliverAs: "steer" },
						);
					} finally {
						rt.setAutoPilotLocked(false);
					}
					return;
				}
				case "team": {
					const args = rest.split(/\s+/).filter(Boolean);
					const subCmd = args[0] || "list";
					const subRest = args.slice(1).join(" ");

					if (subCmd === "list" || !rest) {
						ensureBuiltInTeams();
						const teams = loadTeams();
						const names = Object.keys(teams);
						if (names.length === 0) {
							ctx.ui.notify("No teams found. Built-in teams will be created on next load.", "info");
							return;
						}
						const lines = names.map((n) => {
							const t = teams[n]!;
							const members = t.members.map((m) => `${m.role}:${m.agent}`).join(", ");
							const agentInfo = t.agents?.length
								? `\n  Custom agents: ${t.agents.map((a) => a.name).join(", ")}`
								: "";
							return `**${t.name}** — ${t.description}\n  Lead: ${t.lead} · Default: ${t.defaultAgent} · Verify: ${t.verification}\n  Members: ${members}${agentInfo}`;
						});
						ctx.ui.notify(`Teams:\n\n${lines.join("\n\n")}`, "info");
						return;
					}

					if (subCmd === "install") {
						const gitUrl = subRest;
						if (!gitUrl || !gitUrl.startsWith("http")) {
							ctx.ui.notify(
								"Usage: /quest team install <git-url>\n\nExample: /quest team install https://github.com/user/quest-team-content",
								"error",
							);
							return;
						}
						ctx.ui.notify(`Installing team from ${gitUrl}...`, "info");

						const result = teamInstallFromGit(gitUrl);
						if (result.success) {
							const t = result.team!;
							const members = t.members.map((m) => `${m.role}:${m.agent}`).join(", ");
							ctx.ui.notify(
								`✅ Team installed: **${t.name}**\n\n${t.description}\nLead: ${t.lead} · Default: ${t.defaultAgent}\nMembers: ${members}`,
								"info",
							);
						} else {
							ctx.ui.notify(`❌ Install failed: ${result.error}`, "error");
						}
						return;
					}

					if (subCmd === "create") {
						ctx.ui.notify(
							[
								`## Create a Team Template`,
								``,
								`To create a custom team, create a JSON file in:`,
								`\`${TEAMS_DIR}/your-team-name.json\``,
								``,
								`**Required fields:**`,
								`\`\`\`json`,
								JSON.stringify(
									{
										name: "my-team",
										description: "My custom team description",
										lead: "worker",
										members: [
											{ role: "developer", agent: "worker" },
											{ role: "reviewer", agent: "reviewer" },
										],
										defaultAgent: "worker",
										verification: true,
									},
									null,
									2,
								),
								`\`\`\``,
								``,
								`**Optional: custom agents** — add agent markdown files to:`,
								`\`${join(homedir(), ".pi", "agent", "agents")}/<agent-name>.md\``,
								``,
								`Then reference them in \`members\`. To share, push your team JSON +`,
								`agent markdown files to a GitHub repo and others can install with:`,
								`\`/quest team install <git-url>\``,
							].join("\n"),
							"info",
						);
						return;
					}

					ctx.ui.notify("Usage: /quest team [list|install <git-url>|create]", "error");
					return;
				}
				case "start": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.status === "active") {
						ctx.ui.notify("Quest is already active.", "info");
						return;
					}
					if (quest.steps.length === 0) {
						ctx.ui.notify("No steps planned. Use quest_plan to add steps first.", "error");
						return;
					}
					if (quest.planningMode === "approve" && !quest.planApproved) {
						ctx.ui.notify(
							"This quest requires plan approval before starting.\n\nUse /quest approve to review and approve the plan.",
							"warning",
						);
						return;
					}
					quest.status = "active";
					quest.stepsSincePause = 0;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					ctx.ui.notify(
						`Quest "${quest.name}" started — ${quest.steps.length} steps. Auto-pilot engaged.`,
						"info",
					);
					rt.fireNextTask(ctx);
					return;
				}
				case "pause": {
					const quest = getQuest(ctx.cwd);
					if (!quest || quest.status !== "active") {
						ctx.ui.notify("No active quest to pause.", "info");
						return;
					}
					quest.status = "paused";
					quest.pauseReason = "Paused by user.";
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					rt.cancelActiveSteps(ctx, quest, "paused by user");
					persist(ctx, quest);
					ctx.ui.notify(`Quest "${quest.name}" paused. /quest resume to continue.`, "info");
					return;
				}
				case "resume": {
					const quest = getQuest(ctx.cwd);
					if (!quest || quest.status !== "paused") {
						ctx.ui.notify("No paused quest to resume.", "info");
						return;
					}
					quest.status = "active";
					quest.stepsSincePause = 0;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					const done = quest.steps.filter((t) => t.status === "done").length;
					const next = nextPendingStep(quest);
					// Blocked steps are not pending — surface them so resume is not silent.
					const blockedWt = listBlockedWithWorktree(quest.steps);
					const blockedNote =
						blockedWt.length > 0
							? ` ${blockedWt.length} blocked with worktree (quest_recover_step to requeue).`
							: "";
					ctx.ui.notify(
						`Quest "${quest.name}" resumed. ${done}/${quest.steps.length} done.${next ? ` Next: ${next.task.content}` : ""}${blockedNote}`,
						blockedWt.length && !next ? "warning" : "info",
					);
					rt.fireNextTask(ctx);
					return;
				}
				case "approve": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.planApproved) {
						ctx.ui.notify("Plan already approved. Quest is in progress.", "info");
						return;
					}
					if (quest.steps.length === 0) {
						ctx.ui.notify("No steps to approve. Use quest_plan to create a plan first.", "error");
						return;
					}

					const planSummary = quest.steps
						.slice(0, 8)
						.map((t, i) => `${i + 1}. ${t.content} [${t.agent}]`)
						.join("\n");
					const moreTasks =
						quest.steps.length > 8 ? `\n  … and ${quest.steps.length - 8} more` : "";

					quest.planApproved = true;
					quest.status = "active";
					quest.stepsSincePause = 0;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					const next = nextPendingStep(quest);
					ctx.ui.notify(
						`✅ Plan approved: "${quest.name}" — ${quest.steps.length} steps. Auto-pilot engaged.${next ? ` First: ${next.task.content}` : ""}\n\n${planSummary}${moreTasks}`,
						"info",
					);
					// Kick off the first step now. A slash command produces no `agent_end`,
					// so without this the auto-pilot would sit idle until the next prompt.
					rt.fireNextTask(ctx);
					return;
				}
				case "kanban": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					if (ctx.hasUI) {
						await launchKanban(ctx, quest);
					} else {
						ctx.ui.notify(formatQuestStatus(quest), "info");
					}
					return;
				}
				case "status": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					ctx.ui.notify(formatQuestStatus(quest), "info");
					return;
				}
				case "git": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					const git = quest.gitIntegration;
					if (!git) {
						ctx.ui.notify("Git integration not configured for this quest.", "info");
						return;
					}
					const config = [
						`## Git Integration: ${quest.name}`,
						``,
						`- Auto-commit: ${git.autoCommit ? "✅ on" : "❌ off"}`,
						`- Auto-branch: ${git.autoBranch ? "✅ on" : "❌ off"}${git.autoBranch ? ` (prefix: \`${git.branchPrefix}\`)` : ""}`,
						`- Auto-PR: ${git.autoPR ? "✅ on" : "❌ off"}`,
						``,
						`Commits recorded: ${quest.commits.length}`,
					].join("\n");

					let commitList = "";
					if (quest.commits.length > 0) {
						commitList =
							"\n\n" +
							quest.commits
								.map((c) => {
									return `- \`${c.hash.slice(0, 8)}\` #${c.stepIndex + 1}: ${c.message}`;
								})
								.join("\n");
					}
					ctx.ui.notify(config + commitList, "info");
					return;
				}
				case "history": {
					const limit = parseInt(rest, 10) || 10;
					const archives = listArchives(limit, ctx.cwd);
					if (archives.length === 0) {
						ctx.ui.notify("No completed quests yet.", "info");
						return;
					}
					const lines = archives.map((a, idx) => {
						const date = a.completedAt
							? new Date(a.completedAt).toLocaleDateString("en-US", {
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})
							: "?";
						return `${idx + 1}. **${a.name}** — ${a.done}/${a.steps} done — ${date}\n   ${a.goal}`;
					});
					ctx.ui.notify(`Completed quests:\n\n${lines.join("\n\n")}`, "info");
					return;
				}
				case "cancel": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest to cancel.", "info");
						return;
					}
					if (quest.status === "active") {
						ctx.ui.notify("Cannot cancel an active quest. /quest pause first.", "error");
						return;
					}
					const name = quest.name;
					const done = quest.steps.filter((t) => t.status === "done").length;
					if (quest.status !== "done") {
						quest.status = "done";
						quest.completedAt = Date.now();
					}
					if (archiveQuest(quest, ctx.cwd)) clearActiveQuest(ctx.cwd);
					rt.setQuest(null);
					claimReg.clear(ctx.cwd);
					renderStatus(ctx, null);
					writeQuestSessionMeta(ctx.cwd, null);
					clearQuestFromTodo(ctx.cwd); // flush quest items, not re-sync them as completed
					ctx.ui.notify(
						`Quest "${name}" cancelled and archived (${done}/${quest.steps.length} steps done).`,
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /quest [create <name>: <goal>|start|pause|resume|approve|cancel|kanban|status|history|git|team [list|install <url>|create]]",
						"error",
					);
			}
		},
	});
}
