import type { Quest, QuestStep } from "./types";

function iconFor(status: QuestStep["status"]): string {
	switch (status) {
		case "done":
			return "✅";
		case "skipped":
			return "⏭️";
		case "failed":
			return "❌";
		case "verifying":
			return "🔎";
		case "running":
			return "▶️";
		default:
			return "☐";
	}
}

function oneLine(text: string | null | undefined): string {
	return (text || "").split("\n")[0]?.trim() || "";
}

function short(text: string, max = 120): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function duration(start: number, end: number | null): string {
	const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function buildQuestRecap(quest: Quest): string {
	const done = quest.steps.filter((s) => s.status === "done").length;
	const skipped = quest.steps.filter((s) => s.status === "skipped").length;
	const verified = quest.steps.filter((s) => s.verified).length;
	const lines = [
		`## Quest Recap: ${quest.name} ✅`,
		``,
		`**Goal:** ${quest.goal}`,
		``,
		`**Scorecard:** ${done}/${quest.steps.length} done` +
			(skipped ? `, ${skipped} skipped` : "") +
			(verified ? `, ${verified} verified` : "") +
			`, ${quest.commits.length} commit(s), ${duration(quest.createdAt, quest.completedAt)} elapsed.`,
		``,
		`### Steps`,
	];

	for (const [i, step] of quest.steps.entries()) {
		const result = oneLine(step.result || step.verifyResult);
		lines.push(
			`- ${iconFor(step.status)} #${i + 1} **${step.content}**${result ? ` — ${short(result)}` : ""}`,
		);
	}

	if (quest.commits.length) {
		lines.push(``, `### Git`);
		for (const commit of quest.commits.slice(0, 5)) {
			lines.push(`- \`${commit.hash.slice(0, 8)}\` ${commit.message}`);
		}
		if (quest.commits.length > 5) lines.push(`- …and ${quest.commits.length - 5} more`);
		if (quest.gitIntegration?.autoPR)
			lines.push(``, `🔀 Auto-PR enabled. Run quest_git_summary().`);
	} else if (quest.gitIntegration?.autoCommit) {
		lines.push(
			``,
			`⚠ No commits were recorded for this quest. Use quest_commit to track deliverables.`,
		);
	}

	lines.push(
		``,
		quest.conventions.length
			? `Saved ${quest.conventions.length} convention(s) to project memory.`
			: `No quest conventions to save to project memory.`,
		``,
		`Review later with quest_history, or start another with /quest create.`,
	);

	return lines.join("\n");
}
