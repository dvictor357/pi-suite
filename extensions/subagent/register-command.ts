import { loadAgentModels as loadQuestAgentModels } from "../../core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { formatRunDetail, formatRunList, listRuns, loadRun, planRerun } from "./history.js";
import { readSubagentSettings, resolveAgentRuntime } from "./runner.js";

export function registerSubagentCommand(pi: ExtensionAPI): void {
	// Show how each agent's tier resolves to a concrete model/thinking level.
	pi.registerCommand("subagent", {
		description:
			"Show subagent model routing. Subcommands: runs (recent history), show <id>, rerun <id> [all]",
		handler: async (args, ctx) => {
			const [sub, id, scopeArg] = (args ?? "").trim().split(/\s+/);
			if (sub === "runs") {
				ctx.ui.notify(formatRunList(listRuns(ctx.cwd)), "info");
				return;
			}
			if (sub === "show" || sub === "rerun") {
				if (!id) {
					ctx.ui.notify(`Usage: /subagent ${sub} <run id>`, "warning");
					return;
				}
				try {
					const record = loadRun(ctx.cwd, id);
					if (sub === "show") {
						ctx.ui.notify(formatRunDetail(record), "info");
						return;
					}
					const scope = scopeArg === "all" ? "all" : "failed";
					const plan = planRerun(record, scope);
					if ("error" in plan) {
						ctx.ui.notify(plan.error, "warning");
						return;
					}
					const call = JSON.stringify({
						rerun: record.id,
						...(scope === "all" ? { rerunScope: "all" } : {}),
					});
					pi.sendUserMessage(
						`Re-run ${plan.summary} by calling the subagent tool with ${call}, then report the results.`,
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			const cfg = readSubagentSettings();
			const models = cfg.models ?? {};
			const thinking = cfg.thinking ?? {};
			const lines: string[] = ['Tier routing (settings.json → "subagent"):'];
			const tiers = new Set([...Object.keys(models), ...Object.keys(thinking)]);
			if (tiers.size === 0) {
				lines.push(
					"  (none configured — agents use their explicit model/thinking, or pi defaults)",
				);
			} else {
				for (const t of tiers) {
					lines.push(
						`  ${t}: ${models[t] ?? "(pi default model)"}${thinking[t] ? ` · think:${thinking[t]}` : ""}`,
					);
				}
			}
			const questModels = loadQuestAgentModels(ctx.cwd);
			if (Object.keys(questModels).length > 0) {
				lines.push("", "pi-quest role models (project memory, win over tiers):");
				for (const [role, c] of Object.entries(questModels)) {
					lines.push(`  ${role} → ${c.model}${c.provider ? ` · ${c.provider}` : ""}`);
				}
			}
			lines.push("", "Agents → resolved:");
			const { agents } = discoverAgents(ctx.cwd, "both");
			for (const a of [...agents].sort((x, y) => x.name.localeCompare(y.name))) {
				const r = resolveAgentRuntime(a, ctx.cwd);
				// Label must mirror resolveAgentRuntime precedence:
				// explicit > quest > tier > default.
				const via = a.model
					? "[explicit]"
					: questModels[a.name]?.model
						? "[quest]"
						: a.tier
							? `[${a.tier}]`
							: "[default]";
				lines.push(
					`  ${a.name} ${via} → ${r.model ?? "(pi default)"}${r.thinking ? ` · think:${r.thinking}` : ""}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
