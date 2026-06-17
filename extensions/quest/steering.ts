import type { Quest, QuestTask } from "./types";
import { MAX_BURST, MAX_RETRIES, ICON, FORMAT_DIRECTIVE } from "./constants";
import { compactAwarenessBlock } from "./todo-sync";

export function nextPendingTask(quest: Quest): { task: QuestTask; index: number } | null {
	for (let i = 0; i < quest.tasks.length; i++) {
		const t = quest.tasks[i];
		if (t.status !== "pending") continue;
		const allDepsMet = t.dependencies.every((d) => {
			const s = quest.tasks[d]?.status;
			return s === "done" || s === "skipped";
		});
		if (!allDepsMet) continue;
		return { task: t, index: i };
	}
	return null;
}

export function formatTaskTime(t: QuestTask): string {
	if (!t.startedAt) return "";
	const end = t.completedAt ?? Date.now();
	const ms = end - t.startedAt;
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
	return `${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

export function formatQuestStatus(quest: Quest): string {
	const total = quest.tasks.length;
	const todo = quest.tasks.filter((t) => t.status === "pending");
	const doing = quest.tasks.filter((t) => t.status === "running" || t.status === "verifying");
	const completed = quest.tasks.filter((t) => t.status === "done");
	const done = completed.length;
	const verified = completed.filter((t) => t.verified).length;
	const failed = quest.tasks.filter((t) => t.status === "failed");
	const skipped = quest.tasks.filter((t) => t.status === "skipped");
	const verifying = quest.tasks.filter((t) => t.status === "verifying");

	const barWidth = 20;
	const doneW = Math.round((done / Math.max(total, 1)) * barWidth);
	const vfyW = Math.round((verifying.length / Math.max(total, 1)) * barWidth);
	const failW = Math.round((failed.length / Math.max(total, 1)) * barWidth);
	const pendW = barWidth - doneW - vfyW - failW;
	const pbar = `${"█".repeat(doneW)}${"◎".repeat(vfyW)}${"░".repeat(Math.max(pendW, 0))}${"✗".repeat(failW)}`;

	const modeTag = quest.planningMode === "approve" ? ` · mode: ${quest.planningMode}` : "";
	const approveTag = quest.planningMode === "approve" && !quest.planApproved ? ` · ⚠ AWAITING` : "";
	const verifyTag = quest.verifyOnComplete ? ` · verify: on` : "";
	const gitTag = quest.gitIntegration?.autoCommit ? ` · git: ${quest.commits.length}c` : "";

	const lines: string[] = [
		`**Quest: ${quest.name}**  [${quest.status.toUpperCase()}${modeTag}${approveTag}${verifyTag}${gitTag}]`,
		`Goal: ${quest.goal}`,
		``,
		`\`${pbar}\`  ${done}/${total} done${verified > 0 ? ` (${verified} verified)` : ""}`,
		`${todo.length} todo · ${doing.length} in progress · ${failed.length} failed · ${skipped.length} skipped`,
	];

	if (quest.tasks.length === 0) {
		lines.push(``);
		lines.push("No tasks yet. Use quest_plan to create a task breakdown.");
	} else {
		const fmtDep = (t: QuestTask) =>
			t.dependencies.length ? ` ← #${t.dependencies.map((d) => d + 1).join(",#")}` : "";

		// TODO
		if (todo.length > 0) {
			lines.push(``, `━━━ 📋 TODO (${todo.length}) ━━━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of todo) {
				const i = quest.tasks.indexOf(t);
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${fmtDep(t)}`);
			}
		}

		// IN PROGRESS
		if (doing.length > 0) {
			lines.push(``, `━━━ 🔄 IN PROGRESS (${doing.length}) ━━━━━━━━━━━━━━━`);
			for (const t of doing) {
				const i = quest.tasks.indexOf(t);
				const time = formatTaskTime(t);
				const timeStr = time ? ` ⏱ ${t.status === "verifying" ? "verifying " : ""}${time}` : "";
				const vInfo =
					t.status === "verifying"
						? t.verifyResult
							? ` — ${t.verifyResult.slice(0, 40)}`
							: ` — verifying...`
						: "";
				lines.push(
					`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${timeStr}${vInfo}${fmtDep(t)}`,
				);
			}
		}

		// DONE
		if (completed.length > 0) {
			lines.push(``, `━━━ ✅ DONE (${completed.length}) ━━━━━━━━━━━━━━━━━━━━━`);
			for (const t of completed) {
				const i = quest.tasks.indexOf(t);
				const time = formatTaskTime(t);
				const timeStr = time ? ` ⏱ ${time}` : "";
				const verifiedStr = t.verified ? ` ✅` : "";
				const resultSnippet = t.result ? ` — ${t.result.slice(0, 50)}` : "";
				lines.push(
					`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${verifiedStr}${timeStr}${resultSnippet}`,
				);
			}
		}

		// FAILED / SKIPPED
		if (failed.length > 0 || skipped.length > 0) {
			lines.push(``, `━━━ ❌ FAILED / SKIPPED (${failed.length + skipped.length}) ━━━`);
			for (const t of [...failed, ...skipped]) {
				const i = quest.tasks.indexOf(t);
				const info =
					t.status === "failed"
						? ` — attempts ${t.attempts}/${MAX_RETRIES + 1}${t.verifyResult ? ` · ${t.verifyResult.slice(0, 30)}` : ""}`
						: "";
				lines.push(`${ICON[t.status]} #${i + 1} ${t.content}  [${t.agent}]${info}`);
			}
		}
	}

	if (quest.pauseReason) {
		lines.push(``, `⚠ ${quest.pauseReason}`);
	}
	if (quest.planningMode === "approve" && !quest.planApproved && quest.tasks.length > 0) {
		lines.push(
			``,
			`📋 Plan needs approval. Use /quest approve or quest_approve to start execution.`,
		);
	}
	if (quest.status === "active") {
		lines.push(
			``,
			`Auto-pilot: task ${quest.tasksSincePause}/${MAX_BURST} before auto-pause. /quest pause to stop.`,
		);
	}

	return lines.join("\n");
}

export function buildSteeringMessage(
	quest: Quest,
	task: QuestTask,
	index: number,
	cwd: string,
): string {
	const done = quest.tasks.filter((t) => t.status === "done").length;
	const total = quest.tasks.length;

	const deps = task.dependencies.map((d) => `#${d + 1} — ${quest.tasks[d].content}`).join(", ");

	return [
		`## Quest: ${quest.name} (${done}/${total} done)`,
		``,
		`**Current task:** ${task.content}`,
		`**Use subagent:** \`${task.agent}\``,
		`**Context:** ${task.context}`,
		deps ? `**Depends on:** ${deps}` : "",
		compactAwarenessBlock(cwd),
		``,
		FORMAT_DIRECTIVE,
		``,
		`When complete, call **quest_update** with task index ${index} to mark it done.`,
		`If you hit a blocker you can't resolve, call quest_update with status "failed" and explain why.`,
		``,
		`Auto-pilot: ${quest.tasksSincePause + 1}/${MAX_BURST} — /quest pause to stop.`,
	]
		.filter(Boolean)
		.join("\n");
}
