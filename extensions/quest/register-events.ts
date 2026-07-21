import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { MAX_BURST, MAX_RETRIES } from "./constants";
import {
	archiveQuest,
	clearActiveQuest,
	loadModelLadder,
	loadQuest,
	saveQuest,
	syncConventionsToMemory,
} from "./storage";
import { buildFailureBrief, rungModel } from "./ladder";
import { formatQuestStatus, wasTurnAborted } from "./steering";
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
import { recoverStaleRuns } from "./phase-loop";
import { cleanStaleWorktrees } from "./parallel";
import type { QuestRuntime } from "./runtime";
import type { Quest } from "./types";
import {
	decideAfterAgentEnd,
	snapshotQuestForAutoPilot,
	type ReadyDecision,
	type SequentialDecision,
	type UnresolvedAction,
} from "./auto-pilot";

/** Minimal shape of the pi `agent_end` event used by the auto-pilot adapter. */
export type AgentEndEvent = {
	messages?: readonly unknown[];
};

/**
 * Optional test seam for {@link handleAgentEnd}. Production callers omit this;
 * crash-path tests inject `runBody` that throws mid-handler.
 */
export type AgentEndOptions = {
	/**
	 * When set, replaces the normal auto-pilot body inside the try block.
	 * Used by tests to force a throw without mocking pure decision helpers.
	 */
	runBody?: (
		pi: ExtensionAPI,
		rt: QuestRuntime,
		event: AgentEndEvent,
		ctx: ExtensionContext,
	) => void | Promise<void>;
};

/**
 * Crash-safe `agent_end` auto-pilot handler.
 *
 * On unexpected throw: pauses the quest, records `pauseReason`, persists
 * best-effort, and never rethrows (no uncaught rejection on the event bus).
 * Exported so R9 tests can drive the catch path with a forced mid-handler throw.
 */
export async function handleAgentEnd(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	event: AgentEndEvent,
	ctx: ExtensionContext,
	options?: AgentEndOptions,
): Promise<void> {
	if (rt.isAutoPilotLocked()) return;
	try {
		if (options?.runBody) {
			await options.runBody(pi, rt, event, ctx);
			return;
		}
		await runAgentEndAutoPilot(pi, rt, event, ctx);
	} catch (e) {
		recoverAgentEndCrash(rt, ctx, e);
	}
}

/**
 * Best-effort recovery after an unexpected throw in the agent_end body.
 * Pauses the active quest (when present), persists, updates UI/session/todo.
 * Does not rethrow — callers must remain crash-safe on the event bus.
 */
export function recoverAgentEndCrash(
	rt: QuestRuntime,
	ctx: ExtensionContext,
	error: unknown,
): void {
	console.error("[pi-quest] agent_end handler crashed:", error);
	const quest = rt.getQuest(ctx.cwd);
	if (quest) {
		quest.status = "paused";
		quest.pauseReason = `Auto-pilot error: ${(error as Error)?.message || String(error)}`;
		try {
			saveQuest(quest, ctx.cwd);
		} catch (persistErr) {
			console.error("[pi-quest] agent_end crash persist failed:", persistErr);
		}
		rt.setQuest(quest);
	}
	try {
		renderStatus(ctx, quest);
		writeQuestSessionMeta(ctx.cwd, quest);
		if (quest) syncQuestToTodo(quest, ctx.cwd);
	} catch (sideErr) {
		console.error("[pi-quest] agent_end crash side-effects failed:", sideErr);
	}
	if (quest && ctx.hasUI) {
		ctx.ui.notify(
			`Quest auto-pilot error: ${(error as Error)?.message || String(error)}. Quest paused.`,
			"error",
		);
	}
}

