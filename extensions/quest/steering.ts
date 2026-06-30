import type { Quest, QuestStep } from "./types";
import { MAX_BURST, MAX_RETRIES, ICON, FORMAT_DIRECTIVE } from "./constants";
import { compactAwarenessBlock } from "./todo-sync";
import { loadAgentModels } from "./storage";

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
		if (t.status !== "pending") continue;
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

		const sbMark = (t: QuestStep) => (t.sandbox ? " 🔒" : "");

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

	// Surface sandbox context when the quest or step has an active sandbox.
	const sandboxMode = task.sandbox?.mode || quest.sandbox?.mode;
	const sandboxBlock = sandboxMode
		? `**Sandbox:** ${
				sandboxMode === "isolated" ? "isolated 🔒" : "restricted 🔒"
			} — sub-agent is restricted per sandbox policy.`
		: "";

	// Surface the model to run this sub-agent with: the task's own assignment
	// wins, else the project's remembered choice for this role. When neither
	// exists, nudge the orchestrator to propose one via quest_assign_model.
	const remembered = loadAgentModels(cwd)[task.agent]?.model;
	const assignedModel = task.model?.trim() || remembered?.trim();
	const modelLine = assignedModel
		? `**Model:** \`${assignedModel}\` — delegate with quest_delegate(index=${index}).`
		: `**Model:** none assigned for role \`${task.agent}\`. Propose one via quest_assign_model(role="${task.agent}", proposed="…", taskIndex=${index}), then quest_delegate(index=${index}).`;

	return [
		`## Quest: ${quest.name} (${done}/${total} done)`,
		``,
		`**Current step:** ${task.content}`,
		`**Use subagent:** \`${task.agent}\``,
		`**Context:** ${task.context}`,
		deps ? `**Depends on:** ${deps}` : "",
		sandboxBlock,
		modelLine,
		compactAwarenessBlock(cwd),
		``,
		FORMAT_DIRECTIVE,
		``,
		`When complete, call **quest_update** with step index ${index} to mark it done.`,
		`If you hit a blocker you can't resolve, call quest_update with status "failed" and explain why.`,
		``,
		`Auto-pilot: ${quest.stepsSincePause + 1}/${MAX_BURST} — /quest pause to stop.`,
	]
		.filter(Boolean)
		.join("\n");
}
