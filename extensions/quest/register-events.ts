import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_BURST, MAX_RETRIES } from "./constants";
import { archiveQuest, loadQuest, saveQuest, syncConventionsToMemory } from "./storage";
import { buildSteeringMessage, nextPendingTask, formatQuestStatus } from "./steering";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { syncQuestToTodo } from "./todo-sync";
import type { QuestRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist } = rt;

	pi.on("agent_end", async (_event, ctx) => {
		if (rt.isAutoPilotLocked()) return;
		try {
			const quest = getQuest(ctx.cwd);
			if (!quest || quest.status !== "active") return;

			const next = nextPendingTask(quest);
			if (!next) {
				const verifyingTasks = quest.tasks.filter((t) => t.status === "verifying");
				if (verifyingTasks.length > 0) {
					const allResolved = quest.tasks.every(
						(t) =>
							t.status === "done" ||
							t.status === "skipped" ||
							t.status === "failed" ||
							t.status === "verifying",
					);
					const vfyList = verifyingTasks
						.map((t) => {
							const idx = quest.tasks.indexOf(t);
							return `- #${idx + 1} **${t.content}**`;
						})
						.join("\n");
					if (allResolved) {
						if (ctx.hasUI) {
							const action = await ctx.ui.select(
								`${verifyingTasks.length} task(s) need verification. What now?`,
								[
									"Verify them now (agent will handle it)",
									"Skip verification for all",
									"Pause quest",
								],
							);

							if (action === "Verify them now (agent will handle it)") {
								rt.setAutoPilotLocked(true);
								try {
									pi.sendUserMessage(
										[
											`## Verification Pending ⏳`,
											``,
											`${verifyingTasks.length} task(s) awaiting verification:`,
											verifyingTasks
												.map((t) => {
													const idx = quest.tasks.indexOf(t);
													return `- #${idx + 1} **${t.content}** — Use subagent(agent="verifier") then call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
												})
												.join("\n"),
											``,
											`After resolving verification, /quest resume.`,
										].join("\n"),
										{ deliverAs: "steer" },
									);
								} finally {
									rt.setAutoPilotLocked(false);
								}
								return;
							}

							if (action === "Skip verification for all") {
								for (const t of verifyingTasks) {
									t.status = "done";
									t.verified = true;
									t.verifyResult = "[SKIP] Verification skipped by user.";
									t.completedAt = Date.now();
								}
								persist(ctx, quest);
								ctx.ui.notify(
									`${verifyingTasks.length} task(s) verified (skipped). Continuing...`,
									"info",
								);
								return;
							}
						}

						quest.status = "paused";
						quest.pauseReason = `Waiting for verification on ${verifyingTasks.length} task(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Resolve with quest_update(verifyOutcome=...).`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);

						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} task(s) need verification.\n${vfyList}`,
								"warning",
							);
						} else {
							rt.setAutoPilotLocked(true);
							try {
								pi.sendUserMessage(
									[
										`## Verification Pending ⏳`,
										``,
										`${verifyingTasks.length} task(s) awaiting verification:`,
										verifyingTasks
											.map((t) => {
												const idx = quest.tasks.indexOf(t);
												return `- #${idx + 1} **${t.content}** — call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
											})
											.join("\n"),
										``,
										`/quest resume after resolving verification.`,
									].join("\n"),
									{ deliverAs: "steer" },
								);
							} finally {
								rt.setAutoPilotLocked(false);
							}
						}
						return;
					} else {
						// allResolved is false — some tasks pending because deps are verifying
						quest.status = "paused";
						quest.pauseReason = `Verification pending on ${verifyingTasks.length} task(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Complete verification to unblock dependent tasks.`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} task(s) need verification before dependents can proceed.\n${vfyList}`,
								"warning",
							);
						}
						return;
					}
				}

				const allDone = quest.tasks.every((t) => t.status === "done" || t.status === "skipped");
				const anyFailed = quest.tasks.some((t) => t.status === "failed");

				if (allDone && !anyFailed) {
					quest.status = "done";
					quest.completedAt = Date.now();
					syncConventionsToMemory(quest, ctx.cwd);
					archiveQuest(quest, ctx.cwd);
					persist(ctx, quest);

					const git = quest.gitIntegration;
					const gitSection =
						quest.commits.length > 0
							? [
									``,
									`## Git Summary`,
									``,
									`**${quest.commits.length} commit(s)** recorded.`,
									quest.commits
										.slice(0, 5)
										.map((c) => `- \`${c.hash.slice(0, 8)}\` ${c.message}`)
										.join("\n"),
									quest.commits.length > 5 ? `- ... and ${quest.commits.length - 5} more` : "",
									git?.autoPR
										? [``, `**🔀 Auto-PR enabled.** Generate a PR with quest_git_summary().`].join(
												"\n",
											)
										: "",
								]
									.filter(Boolean)
									.join("\n")
							: git?.autoCommit
								? `\n\n⚠ No commits were recorded for this quest. Use quest_commit to track deliverables.`
								: "";

					rt.setAutoPilotLocked(true);
					try {
						pi.sendUserMessage(
							[
								`## Quest Complete: ${quest.name} 🎉`,
								``,
								`${quest.tasks.filter((t) => t.status === "done").length}/${quest.tasks.length} tasks done.`,
								gitSection,
								``,
								quest.conventions.length
									? `Saved ${quest.conventions.length} convention(s) to project memory.`
									: `No quest conventions to save to project memory.`,
								``,
								`Start a new quest with /quest create, or review with quest_history.`,
							]
								.filter(Boolean)
								.join("\n"),
							{ deliverAs: "steer" },
						);
					} finally {
						rt.setAutoPilotLocked(false);
					}
				} else if (anyFailed) {
					const failedTasks = quest.tasks.filter((t) => t.status === "failed");
					const failedList = failedTasks
						.map((t) => {
							const i = quest.tasks.indexOf(t);
							return `  #${i + 1}: ${t.content} — ${t.result || "no details"}`;
						})
						.join("\n");

					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`${failedTasks.length} task(s) failed. What would you like to do?`,
							["Retry failed tasks", "Skip all failed", "Pause and review"],
						);

						if (action === "Retry failed tasks") {
							for (const t of failedTasks) {
								t.status = "pending";
								t.attempts = 0;
								t.startedAt = null;
								t.completedAt = null;
								t.result = null;
							}
							quest.status = "active";
							quest.tasksSincePause = 0;
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(
								`${failedTasks.length} task(s) reset for retry. Auto-pilot resuming.`,
								"info",
							);
							return;
						}

						if (action === "Skip all failed") {
							for (const t of failedTasks) {
								t.status = "skipped";
								t.result = `Skipped by user.`;
								t.completedAt = Date.now();
							}
							quest.status = "active";
							quest.tasksSincePause = 0;
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(`${failedTasks.length} task(s) skipped. Auto-pilot resuming.`, "info");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = "Some tasks failed. Review and decide: retry, skip, or redefine.";
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(
							`Quest paused: ${failedTasks.length} task(s) failed.\nFailed:\n${failedList}`,
							"warning",
						);
					} else {
						rt.setAutoPilotLocked(true);
						try {
							pi.sendUserMessage(
								[
									`## Quest Paused: ${quest.name} ⚠`,
									``,
									`Some tasks failed. Review the status with quest_status and decide next steps:`,
									`- Fix the issue and call quest_update to retry`,
									`- Skip failed tasks with quest_update(status="skipped")`,
									`- /quest resume to continue`,
								].join("\n"),
								{ deliverAs: "steer" },
							);
						} finally {
							rt.setAutoPilotLocked(false);
						}
					}
				} else {
					quest.status = "paused";
					quest.pauseReason = "All remaining tasks are blocked by unfinished dependencies.";
					persist(ctx, quest);
				}
				return;
			}

			// Stall detection
			if (next.index === quest.lastFiredTaskIndex) {
				quest.sameTaskCount++;
				if (quest.sameTaskCount > 2) {
					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`Task "${next.task.content}" stalled after ${quest.sameTaskCount} attempts. What now?`,
							["Skip this task", "Mark as failed", "Pause quest"],
						);

						if (action === "Skip this task") {
							next.task.status = "skipped";
							next.task.result = `Skipped by user after stalling (${quest.sameTaskCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Task #${next.index + 1} skipped.`, "info");
							return;
						}

						if (action === "Mark as failed") {
							next.task.status = "failed";
							next.task.result = `Failed by user after stalling (${quest.sameTaskCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Task #${next.index + 1} marked failed.`, "warning");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = `Task #${next.index + 1} stalled (${quest.sameTaskCount} attempts without progress).`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(`Quest paused: stalled task. /quest resume to continue.`, "warning");
					} else {
						rt.setAutoPilotLocked(true);
						try {
							pi.sendUserMessage(
								`## Quest Paused: Stalled ⚠\n\nTask #${next.index + 1} "${next.task.content}" has been attempted ${quest.sameTaskCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
								{ deliverAs: "steer" },
							);
						} finally {
							rt.setAutoPilotLocked(false);
						}
					}
					return;
				}
			} else {
				quest.sameTaskCount = 1;
			}

			if (next.task.attempts > MAX_RETRIES) {
				next.task.status = "failed";
				next.task.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				persist(ctx, quest);
				return;
			}

			if (quest.tasksSincePause >= MAX_BURST) {
				const done = quest.tasks.filter((t) => t.status === "done").length;
				const total = quest.tasks.length;

				if (ctx.hasUI) {
					const cont = await ctx.ui.confirm(
						"Quest Checkpoint",
						[
							`**${quest.tasksSincePause} tasks** completed in this burst.`,
							``,
							`Progress: **${done}/${total}** done`,
							`Next: **${next.task.content}** [${next.task.agent}]`,
							``,
							`Continue to next task?`,
						].join("\n"),
					);

					if (cont) {
						quest.tasksSincePause = 0;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
					} else {
						quest.status = "paused";
						quest.pauseReason = `User paused at checkpoint after ${quest.tasksSincePause} tasks. /quest resume to continue.`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
						ctx.ui.notify(`Quest paused. /quest resume to continue.`, "info");
						return;
					}
				} else {
					quest.status = "paused";
					quest.pauseReason = `Auto-paused after ${MAX_BURST} tasks. /quest resume to continue.`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					rt.setAutoPilotLocked(true);
					try {
						pi.sendUserMessage(
							`## Quest Paused: Checkpoint ⏸\n\n${quest.tasksSincePause}/${MAX_BURST} tasks completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
							{ deliverAs: "steer" },
						);
					} finally {
						rt.setAutoPilotLocked(false);
					}
					return;
				}
			}

			// Fire the next task
			next.task.status = "running";
			next.task.attempts++;
			if (!next.task.startedAt) next.task.startedAt = Date.now();
			quest.lastFiredTaskIndex = next.index;
			quest.tasksSincePause++;
			persist(ctx, quest);

			rt.setAutoPilotLocked(true);
			try {
				pi.sendUserMessage(buildSteeringMessage(quest, next.task, next.index, ctx.cwd), {
					deliverAs: "steer",
				});
			} finally {
				rt.setAutoPilotLocked(false);
			}
		} catch (e) {
			console.error("[pi-quest] agent_end handler crashed:", e);
			const quest = getQuest(ctx.cwd);
			if (quest) {
				quest.status = "paused";
				quest.pauseReason = `Auto-pilot error: ${(e as Error)?.message || String(e)}`;
				saveQuest(quest, ctx.cwd);
				rt.setQuest(quest);
			}
			renderStatus(ctx, quest);
			writeQuestSessionMeta(ctx.cwd, quest);
			if (quest) syncQuestToTodo(quest, ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Quest auto-pilot error: ${(e as Error)?.message || String(e)}. Quest paused.`,
					"error",
				);
			}
		}
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const quest = loadQuest(ctx.cwd);
		rt.setQuest(quest);
		renderStatus(ctx, quest);
		writeQuestSessionMeta(ctx.cwd, quest);
		if (quest?.status === "active") syncQuestToTodo(quest, ctx.cwd);

		if (quest?.status === "active") {
			ctx.ui.notify(
				`Quest active: ${quest.name} (${quest.tasks.filter((t) => t.status === "done").length}/${quest.tasks.length} done)`,
				"info",
			);
		} else if (quest?.status === "paused") {
			ctx.ui.notify(
				`Quest paused: ${quest.name} — ${quest.pauseReason ?? "/quest resume to continue"}`,
				"warning",
			);
		} else if (quest?.planningMode === "approve" && !quest.planApproved && quest.tasks.length > 0) {
			ctx.ui.notify(
				`Quest awaiting approval: ${quest.name} — ${quest.tasks.length} tasks planned. /quest approve to start.`,
				"warning",
			);
		} else if (quest?.status === "planning") {
			ctx.ui.notify(
				`Quest planning: ${quest.name} — ${quest.tasks.length} tasks. /quest start or quest_plan to continue.`,
				"info",
			);
		} else if (quest?.status === "done") {
			const done = quest.tasks.filter((t) => t.status === "done").length;
			ctx.ui.notify(
				`Quest completed: ${quest.name} — ${done}/${quest.tasks.length} tasks done.`,
				"info",
			);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx, rt.getQuest());
		writeQuestSessionMeta(ctx.cwd, rt.getQuest());
	});

	// ── Commands ──────────────────────────────────────────────────────────────
}
