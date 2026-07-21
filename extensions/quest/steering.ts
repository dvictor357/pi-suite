import type { Quest, QuestStep } from "./types";
import { MAX_BURST, MAX_RETRIES, ICON, LADDER } from "./constants";
import { loadAgentModels, loadModelLadder } from "./storage";
import { briefBudgetForModel, renderFailureBriefs, rungModel } from "./ladder";
import { resolveSandboxProfile } from "./sandbox";
import { buildStepContext, collectDependencyHandoffs } from "./context-broker";
import { resolvePhase } from "./phase-loop";

/**
 * Whether the just-ended turn was aborted by the user (Esc), as opposed to
 * finishing on its own. pi-ai closes an interrupted turn with a final assistant
 * message whose `stopReason` is `"aborted"`; a normal turn ends with `"stop"`
 * or `"toolUse"`. The `agent_end` event fires either way and carries no abort
 * flag of its own, so this is the only reliable signal. Typed structurally so it
 * needs no SDK import (cf. `delegate.ts`'s `FinalTurnMessages`).
 */
export function wasTurnAborted(messages: ReadonlyArray<unknown> | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string } | null;
		if (m?.role === "assistant") return m.stopReason === "aborted";
	}
	return false;
}

export function nextPendingStep(quest: Quest): { task: QuestStep; index: number } | null {
	for (let i = 0; i < quest.steps.length; i++) {
		const t = quest.steps[i];
		if (t.status !== "pending" || resolvePhase(t) !== "queued") continue;
		const allDepsMet = t.dependencies.every((d) => {
			const s = quest.steps[d]?.status;
			return s === "done" || s === "skipped";
		});
		if (!allDepsMet) continue;
		return { task: t, index: i };
	}
	return null;
}

