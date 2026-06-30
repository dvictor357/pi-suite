import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_BURST, MAX_RETRIES } from "./constants";
import { archiveQuest, loadQuest, saveQuest, syncConventionsToMemory } from "./storage";
import { nextPendingStep, formatQuestStatus, wasTurnAborted } from "./steering";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { syncQuestToTodo } from "./todo-sync";
import { resolveSandboxProfile } from "./sandbox";
import { evaluateToolCall } from "./sandbox-guard";
import type { QuestRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist } = rt;

	pi.on("agent_end", async (event, ctx) => {
		if (rt.isAutoPilotLocked()) return;
		try {
			const quest = getQuest(ctx.cwd);
			if (!quest || quest.status !== "active") return;

			// User interrupt (Esc). `agent_end` fires for an aborted turn just like a
			// completed one, so without this guard the handler would steer in the
			// *next* step on every abort — forcing repeated Escapes to stop the quest,
			// and orphaning each fired step in `running` (nextPendingStep skips those).
			// Treat one interrupt as "halt the auto-pilot": roll the in-flight step(s)
			// back to pending and pause so a single Esc stops, and /quest resume picks
			// up cleanly where it left off.
			if (wasTurnAborted(event.messages)) {
				for (const t of quest.steps) {
					if (t.status === "running") {
						t.status = "pending";
						t.startedAt = null;
						if (t.attempts > 0) t.attempts--; // the aborted attempt didn't run
					}
				}
				quest.status = "paused";
				quest.pauseReason = "Interrupted (Esc). /quest resume to continue.";
				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				persist(ctx, quest);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Quest "${quest.name}" paused — interrupted. /quest resume to continue.`,
						"warning",
					);
				}
				return;
			}

			const next = nextPendingStep(quest);
			if (!next) {
				const verifyingTasks = quest.steps.filter((t) => t.status === "verifying");
				if (verifyingTasks.length > 0) {
					const allResolved = quest.steps.every(
						(t) =>
							t.status === "done" ||
							t.status === "skipped" ||
							t.status === "failed" ||
							t.status === "verifying",
					);
					const vfyList = verifyingTasks
						.map((t) => {
							const idx = quest.steps.indexOf(t);
							return `- #${idx + 1} **${t.content}**`;
						})
						.join("\n");
					if (allResolved) {
						if (ctx.hasUI) {
							const action = await ctx.ui.select(
								`${verifyingTasks.length} step(s) need verification. What now?`,
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
											`${verifyingTasks.length} step(s) awaiting verification:`,
											verifyingTasks
												.map((t) => {
													const idx = quest.steps.indexOf(t);
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
									`${verifyingTasks.length} step(s) verified (skipped). Continuing...`,
									"info",
								);
								return;
							}
						}

						quest.status = "paused";
						quest.pauseReason = `Waiting for verification on ${verifyingTasks.length} step(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Resolve with quest_update(verifyOutcome=...).`;
						quest.lastFiredStepIndex = -1;
						quest.sameStepCount = 0;
						persist(ctx, quest);

						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} step(s) need verification.\n${vfyList}`,
								"warning",
							);
						} else {
							rt.setAutoPilotLocked(true);
							try {
								pi.sendUserMessage(
									[
										`## Verification Pending ⏳`,
										``,
										`${verifyingTasks.length} step(s) awaiting verification:`,
										verifyingTasks
											.map((t) => {
												const idx = quest.steps.indexOf(t);
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
						// allResolved is false — some steps pending because deps are verifying
						quest.status = "paused";
						quest.pauseReason = `Verification pending on ${verifyingTasks.length} step(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Complete verification to unblock dependent steps.`;
						quest.lastFiredStepIndex = -1;
						quest.sameStepCount = 0;
						persist(ctx, quest);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} step(s) need verification before dependents can proceed.\n${vfyList}`,
								"warning",
							);
						}
						return;
					}
				}

				const allDone = quest.steps.every((t) => t.status === "done" || t.status === "skipped");
				const anyFailed = quest.steps.some((t) => t.status === "failed");

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
								`${quest.steps.filter((t) => t.status === "done").length}/${quest.steps.length} steps done.`,
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
					const failedTasks = quest.steps.filter((t) => t.status === "failed");
					const failedList = failedTasks
						.map((t) => {
							const i = quest.steps.indexOf(t);
							return `  #${i + 1}: ${t.content} — ${t.result || "no details"}`;
						})
						.join("\n");

					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`${failedTasks.length} step(s) failed. What would you like to do?`,
							["Retry failed steps", "Skip all failed", "Pause and review"],
						);

						if (action === "Retry failed steps") {
							for (const t of failedTasks) {
								t.status = "pending";
								t.attempts = 0;
								t.startedAt = null;
								t.completedAt = null;
								t.result = null;
							}
							quest.status = "active";
							quest.stepsSincePause = 0;
							quest.lastFiredStepIndex = -1;
							quest.sameStepCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(
								`${failedTasks.length} step(s) reset for retry. Auto-pilot resuming.`,
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
							quest.stepsSincePause = 0;
							quest.lastFiredStepIndex = -1;
							quest.sameStepCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(`${failedTasks.length} step(s) skipped. Auto-pilot resuming.`, "info");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = "Some steps failed. Review and decide: retry, skip, or redefine.";
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(
							`Quest paused: ${failedTasks.length} step(s) failed.\nFailed:\n${failedList}`,
							"warning",
						);
					} else {
						rt.setAutoPilotLocked(true);
						try {
							pi.sendUserMessage(
								[
									`## Quest Paused: ${quest.name} ⚠`,
									``,
									`Some steps failed. Review the status with quest_status and decide next steps:`,
									`- Fix the issue and call quest_update to retry`,
									`- Skip failed steps with quest_update(status="skipped")`,
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
					quest.pauseReason = "All remaining steps are blocked by unfinished dependencies.";
					persist(ctx, quest);
				}
				return;
			}

			// Stall detection
			if (next.index === quest.lastFiredStepIndex) {
				quest.sameStepCount++;
				if (quest.sameStepCount > 2) {
					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`Step "${next.task.content}" stalled after ${quest.sameStepCount} attempts. What now?`,
							["Skip this step", "Mark as failed", "Pause quest"],
						);

						if (action === "Skip this step") {
							next.task.status = "skipped";
							next.task.result = `Skipped by user after stalling (${quest.sameStepCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredStepIndex = -1;
							quest.sameStepCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Step #${next.index + 1} skipped.`, "info");
							return;
						}

						if (action === "Mark as failed") {
							next.task.status = "failed";
							next.task.result = `Failed by user after stalling (${quest.sameStepCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredStepIndex = -1;
							quest.sameStepCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Step #${next.index + 1} marked failed.`, "warning");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = `Step #${next.index + 1} stalled (${quest.sameStepCount} attempts without progress).`;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(`Quest paused: stalled step. /quest resume to continue.`, "warning");
					} else {
						rt.setAutoPilotLocked(true);
						try {
							pi.sendUserMessage(
								`## Quest Paused: Stalled ⚠\n\nStep #${next.index + 1} "${next.task.content}" has been attempted ${quest.sameStepCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
								{ deliverAs: "steer" },
							);
						} finally {
							rt.setAutoPilotLocked(false);
						}
					}
					return;
				}
			} else {
				quest.sameStepCount = 1;
			}

			if (next.task.attempts > MAX_RETRIES) {
				next.task.status = "failed";
				next.task.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				persist(ctx, quest);
				return;
			}

			if (quest.stepsSincePause >= MAX_BURST) {
				const done = quest.steps.filter((t) => t.status === "done").length;
				const total = quest.steps.length;

				if (ctx.hasUI) {
					const cont = await ctx.ui.confirm(
						"Quest Checkpoint",
						[
							`**${quest.stepsSincePause} steps** completed in this burst.`,
							``,
							`Progress: **${done}/${total}** done`,
							`Next: **${next.task.content}** [${next.task.agent}]`,
							``,
							`Continue to next step?`,
						].join("\n"),
					);

					if (cont) {
						quest.stepsSincePause = 0;
						quest.lastFiredStepIndex = -1;
						quest.sameStepCount = 0;
						persist(ctx, quest);
					} else {
						quest.status = "paused";
						quest.pauseReason = `User paused at checkpoint after ${quest.stepsSincePause} steps. /quest resume to continue.`;
						quest.lastFiredStepIndex = -1;
						quest.sameStepCount = 0;
						persist(ctx, quest);
						ctx.ui.notify(`Quest paused. /quest resume to continue.`, "info");
						return;
					}
				} else {
					quest.status = "paused";
					quest.pauseReason = `Auto-paused after ${MAX_BURST} steps. /quest resume to continue.`;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);

					rt.setAutoPilotLocked(true);
					try {
						pi.sendUserMessage(
							`## Quest Paused: Checkpoint ⏸\n\n${quest.stepsSincePause}/${MAX_BURST} steps completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
							{ deliverAs: "steer" },
						);
					} finally {
						rt.setAutoPilotLocked(false);
					}
					return;
				}
			}

			// Fire the next step
			rt.fireStep(ctx, quest, next.task, next.index);
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
				`Quest active: ${quest.name} (${quest.steps.filter((t) => t.status === "done").length}/${quest.steps.length} done)`,
				"info",
			);
		} else if (quest?.status === "paused") {
			ctx.ui.notify(
				`Quest paused: ${quest.name} — ${quest.pauseReason ?? "/quest resume to continue"}`,
				"warning",
			);
		} else if (quest?.planningMode === "approve" && !quest.planApproved && quest.steps.length > 0) {
			ctx.ui.notify(
				`Quest awaiting approval: ${quest.name} — ${quest.steps.length} steps planned. /quest approve to start.`,
				"warning",
			);
		} else if (quest?.status === "planning") {
			ctx.ui.notify(
				`Quest planning: ${quest.name} — ${quest.steps.length} steps. /quest start or quest_plan to continue.`,
				"info",
			);
		} else if (quest?.status === "done") {
			const done = quest.steps.filter((t) => t.status === "done").length;
			ctx.ui.notify(
				`Quest completed: ${quest.name} — ${done}/${quest.steps.length} steps done.`,
				"info",
			);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx, rt.getQuest());
		writeQuestSessionMeta(ctx.cwd, rt.getQuest());
	});

	// ── Sandbox enforcement ───────────────────────────────────────────────────
	// Block tool calls that violate an active quest's sandbox policy. This is the
	// real-enforcement counterpart to the prompt-injected guidance and the
	// verifier's after-the-fact checks: a denied path / command / network call is
	// stopped here, at pi's tool-call chokepoint, before it runs. Sub-agent tool
	// calls don't reach this hook (their isolated session loads no extensions);
	// they are guarded by guardTools() at spawn time instead.
	pi.on("tool_call", (event, ctx) => {
		const quest = getQuest(ctx.cwd);
		if (!quest || quest.status !== "active" || !quest.sandbox) return;
		const profile = resolveSandboxProfile(quest.sandbox);
		const decision = evaluateToolCall(
			profile,
			event.toolName,
			event.input as unknown as Record<string, unknown>,
		);
		if (decision.block) {
			ctx.ui.notify?.(decision.reason ?? "Sandbox: tool call blocked.", "warning");
			return { block: true, reason: decision.reason };
		}
	});
}
