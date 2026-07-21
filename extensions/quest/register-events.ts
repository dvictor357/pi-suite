import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { DEFAULT_RETRY_POLICY } from "../../core";
import { MAX_BURST, MAX_RETRIES } from "./constants";
import {
	archiveQuest,
	clearActiveQuest,
	loadModelLadder,
	loadQuest,
	saveQuest,
	syncConventionsToMemory,
} from "./storage";
import { buildFailureBrief, decideVerifyFailAction, rungModel } from "./ladder";
import { nextPendingStep, formatQuestStatus, wasTurnAborted } from "./steering";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { clearQuestFromTodo, syncQuestToTodo } from "./todo-sync";
import { isSandboxActive } from "./sandbox";
import { evaluateToolCall } from "./sandbox-guard";
import { effectiveSandboxProfile, resolveSubagentClaimTargets } from "./tool-call-guard";
import { normalizeClaims, validateClaims } from "./write-claim";
import { buildQuestRecap } from "./recap";
import {
	buildActivityWidgetFn,
	buildActivityFooter,
	buildActivityWorkingIndicator,
} from "./activity-panel";
import { recoverStaleRuns, resolvePhase } from "./phase-loop";
import { cleanStaleWorktrees } from "./parallel";
import type { QuestRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, claims: claimReg, dispatchGuard } = rt;

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
				rt.cancelActiveSteps(ctx, quest, "agent turn aborted");
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

			// A completed orchestration turn cannot still own a live tool call. Any
			// unresolved dispatch consumed its attempt; requeue it within the shared
			// budget instead of leaving the quest permanently stuck in running.
			for (let index = 0; index < quest.steps.length; index++) {
				const step = quest.steps[index];
				if (!["dispatching", "running"].includes(resolvePhase(step))) continue;
				if (step.attempts > MAX_RETRIES) {
					rt.transitionStep(ctx, quest, index, "failed", "dispatch turn ended unresolved");
					step.completedAt = Date.now();
					continue;
				}
				if (!rt.beginStepRetry(ctx, quest, index, "dispatch turn ended unresolved")) continue;
				rt.transitionStep(ctx, quest, index, "queued", "bounded unresolved retry");
			}

			// ── Parallel dispatch (opt-in) ────────────────────────────────────
			// When parallel is enabled, use batch dispatch instead of the sequential
			// auto-pilot. fireParallelBatch handles recovery, integration, batch
			// selection, and dispatch. When it returns false, no dispatchable steps
			// remain — fall through to the shared completion logic.
			const parallelEnabled = quest.parallel?.enabled;
			if (parallelEnabled) {
				const dispatched = rt.fireParallelBatch(ctx, quest);
				if (dispatched) return;
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
									rt.transitionStep(
										ctx,
										quest,
										quest.steps.indexOf(t),
										"done",
										"verification skipped by user",
									);
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
					if (archiveQuest(quest, ctx.cwd)) {
						clearActiveQuest(ctx.cwd);
						rt.setQuest(null);
						renderStatus(ctx, null);
						writeQuestSessionMeta(ctx.cwd, null);
						clearQuestFromTodo(ctx.cwd);
					} else {
						persist(ctx, quest);
					}

					rt.setAutoPilotLocked(true);
					try {
						pi.sendUserMessage(buildQuestRecap(quest), { deliverAs: "steer" });
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
								const index = quest.steps.indexOf(t);
								if (!rt.beginStepRetry(ctx, quest, index, "user retry")) continue;
								t.attempts = 0;
								t.startedAt = null;
								t.completedAt = null;
								t.result = null;
								rt.transitionStep(ctx, quest, index, "queued", "user retry queued");
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
								rt.transitionStep(ctx, quest, quest.steps.indexOf(t), "skipped", "user skipped");
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
							rt.transitionStep(ctx, quest, next.index, "skipped", "stalled step skipped");
							next.task.result = `Skipped by user after stalling (${quest.sameStepCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredStepIndex = -1;
							quest.sameStepCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Step #${next.index + 1} skipped.`, "info");
							return;
						}

						if (action === "Mark as failed") {
							rt.transitionStep(ctx, quest, next.index, "failed", "stalled step failed");
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
				const ladder = next.task.rung !== undefined ? loadModelLadder(ctx.cwd) : null;
				const decision = decideVerifyFailAction({
					// Attempts are already exhausted here; use the shared decision tree
					// only for escalation-vs-fail, not another same-rung retry.
					verifyRetries: DEFAULT_RETRY_POLICY.maxVerifyRetries,
					rung: next.task.rung,
					escalations: next.task.escalations ?? 0,
					ladderLength: ladder?.rungs.length ?? 0,
				});

				if (decision.action === "escalate" && decision.nextRung !== undefined && ladder) {
					if (!rt.beginStepRetry(ctx, quest, next.index, "attempt budget escalation")) {
						quest.status = "paused";
						quest.pauseReason = `Step #${next.index + 1} retry is blocked by retained worktree evidence.`;
						persist(ctx, quest);
						return;
					}
					const fromRung = next.task.rung;
					const fromModel =
						next.task.lastModel ??
						next.task.model ??
						(fromRung !== undefined ? rungModel(ladder, fromRung) : undefined);
					const toModel = rungModel(ladder, decision.nextRung);
					const evidence = `Task attempt budget exhausted after ${MAX_RETRIES + 1} attempts.`;

					next.task.failureBriefs = [
						...(next.task.failureBriefs ?? []),
						buildFailureBrief({
							attempt: (next.task.failureBriefs?.length ?? 0) + 1,
							model: fromModel,
							rung: fromRung,
							evidence,
							attempted: next.task.result,
							inferred: false,
						}),
					];
					next.task.attempts = 0;
					next.task.verifyRetries = 0;
					next.task.rung = decision.nextRung;
					next.task.escalations = (next.task.escalations ?? 0) + 1;
					next.task.startedAt = null;
					next.task.completedAt = null;
					next.task.result = `${evidence} Escalating from ${fromModel ?? "previous model"} to rung ${decision.nextRung} (${toModel}).`;
					rt.transitionStep(ctx, quest, next.index, "queued", "escalated retry queued");
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);
					rt.recordRun(ctx.cwd, {
						kind: "escalate",
						taskIndex: next.index,
						taskContent: next.task.content,
						agent: next.task.agent,
						model: fromModel,
						fromModel,
						toModel,
						rung: decision.nextRung,
						timestamp: Date.now(),
						evidence,
					});
				} else {
					rt.transitionStep(ctx, quest, next.index, "failed", "attempt budget exhausted");
					next.task.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);
					return;
				}
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

			// Fire the next step (sequential path only — parallel dispatch was handled above).
			if (parallelEnabled) {
				// In parallel mode, a step that nextPendingStep found but selectDispatchBatch
				// skipped means there's a write-claim conflict or guard slot contention.
				// Don't fire it sequentially — pause so the user can investigate.
				quest.status = "paused";
				quest.pauseReason = `Step #${next.index + 1} ("${next.task.content}") is ready but was not dispatched by the parallel selector. Possible write-claim conflict. Check quest_claims() or /quest resume.`;
				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				persist(ctx, quest);
				if (ctx.hasUI) {
					ctx.ui.notify?.(
						`Quest paused: parallel dispatch could not fire step #${next.index + 1}. Check claim conflicts.`,
						"warning",
					);
				}
			} else {
				rt.fireStep(ctx, quest, next.task, next.index);
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
		rt.activity.reset(); // fresh tracker per session
		rt.claims.reset(); // fresh claim registry per session
		dispatchGuard.reset(); // fresh dispatch guard per session

		// ── Stale-run recovery ───────────────────────────────────────────
		if (quest) {
			const cleanedWorktrees = cleanStaleWorktrees(ctx.cwd, quest.name);
			if (cleanedWorktrees > 0) {
				ctx.ui.notify?.(
					`Cleaned ${cleanedWorktrees} already-integrated Quest worktree(s).`,
					"info",
				);
			}
			const stalePhases = quest.steps.map((step) => step.phase ?? step.status);
			const { recovered } = recoverStaleRuns(quest.steps, MAX_RETRIES + 1);
			if (recovered.length > 0) {
				for (const index of recovered) {
					const step = quest.steps[index];
					rt.recordRun(ctx.cwd, {
						kind: "phase_transition",
						taskIndex: index,
						taskContent: step.content,
						agent: step.agent,
						timestamp: step.phaseChangedAt ?? Date.now(),
						fromPhase: stalePhases[index],
						toPhase: step.phase,
						reason: "stale session recovery",
					});
				}
				saveQuest(quest, ctx.cwd);
				rt.setQuest(quest);
				ctx.ui.notify?.(
					`Recovered ${recovered.length} stale step(s) (#${recovered.map((i) => i + 1).join(", #")}) from a previous session.`,
					"info",
				);
			}

			// Stale owned worktrees are deliberately retained: restart cleanup must
			// never destroy unintegrated evidence.
			for (const index of recovered) {
				const step = quest.steps[index];
				const worktreePath = step.sandboxArtifacts?.worktreePath;
				if (worktreePath && existsSync(worktreePath)) {
					rt.transitionStep(ctx, quest, index, "blocked", "stale worktree retained");
					step.result =
						`${step.result ?? ""}\n[RECOVERY] Owned worktree retained at ${worktreePath}.`.trim();
				} else if (step.sandboxArtifacts) {
					delete step.sandboxArtifacts.worktreePath;
					step.branchName = null;
				}
			}
			if (recovered.length > 0) saveQuest(quest, ctx.cwd);
		}

		renderStatus(ctx, quest);
		writeQuestSessionMeta(ctx.cwd, quest);
		if (quest?.status === "active") syncQuestToTodo(quest, ctx.cwd);
		pushActivityUI(ctx, rt);

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
		pushActivityUI(ctx, rt);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearActivityUI(ctx, rt);
	});

	// ── Activity panel ────────────────────────────────────────────────────────

	const TRACKED_TOOLS = new Set(["subagent", "quest_delegate"]);

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		const quest = getQuest(ctx.cwd);
		if (!quest) return;
		rt.activity.onStart(
			event.toolCallId,
			event.toolName as "subagent" | "quest_delegate",
			event.args,
			quest,
		);
		pushActivityUI(ctx, rt);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		rt.activity.onUpdate(event.toolCallId, event.partialResult);
		pushActivityUI(ctx, rt);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		rt.activity.onEnd(
			event.toolCallId,
			event.isError,
			event.isError ? String(event.result?.error ?? event.result ?? "unknown error") : undefined,
		);
		pushActivityUI(ctx, rt);
	});

	// ── Sandbox + write-claim enforcement ────────────────────────────────────
	pi.on("tool_call", (event, ctx) => {
		const quest = getQuest(ctx.cwd);

		// ── Sandbox enforcement (R8: max of quest + guard-active steps) ───
		if (quest && quest.status === "active") {
			const profile = effectiveSandboxProfile(quest);
			if (isSandboxActive(profile)) {
				const decision = evaluateToolCall(
					profile,
					event.toolName,
					event.input as unknown as Record<string, unknown>,
				);
				if (decision.block) {
					ctx.ui.notify?.(decision.reason ?? "Sandbox: tool call blocked.", "warning");
					return { block: true, reason: decision.reason };
				}
			}
		}

		// ── Write-claim enforcement: pi-minions subagent spawn (R2) ───────
		// Resolves single-agent and multi-task `tasks[]` forms; does not rely
		// solely on lastFiredStepIndex so parallel batches are fully enforced.
		if (event.toolName === "subagent" && quest?.status === "active") {
			const input = (event.input as Record<string, unknown> | undefined) ?? {};
			const targets = resolveSubagentClaimTargets(quest, input);
			if (targets.length === 0) return;

			// Only roll back claims this call newly acquired — never drop claims
			// already held (e.g. parallel selectDispatchBatch pre-registration).
			const alreadyHeld = new Set(claimReg.active(ctx.cwd).map((c) => c.stepIndex));
			const newlyRegistered: number[] = [];
			const rollback = () => {
				for (const idx of newlyRegistered) claimReg.unregister(ctx.cwd, idx);
			};

			for (const target of targets) {
				const step = quest.steps[target.stepIndex];
				const claimErr = validateClaims(target.agent, target.writeClaim, target.readClaim);
				if (claimErr) {
					rollback();
					ctx.ui.notify?.(claimErr, "error");
					return { block: true, reason: claimErr };
				}

				let normalized: string[];
				try {
					normalizeClaims(target.readClaim, ctx.cwd);
					normalized = normalizeClaims(target.writeClaim, ctx.cwd);
				} catch (error) {
					rollback();
					const reason = error instanceof Error ? error.message : String(error);
					ctx.ui.notify?.(reason, "error");
					return { block: true, reason };
				}
				if (normalized.length === 0) continue;

				const conflict = claimReg.register(ctx.cwd, target.stepIndex, step.content, normalized);
				if (conflict) {
					rollback();
					const msg =
						`Write-claim conflict: step #${target.stepIndex + 1} ("${step.content}") ` +
						`wants to write to paths that step #${conflict.stepIndex + 1} ` +
						`("${conflict.stepContent}") already holds. ` +
						`Wait for step #${conflict.stepIndex + 1} to complete or abort it first.`;
					ctx.ui.notify?.(msg, "error");
					return { block: true, reason: msg };
				}
				if (!alreadyHeld.has(target.stepIndex)) {
					newlyRegistered.push(target.stepIndex);
				}
			}
		}
	});
}

// ── Activity UI helpers ──────────────────────────────────────────────────────

export function pushActivityUI(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	rt2: QuestRuntime,
): void {
	if (!ctx.hasUI) return;
	const quest = rt2.getQuest(ctx.cwd);
	const snap = quest ? rt2.activity.questSnapshot(quest) : null;

	ctx.ui.setWidget(
		"quest-activity",
		rt2.activity.hasActivity || snap ? buildActivityWidgetFn(rt2.activity, snap) : undefined,
		{ placement: "aboveEditor" },
	);
	ctx.ui.setStatus("quest-activity", buildActivityFooter(rt2.activity, snap) ?? undefined);
	ctx.ui.setWorkingIndicator(buildActivityWorkingIndicator(rt2.activity));
}

export function clearActivityUI(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	rt2: QuestRuntime,
): void {
	rt2.activity.reset();
	if (!ctx.hasUI) return;
	ctx.ui.setWidget("quest-activity", undefined);
	ctx.ui.setStatus("quest-activity", undefined);
	ctx.ui.setStatus("quest", undefined);
	ctx.ui.setWorkingIndicator();
}