export function formatStepTime(t: QuestStep): string {
	if (!t.startedAt) return "";
	const end = t.completedAt ?? Date.now();
	const ms = end - t.startedAt;
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
	return `${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

export function formatQuestStatus(quest: Quest): string {
	const total = quest.steps.length;
	const todo = quest.steps.filter((t) => t.status === "pending");
	const doing = quest.steps.filter((t) => t.status === "running" || t.status === "verifying");
	const completed = quest.steps.filter((t) => t.status === "done");
	const done = completed.length;
	const verified = completed.filter((t) => t.verified).length;
	const failed = quest.steps.filter((t) => t.status === "failed");
	const skipped = quest.steps.filter((t) => t.status === "skipped");
	const verifying = quest.steps.filter((t) => t.status === "verifying");

	const barWidth = 20;
	const doneW = Math.round((done / Math.max(total, 1)) * barWidth);
	const vfyW = Math.round((verifying.length / Math.max(total, 1)) * barWidth);
	const failW = Math.round((failed.length / Math.max(total, 1)) * barWidth);
	const pendW = barWidth - doneW - vfyW - failW;
	const pbar = `${"█".repeat(doneW)}${"◎".repeat(vfyW)}${"░".repeat(Math.max(pendW, 0))}${"✗".repeat(failW)}`;

	const modeTag = quest.planningMode === "approve" ? ` · mode: ${quest.planningMode}` : "";
	const sandboxTag = quest.sandbox?.mode ? ` · sandbox: ${quest.sandbox.mode}` : "";
	const approveTag = quest.planningMode === "approve" && !quest.planApproved ? ` · ⚠ AWAITING` : "";
	const verifyTag = quest.verifyOnComplete ? ` · verify: on` : "";
	const gitTag = quest.gitIntegration?.autoCommit ? ` · git: ${quest.commits.length}c` : "";

	const lines: string[] = [
		`**Quest: ${quest.name}**  [${quest.status.toUpperCase()}${modeTag}${sandboxTag}${approveTag}${verifyTag}${gitTag}]`,
		`Goal: ${quest.goal}`,
		``,
		`\`${pbar}\`  ${done}/${total} done${verified > 0 ? ` (${verified} verified)` : ""}`,
		`${todo.length} todo · ${doing.length} in progress · ${failed.length} failed · ${skipped.length} skipped`,
	];

	if (quest.steps.length === 0) {
		lines.push(``);
		lines.push("No steps yet. Use quest_plan to create a step breakdown.");
	} else {
		const fmtDep = (t: QuestStep) =>
			t.dependencies.length ? ` ← #${t.dependencies.map((d) => d + 1).join(",#")}` : "";

		const sbMark = (t: QuestStep) => {
			const parts: string[] = [];
			if (t.sandbox) parts.push("🔒");
			if (t.sandboxArtifacts) {
				const a = t.sandboxArtifacts;
				if (a.touchedPaths.length) parts.push(`📄${a.touchedPaths.length}`);
				if (a.changedFiles?.length) parts.push(`Δ${a.changedFiles.length}`);
				const blocked = a.calls.filter((c) => c.blocked).length;
				if (blocked) parts.push(`🚫${blocked}`);
				if (a.worktreePath) parts.push(`🌳`);
			}
			if (t.writeClaim && t.writeClaim.length > 0) {
				parts.push(`✍️${t.writeClaim.length}`);
			}
			return parts.length ? ` ${parts.join(" ")}` : "";
		};

		// TODO
		if (todo.length > 0) {
			lines.push(``, `━━━ 📋 TODO (${todo.length}) ━━━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of todo) {
				const i = quest.steps.indexOf(t);
				lines.push(
					`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${sbMark(t)}${fmtDep(t)}`,
				);
			}
		}

		// IN PROGRESS
		if (doing.length > 0) {
			lines.push(``, `━━━ 🔄 IN PROGRESS (${doing.length}) ━━━━━━━━━━━━━━━`);
			for (const t of doing) {
				const i = quest.steps.indexOf(t);
				const time = formatStepTime(t);
				const timeStr = time ? ` ⏱ ${t.status === "verifying" ? "verifying " : ""}${time}` : "";
				const vInfo =
					t.status === "verifying"
						? t.verifyResult
							? ` — ${t.verifyResult.slice(0, 40)}`
							: ` — verifying...`
						: "";
				lines.push(
					`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${sbMark(t)}${timeStr}${vInfo}${fmtDep(t)}`,
				);
			}
		}

		// DONE
		if (completed.length > 0) {
			lines.push(``, `━━━ ✅ DONE (${completed.length}) ━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of completed) {
				const i = quest.steps.indexOf(t);
				const time = formatStepTime(t);
				const timeStr = time ? ` ⏱ ${time}` : "";
				const verifiedStr = t.verified ? ` ✅` : "";
				const resultSnippet = t.result ? ` — ${t.result.slice(0, 50)}` : "";
				lines.push(
					`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${sbMark(t)}${verifiedStr}${timeStr}${resultSnippet}`,
				);
			}
		}

		// FAILED / SKIPPED
		if (failed.length > 0 || skipped.length > 0) {
			lines.push(``, `━━━ ❌ FAILED / SKIPPED (${failed.length + skipped.length}) ━━━`);
			for (const t of [...failed, ...skipped]) {
				const i = quest.steps.indexOf(t);
				const info =
					t.status === "failed"
						? ` — attempts ${t.attempts}/${MAX_RETRIES + 1}${t.verifyResult ? ` · ${t.verifyResult.slice(0, 30)}` : ""}`
						: "";
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${sbMark(t)}${info}`);
			}
		}
	}

	if (quest.pauseReason) {
		lines.push(``, `⚠ ${quest.pauseReason}`);
	}
	if (quest.planningMode === "approve" && !quest.planApproved && quest.steps.length > 0) {
		lines.push(
			``,
			`📋 Plan needs approval. Use /quest approve or quest_approve to start execution.`,
		);
	}
	if (quest.status === "active") {
		lines.push(
			``,
			`Auto-pilot: step ${quest.stepsSincePause}/${MAX_BURST} before auto-pause. /quest pause to stop.`,
		);
	}

	return lines.join("\n");
}

export function buildSteeringMessage(
	quest: Quest,
	task: QuestStep,
	index: number,
	cwd: string,
): string {
	const done = quest.steps.filter((t) => t.status === "done").length;
	const total = quest.steps.length;

	const deps = task.dependencies.map((d) => `#${d + 1} — ${quest.steps[d].content}`).join(", ");

	// Dependency results: collected via context-broker for structured handoffs.
	const dependencyResults = collectDependencyHandoffs(quest, task);

	// Surface sandbox context when the quest or step has an active sandbox.
	const sandboxProfile = resolveSandboxProfile(quest.sandbox, task.sandbox);
	const sandboxMode = sandboxProfile.mode;
	const sandboxActive = Boolean(sandboxMode && sandboxMode !== "none");
	const sandboxBlock = sandboxActive
		? `**Sandbox:** ${
				sandboxMode === "isolated" ? "isolated 🔒" : "restricted 🔒"
			} — use the guarded Quest fallback; pi-minions does not enforce this policy yet.`
		: "";

	// Surface the runtime to use for this minion: the task's own model wins, else
	// the current approved ladder rung, else the project's remembered role choice.
	// Unsandboxed work goes through pi-minions; active Quest sandboxes retain the
	// guarded compatibility path because that enforcement is local to pi-suite.
	const rememberedChoice = loadAgentModels(cwd)[task.agent];
	const remembered = rememberedChoice?.model;
	const thinkingLevel = rememberedChoice?.thinkingLevel;
	const ladder = task.rung !== undefined ? loadModelLadder(cwd) : null;
	const ladderModel = ladder && !task.model?.trim() ? rungModel(ladder, task.rung ?? 0) : undefined;
	const assignedModel = task.model?.trim() || ladderModel?.trim() || remembered?.trim();

	// Build the complete sub-agent prompt via the shared context broker so the
	// pi-minions child agent receives actual step content, dependency handoffs,
	// failure briefs, sandbox constraints, project awareness, format directive,
	// and the completion schema — not a generic reference to the parent steering
	// message it cannot see. Parent steer stays slim (progress + model + call);
	// briefs/awareness/format live only in the child task= payload.
	const modelInfo = assignedModel ? { id: assignedModel } : undefined;
	const briefBlock = renderFailureBriefs(
		task.failureBriefs,
		briefBudgetForModel(modelInfo, LADDER),
		LADDER.maxBriefs,
	);

	const minionTask = buildStepContext({
		role: task.agent,
		content: task.content,
		context: task.context,
		dependencyResults,
		failureBriefBlock: briefBlock,
		sandboxProfile: sandboxActive ? sandboxProfile : undefined,
		modelInfo,
		cwd,
		// pi-minions adds its own agent persona; legacy framing is only for
		// quest_delegate.
		includeLegacyFraming: false,
	});

	const minionArgs = [
		`agent=${JSON.stringify(task.agent)}`,
		`task=${JSON.stringify(minionTask)}`,
		assignedModel ? `model=${JSON.stringify(assignedModel)}` : "",
		thinkingLevel ? `thinking=${JSON.stringify(thinkingLevel)}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const modelLine = assignedModel
		? sandboxActive
			? `**Model:** \`${assignedModel}\`${thinkingLevel ? ` · thinking \`${thinkingLevel}\`` : ""}.\n**Guarded call:** \`quest_delegate(index=${index})\``
			: [
					ladderModel
						? `**Model:** rung ${task.rung! + 1}/${ladder!.rungs.length} — \`${assignedModel}\` (ladder).`
						: `**Model:** \`${assignedModel}\`${thinkingLevel ? ` · thinking \`${thinkingLevel}\`` : ""}.`,
					`**Minion call:** \`subagent(${minionArgs})\``,
				].join("\n")
		: sandboxActive
			? `**Model:** none assigned for role \`${task.agent}\`. First call quest_assign_model(role=${JSON.stringify(task.agent)}, proposed="…", thinkingLevel="…", stepIndex=${index}), then call \`quest_delegate(index=${index})\`.`
			: `**Model:** none assigned for role \`${task.agent}\`. First call quest_assign_model(role=${JSON.stringify(task.agent)}, proposed="…", thinkingLevel="…", stepIndex=${index}), then call \`subagent(agent=${JSON.stringify(task.agent)}, task=${JSON.stringify(minionTask)})\`.`;

	// Write-claim advisory for the current step.
	const claimBlock =
		task.writeClaim && task.writeClaim.length > 0
			? `**Write claims:** ${task.writeClaim.map((p) => `\`${p}\``).join(", ")}\n⚠ Other running steps must not write to these paths.`
			: "";

	// ── Steering message (orchestrator-visible overview + tool-call suggestion) ──
	// Deliberately omits brief/awareness/format dumps — those are already embedded
	// in minionTask via buildStepContext. Duplicating them here doubled tokens for
	// the parent without helping the child (who only sees task=).
	return [
		`## Quest: ${quest.name} (${done}/${total} done)`,
		``,
		`**Current step:** ${task.content}`,
		`**Agent role:** \`${task.agent}\``,
		`**Context:** ${task.context}`,
		deps ? `**Depends on:** ${deps}` : "",
		sandboxBlock,
		claimBlock,
		modelLine,
		``,
		`When complete, call **quest_update** with step index ${index} to mark it done.`,
		`If you hit a blocker you can't resolve, call quest_update with status "failed" and explain why.`,
		``,
		`Auto-pilot: ${quest.stepsSincePause + 1}/${MAX_BURST} — /quest pause to stop.`,
	]
		.filter(Boolean)
		.join("\n");
}