/** Normal auto-pilot body (decision → apply I/O). Kept separate for the crash seam. */
async function runAgentEndAutoPilot(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	event: AgentEndEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const { getQuest, persist } = rt;
	const quest = getQuest(ctx.cwd);
	if (!quest || quest.status !== "active") return;

	// Pure decision first (abort / requeue plan / sequential tree). Adapter
	// applies I/O below — see extensions/quest/auto-pilot.ts.
	const ladderHint = loadModelLadder(ctx.cwd);
	const decision = decideAfterAgentEnd({
		wasAborted: wasTurnAborted(event.messages),
		hasUI: !!ctx.hasUI,
		quest: snapshotQuestForAutoPilot(quest),
		nextStepLadderLength: ladderHint?.rungs.length ?? 0,
	});

	// ── Abort (Esc) ──────────────────────────────────────────────────
	// User interrupt: halt auto-pilot so a single Esc stops the quest.
	if (decision.kind === "abort_pause") {
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

	// ── Unresolved dispatching/running → fail or requeue ─────────────
	applyUnresolved(rt, ctx, quest, decision.unresolved);

	// ── Parallel dispatch (opt-in) ────────────────────────────────────
	// fireParallelBatch handles recovery, integration, batch selection.
	// When it returns false, fall through to the shared sequential path.
	if (decision.tryParallel) {
		const dispatched = rt.fireParallelBatch(ctx, quest);
		if (dispatched) return;
	}

	// Re-decide sequential from live state after requeue side effects
	// (beginStepRetry may block some indices → phases differ from simulation).
	const ladder = loadModelLadder(ctx.cwd);
	const sequential = decideAfterAgentEnd({
		wasAborted: false,
		hasUI: !!ctx.hasUI,
		quest: snapshotQuestForAutoPilot(quest),
		nextStepLadderLength: ladder?.rungs.length ?? 0,
	});
	if (sequential.kind !== "proceed") return;

	await applySequential(pi, rt, ctx, quest, sequential.sequential, ladder);
}

export function registerEvents(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, claims: claimReg, dispatchGuard } = rt;

	pi.on("agent_end", async (event, ctx) => {
		await handleAgentEnd(pi, rt, event, ctx);
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

// ── Auto-pilot adapter helpers (I/O for pure decisions) ──────────────────────

function applyUnresolved(
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	unresolved: readonly UnresolvedAction[],
): void {
	for (const u of unresolved) {
		const step = quest.steps[u.index];
		if (!step) continue;
		if (u.action === "fail") {
			rt.transitionStep(ctx, quest, u.index, "failed", "dispatch turn ended unresolved");
			step.completedAt = Date.now();
			continue;
		}
		if (!rt.beginStepRetry(ctx, quest, u.index, "dispatch turn ended unresolved")) continue;
		rt.transitionStep(ctx, quest, u.index, "queued", "bounded unresolved retry");
	}
}

async function applySequential(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	decision: SequentialDecision,
	ladder: ReturnType<typeof loadModelLadder>,
): Promise<void> {
	const { persist } = rt;

	switch (decision.kind) {
		case "complete": {
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
			return;
		}

		case "verifying": {
			await applyVerifying(pi, rt, ctx, quest, decision);
			return;
		}

		case "failed_steps": {
			await applyFailedSteps(pi, rt, ctx, quest, decision);
			return;
		}

		case "blocked": {
			quest.status = "paused";
			quest.pauseReason = "All remaining steps are blocked by unfinished dependencies.";
			persist(ctx, quest);
			return;
		}

		case "stall": {
			await applyStall(pi, rt, ctx, quest, decision);
			return;
		}

		case "fail_budget": {
			const step = quest.steps[decision.index];
			if (!step) return;
			rt.transitionStep(ctx, quest, decision.index, "failed", "attempt budget exhausted");
			step.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
			quest.lastFiredStepIndex = -1;
			quest.sameStepCount = 0;
			persist(ctx, quest);
			return;
		}

		case "escalate": {
			const applied = applyEscalate(rt, ctx, quest, decision.index, decision.nextRung, ladder);
			if (!applied) return;
			// Fall through to burst/fire (pre-extract: no return after successful escalate).
			await applyReady(pi, rt, ctx, quest, decision.then);
			return;
		}

		case "ready": {
			// Stamp stall counter before burst/fire (pre-extract mutated quest.sameStepCount).
			quest.sameStepCount = decision.sameStepCount;
			await applyReady(pi, rt, ctx, quest, decision);
			return;
		}
	}
}

async function applyVerifying(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	decision: Extract<SequentialDecision, { kind: "verifying" }>,
): Promise<void> {
	const { persist } = rt;
	const verifyingTasks = decision.indices.map((i) => quest.steps[i]).filter(Boolean);
	const vfyList = decision.indices
		.map((idx) => `- #${idx + 1} **${quest.steps[idx]?.content ?? ""}**`)
		.join("\n");

	if (decision.allResolved) {
		if (decision.offerPrompt && ctx.hasUI) {
			const action = await ctx.ui.select(
				`${verifyingTasks.length} step(s) need verification. What now?`,
				["Verify them now (agent will handle it)", "Skip verification for all", "Pause quest"],
			);

			if (action === "Verify them now (agent will handle it)") {
				rt.setAutoPilotLocked(true);
				try {
					pi.sendUserMessage(
						[
							`## Verification Pending ⏳`,
							``,
							`${verifyingTasks.length} step(s) awaiting verification:`,
							decision.indices
								.map(
									(idx) =>
										`- #${idx + 1} **${quest.steps[idx]?.content ?? ""}** — Use subagent(agent="verifier") then call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`,
								)
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
				for (const idx of decision.indices) {
					const t = quest.steps[idx];
					if (!t) continue;
					rt.transitionStep(ctx, quest, idx, "done", "verification skipped by user");
					t.verified = true;
					t.verifyResult = "[SKIP] Verification skipped by user.";
					t.completedAt = Date.now();
				}
				persist(ctx, quest);
				ctx.ui.notify(`${verifyingTasks.length} step(s) verified (skipped). Continuing...`, "info");
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
						decision.indices
							.map(
								(idx) =>
									`- #${idx + 1} **${quest.steps[idx]?.content ?? ""}** — call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`,
							)
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
	}

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
}

async function applyFailedSteps(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	decision: Extract<SequentialDecision, { kind: "failed_steps" }>,
): Promise<void> {
	const { persist } = rt;
	const failedTasks = decision.indices.map((i) => quest.steps[i]).filter(Boolean);
	const failedList = decision.indices
		.map((i) => {
			const t = quest.steps[i];
			return `  #${i + 1}: ${t?.content ?? ""} — ${t?.result || "no details"}`;
		})
		.join("\n");

	if (decision.offerPrompt && ctx.hasUI) {
		const action = await ctx.ui.select(
			`${failedTasks.length} step(s) failed. What would you like to do?`,
			["Retry failed steps", "Skip all failed", "Pause and review"],
		);

		if (action === "Retry failed steps") {
			for (const index of decision.indices) {
				const t = quest.steps[index];
				if (!t) continue;
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
			ctx.ui.notify(`${failedTasks.length} step(s) reset for retry. Auto-pilot resuming.`, "info");
			return;
		}

		if (action === "Skip all failed") {
			for (const index of decision.indices) {
				const t = quest.steps[index];
				if (!t) continue;
				rt.transitionStep(ctx, quest, index, "skipped", "user skipped");
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
}

async function applyStall(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	decision: Extract<SequentialDecision, { kind: "stall" }>,
): Promise<void> {
	const { persist } = rt;
	const step = quest.steps[decision.index];
	if (!step) return;

	if (decision.offerPrompt && ctx.hasUI) {
		const action = await ctx.ui.select(
			`Step "${decision.content}" stalled after ${decision.sameStepCount} attempts. What now?`,
			["Skip this step", "Mark as failed", "Pause quest"],
		);

		if (action === "Skip this step") {
			rt.transitionStep(ctx, quest, decision.index, "skipped", "stalled step skipped");
			step.result = `Skipped by user after stalling (${decision.sameStepCount} attempts).`;
			step.completedAt = Date.now();
			quest.lastFiredStepIndex = -1;
			quest.sameStepCount = 0;
			persist(ctx, quest);
			ctx.ui.notify(`Step #${decision.index + 1} skipped.`, "info");
			return;
		}

		if (action === "Mark as failed") {
			rt.transitionStep(ctx, quest, decision.index, "failed", "stalled step failed");
			step.result = `Failed by user after stalling (${decision.sameStepCount} attempts).`;
			step.completedAt = Date.now();
			quest.lastFiredStepIndex = -1;
			quest.sameStepCount = 0;
			persist(ctx, quest);
			ctx.ui.notify(`Step #${decision.index + 1} marked failed.`, "warning");
			return;
		}
	}

	quest.status = "paused";
	quest.pauseReason = `Step #${decision.index + 1} stalled (${decision.sameStepCount} attempts without progress).`;
	quest.lastFiredStepIndex = -1;
	quest.sameStepCount = 0;
	persist(ctx, quest);

	if (ctx.hasUI) {
		ctx.ui.notify(`Quest paused: stalled step. /quest resume to continue.`, "warning");
	} else {
		rt.setAutoPilotLocked(true);
		try {
			pi.sendUserMessage(
				`## Quest Paused: Stalled ⚠\n\nStep #${decision.index + 1} "${decision.content}" has been attempted ${decision.sameStepCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
				{ deliverAs: "steer" },
			);
		} finally {
			rt.setAutoPilotLocked(false);
		}
	}
}

function applyEscalate(
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	index: number,
	nextRung: number,
	ladder: ReturnType<typeof loadModelLadder>,
): boolean {
	const { persist } = rt;
	const step = quest.steps[index];
	if (!step || !ladder) return false;

	if (!rt.beginStepRetry(ctx, quest, index, "attempt budget escalation")) {
		quest.status = "paused";
		quest.pauseReason = `Step #${index + 1} retry is blocked by retained worktree evidence.`;
		persist(ctx, quest);
		return false;
	}

	const fromRung = step.rung;
	const fromModel =
		step.lastModel ??
		step.model ??
		(fromRung !== undefined ? rungModel(ladder, fromRung) : undefined);
	const toModel = rungModel(ladder, nextRung);
	const evidence = `Task attempt budget exhausted after ${MAX_RETRIES + 1} attempts.`;

	step.failureBriefs = [
		...(step.failureBriefs ?? []),
		buildFailureBrief({
			attempt: (step.failureBriefs?.length ?? 0) + 1,
			model: fromModel,
			rung: fromRung,
			evidence,
			attempted: step.result,
			inferred: false,
		}),
	];
	step.attempts = 0;
	step.verifyRetries = 0;
	step.rung = nextRung;
	step.escalations = (step.escalations ?? 0) + 1;
	step.startedAt = null;
	step.completedAt = null;
	step.result = `${evidence} Escalating from ${fromModel ?? "previous model"} to rung ${nextRung} (${toModel}).`;
	rt.transitionStep(ctx, quest, index, "queued", "escalated retry queued");
	quest.lastFiredStepIndex = -1;
	quest.sameStepCount = 0;
	persist(ctx, quest);
	rt.recordRun(ctx.cwd, {
		kind: "escalate",
		taskIndex: index,
		taskContent: step.content,
		agent: step.agent,
		model: fromModel,
		fromModel,
		toModel,
		rung: nextRung,
		timestamp: Date.now(),
		evidence,
	});
	return true;
}

async function applyReady(
	pi: ExtensionAPI,
	rt: QuestRuntime,
	ctx: ExtensionContext,
	quest: Quest,
	ready: ReadyDecision,
): Promise<void> {
	const { persist } = rt;
	const step = quest.steps[ready.index];
	if (!step) return;

	if (ready.burst.hit) {
		if (ready.burst.offerConfirm && ctx.hasUI) {
			const cont = await ctx.ui.confirm(
				"Quest Checkpoint",
				[
					`**${ready.burst.stepsSincePause} steps** completed in this burst.`,
					``,
					`Progress: **${ready.doneCount}/${ready.totalCount}** done`,
					`Next: **${ready.content}** [${ready.agent}]`,
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
				quest.pauseReason = `User paused at checkpoint after ${ready.burst.stepsSincePause} steps. /quest resume to continue.`;
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
					`## Quest Paused: Checkpoint ⏸\n\n${ready.burst.stepsSincePause}/${MAX_BURST} steps completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
					{ deliverAs: "steer" },
				);
			} finally {
				rt.setAutoPilotLocked(false);
			}
			return;
		}
	}

	if (ready.fire === "parallel_conflict") {
		// Parallel mode: nextPendingStep found a step selectDispatchBatch skipped
		// (write-claim conflict or guard slot contention). Pause for investigation.
		quest.status = "paused";
		quest.pauseReason = `Step #${ready.index + 1} ("${ready.content}") is ready but was not dispatched by the parallel selector. Possible write-claim conflict. Check quest_claims() or /quest resume.`;
		quest.lastFiredStepIndex = -1;
		quest.sameStepCount = 0;
		persist(ctx, quest);
		if (ctx.hasUI) {
			ctx.ui.notify?.(
				`Quest paused: parallel dispatch could not fire step #${ready.index + 1}. Check claim conflicts.`,
				"warning",
			);
		}
		return;
	}

	rt.fireStep(ctx, quest, step, ready.index);
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
