import type { DashboardCycle, DashboardStats } from "./dashboard-types";

export interface AgentRecapResult {
	markdown: string;
	json: Record<string, unknown>;
}

function formatGeneratedAt(ms: number): string {
	const d = new Date(ms);
	if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "unknown";
	const iso = d.toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function hasLiveQuest(stats: DashboardStats): boolean {
	return stats.health.activeQuests > 0 || stats.health.pausedQuests > 0;
}

function cycleLine(cycle: DashboardCycle, live: boolean): string {
	if (live) {
		return `- **${cycle.name}**: ${cycle.active} running / ${cycle.done} done (${count(cycle.steps, "step")})`;
	}
	const failed = Math.max(0, cycle.steps - cycle.done);
	const verified = `${cycle.done}/${cycle.steps} verified`;
	return failed > 0
		? `- **${cycle.name}**: ${verified} (${failed} failed)`
		: `- **${cycle.name}**: ${verified}`;
}

export function buildRecapMarkdown(stats: DashboardStats): string {
	const lines: string[] = [];
	const generatedAt = formatGeneratedAt(stats.session.updatedAt ?? stats.sessionMetaTimestamp);
	const live = hasLiveQuest(stats);

	lines.push("# Agent Performance Recap");
	lines.push("");
	lines.push(`generated: ${generatedAt}`);
	lines.push("");

	if (stats.goals.length > 0) {
		lines.push("## Goals");
		lines.push("");
		for (const goal of stats.goals) {
			lines.push(
				`- **${goal.name}**: ${goal.status}, ${goal.totalDone}/${goal.totalSteps} steps done`,
			);
		}
		lines.push("");
	}

	lines.push("## Cycle Health");
	lines.push("");
	if (stats.cycles.length === 0) {
		lines.push("No eval history yet.");
	} else {
		for (const cycle of stats.cycles) {
			lines.push(cycleLine(cycle, live));
		}
	}
	lines.push("");

	lines.push("## Active Agents");
	lines.push("");
	if (stats.agents.length === 0) {
		lines.push(live ? "No agent steps recorded." : "No active quest.");
	} else {
		for (const agent of stats.agents) {
			let icon = "○";
			if (agent.status === "active") icon = "●";
			else if (agent.status === "paused") icon = "◐";
			const model = agent.model ? ` → ${agent.model}` : "";
			lines.push(
				`- **${agent.agent}** (${agent.role}${model}): ${icon} ${agent.activeSteps} running / ${agent.queuedSteps} queued / ${agent.failedSteps} failed`,
			);
		}
	}
	lines.push("");

	lines.push("## Daily Trends");
	lines.push("");
	if (stats.trends.length === 0) {
		lines.push("No trend data available.");
	} else {
		lines.push("| Date | Samples | Passed | Failed | Avg | Escalations |");
		lines.push("|------|---------|--------|--------|-----|-------------|");
		for (const trend of stats.trends) {
			lines.push(
				`| ${trend.date} | ${trend.totalSteps} | ${trend.completed} | ${trend.active} | ${formatDurationMs(trend.averageTurnDurationMs)} | ${trend.escalations} |`,
			);
		}
	}
	lines.push("");

	lines.push("## Health");
	lines.push("");
	if (!live) {
		lines.push("No active quest.");
		lines.push(
			`Defaults: ${stats.health.maxConcurrent} concurrent, burst ${stats.health.maxBurst}, ${stats.health.defaultRetryPolicy}.`,
		);
	} else {
		lines.push(`- Max concurrent: ${stats.health.maxConcurrent}`);
		lines.push(`- Max burst: ${stats.health.maxBurst}`);
		lines.push(`- Retry policy: ${stats.health.defaultRetryPolicy}`);
		lines.push(`- Active quests: ${stats.health.activeQuests}`);
		lines.push(`- Paused quests: ${stats.health.pausedQuests}`);
		lines.push(`- Stalled: ${stats.health.stalled}`);
		if (stats.health.knownIssues.length > 0) {
			lines.push(`- Known issues: ${stats.health.knownIssues.join("; ")}`);
		}
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
