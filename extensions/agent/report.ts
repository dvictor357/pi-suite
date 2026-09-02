import type { DashboardStats } from "./dashboard-types";

export interface AgentRecapResult {
	markdown: string;
	json: Record<string, unknown>;
}

export function buildRecapMarkdown(stats: DashboardStats): string {
	const lines: string[] = [];
	const generatedAt = new Date(stats.session.updatedAt ?? stats.sessionMetaTimestamp).toISOString();

	lines.push("# Agent Performance Recap");
	lines.push("");
	lines.push(`generated: ${generatedAt}`);
	lines.push("");

	lines.push("## Cycle Health");
	lines.push("");
	if (stats.cycles.length === 0) {
		lines.push("No active cycles.");
	} else {
		for (const cycle of stats.cycles) {
			lines.push(
				`- **${cycle.name}**: ${cycle.active} active / ${cycle.completed} done (${cycle.steps} steps, ${cycle.done} completed)`,
			);
		}
	}
	lines.push("");

	lines.push("## Active Agents");
	lines.push("");
	if (stats.agents.length === 0) {
		lines.push("No agent steps recorded.");
	} else {
		for (const agent of stats.agents) {
			let icon = "○";
			if (agent.status === "active") icon = "●";
			else if (agent.status === "paused") icon = "◐";
			lines.push(
				`- **${agent.agent}** (${agent.role} → ${agent.model}): ${icon} active ${agent.activeSteps} / queued ${agent.queuedSteps} / failed ${agent.failedSteps}`,
			);
		}
	}
	lines.push("");

	lines.push("## Daily Trends");
	lines.push("");
	if (stats.trends.length === 0) {
		lines.push("No trend data available.");
	} else {
		lines.push("| Date | Steps | Active | Completed | Avg Turn (ms) | Escalations |");
		lines.push("|------|-------|--------|-----------|---------------|-------------|");
		for (const trend of stats.trends) {
			lines.push(
				`| ${trend.date} | ${trend.totalSteps} | ${trend.active} | ${trend.completed} | ${trend.averageTurnDurationMs} | ${trend.escalations} |`,
			);
		}
	}
	lines.push("");

	lines.push("## Health");
	lines.push("");
	lines.push(`- Max concurrent: ${stats.health.maxConcurrent}`);
	lines.push(`- Max burst: ${stats.health.maxBurst}`);
	lines.push(`- Retry policy: ${stats.health.defaultRetryPolicy}`);
	lines.push(`- Active quests: ${stats.health.activeQuests}`);
	lines.push(`- Paused quests: ${stats.health.pausedQuests}`);
	lines.push(`- Stalled: ${stats.health.stalled}`);
	if (stats.health.knownIssues.length > 0) {
		lines.push(`- Known issues: ${stats.health.knownIssues.join("; ")}`);
	}

	return lines.join("\n");
}

export function buildRecapJson(stats: DashboardStats): Record<string, unknown> {
	return {
		session: stats.session,
		agents: stats.agents,
		goals: stats.goals,
		cycles: stats.cycles,
		trends: stats.trends,
		health: stats.health,
	};
}
