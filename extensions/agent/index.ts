import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { fetchDashboard } from "./dashboard";
import type { DashboardStats } from "./dashboard-types";
import { buildRecapJson, buildRecapMarkdown } from "./report";

function renderAgentStatus(ctx: ExtensionContext, stats: DashboardStats): void {
	if (stats.health.activeQuests === 0 && stats.health.pausedQuests === 0) {
		ctx.ui.setStatus?.("agent", "");
		return;
	}
	const live = stats.agents.reduce((n, a) => n + a.activeSteps, 0);
	const queued = stats.agents.reduce((n, a) => n + a.queuedSteps, 0);
	const icon = stats.health.pausedQuests > 0 ? "◆" : "●";
	const label = `${icon} ${live} live · ${queued} queued`;
	const theme = (ctx.ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
	const color = stats.health.pausedQuests > 0 ? "warning" : "accent";
	ctx.ui.setStatus?.("agent", theme?.fg ? theme.fg(color, label) : label);
}

async function recapFor(
	cwd: string,
	format: "markdown" | "json",
): Promise<{
	text: string;
	json: Record<string, unknown>;
	stats: DashboardStats;
}> {
	const stats = await fetchDashboard(cwd);
	const json = buildRecapJson(stats);
	const text = format === "json" ? JSON.stringify(json, null, 2) : buildRecapMarkdown(stats);
	return { text, json, stats };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_e, ctx) => {
		try {
			const stats = await fetchDashboard(ctx.cwd);
			renderAgentStatus(ctx, stats);
		} catch {
			ctx.ui.setStatus?.("agent", "");
		}
	});

	pi.registerTool({
		name: "agent_dashboard",
		label: "Agent Dashboard",
		description: [
			"Show the agent performance recap for this project: live/queued/failed steps",
			"by role, eval cycle health, daily trends, and retry/burst limits.",
			"Reads quest state, eval JSONL, and session-meta. Does not write shared files.",
		].join(" "),
		promptSnippet: "Project agent dashboard: live steps, eval cycles, daily trends",
		promptGuidelines: [
			"Use agent_dashboard when the user asks how agents/quests are performing, or before deciding whether to escalate a model.",
			"Prefer format=json when you need to parse counts; markdown is for a human recap.",
		],
		parameters: Type.Object({
			format: Type.Optional(
				StringEnum(["markdown", "json"] as const, {
					description: "Output format (default markdown)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const format = params.format === "json" ? "json" : "markdown";
			try {
				const recap = await recapFor(ctx.cwd, format);
				renderAgentStatus(ctx, recap.stats);
				return {
					content: [{ type: "text", text: recap.text }],
					details: recap.json,
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: "Dashboard unavailable — read sources may be corrupt or missing.",
						},
					],
					details: {},
				};
			}
		},
	});

	pi.registerCommand("agent", {
		description:
			"Agent performance dashboard. /agent for markdown, /agent json for structured JSON.",
		handler: async (args, ctx) => {
			const format = args.trim() === "json" ? "json" : "markdown";
			try {
				const recap = await recapFor(ctx.cwd, format);
				renderAgentStatus(ctx, recap.stats);
				ctx.ui.notify(recap.text, "info");
			} catch {
				ctx.ui.notify("Dashboard unavailable — read sources may be corrupt or missing.", "error");
			}
		},
	});
}
