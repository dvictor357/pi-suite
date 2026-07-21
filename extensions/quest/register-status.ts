import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { updateJSON, projectMemoryPath, CONTRACT_VERSION, isFutureContract } from "./utils";
import { ensureBuiltInTeams, loadTeams } from "./teams";
import { formatQuestStatus } from "./steering";
import { listArchives, saveQuest } from "./storage";
import { renderStatus, writeQuestSessionMeta } from "./status";
import type { QuestRuntime } from "./runtime";
import {
	readAllEvalEntries,
	computeEvalStats,
	computeEvalTimeSeries,
	formatEvalStatsReport,
} from "../../core";

export function registerStatusTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, claims: claimReg } = rt;

	pi.registerTool({
		name: "quest_status",
		label: "Quest Status",
		description: "Show the current quest, its steps, and progress.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [
						{
							type: "text",
							text: "No active quest. Create one with quest_create or /quest create.",
						},
					],
					details: {},
				};
			}
			renderStatus(ctx, quest);
			writeQuestSessionMeta(ctx.cwd, quest);

			// Append active write claims to status output for visibility.
			const active = claimReg.active(ctx.cwd);
			const claimsBlock =
				active.length > 0
					? [
							``,
							`━━━ 🔒 ACTIVE WRITE CLAIMS (${active.length}) ━━━━━━━━━━━━━━━`,
							...active.map(
								(c) =>
									`  Step #${c.stepIndex + 1} "${c.stepContent}" → ${c.paths.map((p) => `\`${p}\``).join(", ")}`,
							),
						].join("\n")
					: "";

			return {
				content: [{ type: "text", text: formatQuestStatus(quest) + claimsBlock }],
				details: { quest, activeClaims: active },
			};
		},
	});

	pi.registerTool({
		name: "quest_commit",
		label: "Quest Commit",
		description: [
			"Record a git commit as a deliverable for a completed quest step.",
			"Use this after committing code changes for a specific step.",
			"Each commit is tracked and included in the quest's git summary.",
		].join(" "),
		parameters: Type.Object({
			taskIndex: Type.Optional(
				Type.Number({
					description:
						"Step index (0-based) that this commit belongs to (legacy — prefer stepIndex)",
				}),
			),
			stepIndex: Type.Optional(
				Type.Number({
					description: "Step index (0-based) that this commit belongs to",
				}),
			),
			commitHash: Type.String({
				description: "Git commit hash (short or full SHA)",
			}),
			commitMessage: Type.String({ description: "Commit message" }),
			branchName: Type.Optional(
				Type.String({ description: "Branch name where the commit was made" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const index = params.stepIndex ?? params.taskIndex;
			if (index === undefined) {
				return {
					content: [{ type: "text", text: "A step index (stepIndex) is required." }],
					details: {},
				};
			}
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest. Use quest_create first." }],
					details: {},
				};
			}

			if (index < 0 || index >= quest.steps.length) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid step index ${index}. Valid: 0-${quest.steps.length - 1}.`,
						},
					],
					details: {},
				};
			}

			const step = quest.steps[index];
			step.commitHash = params.commitHash;
			if (step.sandboxArtifacts) step.sandboxArtifacts.commitHash = params.commitHash;
			if (params.branchName) step.branchName = params.branchName;

			quest.commits.push({
				stepIndex: index,
				taskIndex: index,
				hash: params.commitHash,
				message: params.commitMessage,
				branch: params.branchName,
				timestamp: Date.now(),
			});

			persist(ctx, quest);

			return {
				content: [
					{
						type: "text",
						text: [
							`📝 Commit recorded for step #${index + 1}: **${step.content}**`,
							`  Hash: \`${params.commitHash.slice(0, 8)}\``,
							`  Message: ${params.commitMessage}`,
							params.branchName ? `  Branch: ${params.branchName}` : "",
							``,
							`Total quest commits: ${quest.commits.length}`,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					stepIndex: index,
					taskIndex: index,
					commitHash: params.commitHash,
					totalCommits: quest.commits.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_git_summary",
		label: "Quest Git Summary",
		description: [
			"Show a summary of all git commits associated with this quest.",
			"Also generates a PR-ready summary of all changes.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest." }],
					details: {},
				};
			}

			const git = quest.gitIntegration;
			if (!quest.commits || quest.commits.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No commits recorded for this quest yet. Use quest_commit to record them.",
						},
					],
					details: { commits: [], gitConfig: git },
				};
			}

			const commitsByTask = quest.commits.reduce(
				(acc, c) => {
					const stepIndex = c.stepIndex;
					const step = quest.steps[stepIndex];
					const key = `#${stepIndex + 1} ${step?.content || "unknown"}`;
					if (!acc[key]) acc[key] = [];
					acc[key].push(c);
					return acc;
				},
				{} as Record<string, typeof quest.commits>,
			);

			const lines: string[] = [
				`## Git Summary: ${quest.name}`,
				``,
				`**${quest.commits.length} commit(s)** across **${Object.keys(commitsByTask).length} step(s)**`,
				``,
			];

			for (const [taskLabel, commits] of Object.entries(commitsByTask)) {
				lines.push(`### ${taskLabel}`);
				for (const c of commits) {
					lines.push(
						`- \`${c.hash.slice(0, 8)}\` ${c.message}${c.branch ? ` *(branch: ${c.branch})*` : ""}`,
					);
				}
				lines.push(``);
			}

			if (git?.autoPR) {
				lines.push(`---`);
				lines.push(``);
				lines.push(`### PR Summary (auto-generated)`);
				lines.push(``);
				lines.push(`**Goal:** ${quest.goal}`);
				lines.push(``);
				lines.push(`**Changes:**`);
				for (const c of quest.commits) {
					lines.push(`- ${c.message}`);
				}
				lines.push(``);
				lines.push(
					`**Steps completed:** ${quest.steps.filter((t) => t.status === "done").length}/${quest.steps.length}`,
				);
				lines.push(`**Commits:** ${quest.commits.length}`);
				if (git.autoBranch) {
					const branches = [...new Set(quest.commits.map((c) => c.branch).filter(Boolean))];
					lines.push(`**Branches:** ${branches.join(", ") || "default"}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					commits: quest.commits,
					tasksWithCommits: Object.keys(commitsByTask).length,
					gitConfig: git,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_team",
		label: "Quest Team",
		description: [
			"List available team configurations and their member agents.",
			"Teams define which sub-agents are used for different roles in a quest.",
			"Use the team parameter in quest_create to assign a team.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			ensureBuiltInTeams();
			const teams = loadTeams();
			const names = Object.keys(teams);
			if (names.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No teams configured. Built-in teams will be created on first run.",
						},
					],
					details: { teams: [] },
				};
			}
			const lines = names.map((n) => {
				const t = teams[n]!;
				const members = t.members.map((m) => `${m.role} → ${m.agent}`).join(", ");
				const agentsInfo = t.agents?.length
					? `\n  Custom agents: ${t.agents.map((a) => a.name).join(", ")}`
					: "";
				return [
					`**${t.name}** — ${t.description}`,
					`  Lead: ${t.lead}  |  Default agent: ${t.defaultAgent}  |  Verification: ${t.verification ? "on" : "off"}`,
					`  Members: ${members}${agentsInfo}`,
				].join("\n");
			});
			return {
				content: [{ type: "text", text: `## Quest Teams\n\n${lines.join("\n\n")}` }],
				details: { teams: names },
			};
		},
	});

	pi.registerTool({
		name: "quest_history",
		label: "Quest History",
		description: "Browse past completed quests (default: 5 most recent).",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({
					description: "Number of past quests to show (default 5)",
					default: 5,
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const archives = listArchives(params.limit ?? 5, ctx.cwd);
			if (archives.length === 0) {
				return {
					content: [{ type: "text", text: "No completed quests yet." }],
					details: { archives: [] },
				};
			}
			const lines = archives.map((a, idx) => {
				const date = a.completedAt
					? new Date(a.completedAt).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
						})
					: "?";
				return `${idx + 1}. **${a.name}** — ${a.done}/${a.steps} done — ${date}\n   ${a.goal}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: { archives },
			};
		},
	});

	pi.registerTool({
		name: "quest_memory_save",
		label: "Quest Memory Save",
		description: [
			"Save a research finding to the current quest. If a finding with the same key exists, it is updated.",
			"Findings are also synced to project memory (best-effort) for cross-quest awareness.",
		].join(" "),
		parameters: Type.Object({
			key: Type.String({
				description: 'Unique key for this finding (e.g. "api-auth", "best-practice-deployment")',
			}),
			value: Type.String({ description: "The research finding content" }),
			category: Type.Optional(
				Type.String({
					description: 'Optional category for grouping (e.g. "security", "performance", "api")',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest. Use quest_create first." }],
					details: {},
				};
			}

			if (!quest.researchFindings) quest.researchFindings = [];

			const existing = quest.researchFindings.find((f) => f.key === params.key);
			const timestamp = Date.now();
			if (existing) {
				existing.value = params.value;
				if (params.category !== undefined) existing.category = params.category;
				existing.timestamp = timestamp;
			} else {
				quest.researchFindings.push({
					key: params.key,
					value: params.value,
					category: params.category,
					timestamp,
				});
			}

			saveQuest(quest, ctx.cwd);
			rt.setQuest(quest);
			renderStatus(ctx, quest);
			writeQuestSessionMeta(ctx.cwd, quest);

			// Mirror the finding onto pi-memory's project file for cross-quest
			// awareness. Read-merge-write so a concurrent pi-memory save isn't
			// clobbered, and skip if pi-memory wrote a newer contract.
			updateJSON<Record<string, any>>(
				projectMemoryPath(ctx.cwd),
				(memory) => {
					if (isFutureContract(memory)) return memory;
					const research = { ...(memory.research ?? {}) };
					research[params.key] = {
						value: params.value,
						category: params.category ?? null,
						timestamp,
					};
					return { ...memory, research, contractVersion: CONTRACT_VERSION };
				},
				{},
			);

			const action = existing ? "Updated" : "Saved";
			return {
				content: [
					{
						type: "text",
						text: [
							`${action} research finding **${params.key}**`,
							params.category ? `  Category: ${params.category}` : "",
							``,
							`Total findings: ${quest.researchFindings.length}`,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					key: params.key,
					totalFindings: quest.researchFindings.length,
				},
			};
		},
	});

	// ── quest_eval_stats ───────────────────────────────────────────────────

	pi.registerTool({
		name: "quest_eval_stats",
		label: "Quest Eval Stats",
		description: [
			"Show eval stats for this project: per-(agent, model) verified pass rates",
			"and a daily time series of pass rates, average durations, and model-ladder",
			"escalations, aggregated from all past quest eval logs.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const entries = readAllEvalEntries(ctx.cwd);
			const roleStats = computeEvalStats(entries);
			const series = computeEvalTimeSeries(entries);
			const text = formatEvalStatsReport(roleStats, series);

			return {
				content: [{ type: "text", text }],
				details: {
					roleStats: [...roleStats.values()],
					series,
				},
			};
		},
	});

	// ── quest_claims ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "quest_claims",
		label: "Quest Write Claims",
		description: [
			"Show active write claims registered by currently running steps.",
			"Use this to diagnose write-claim conflicts — when a step delegation is",
			"rejected, the conflicting step and its claimed paths are listed here.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const active = claimReg.active(ctx.cwd);
			if (active.length === 0) {
				return {
					content: [{ type: "text", text: "No active write claims." }],
					details: { claims: [] },
				};
			}
			const lines = [
				`## Active Write Claims (${active.length})`,
				"",
				...active.map(
					(c) =>
						`- **Step #${c.stepIndex + 1}** "${c.stepContent}" (registered ${new Date(c.registeredAt).toISOString()})
  Paths: ${c.paths.map((p) => `\`${p}\``).join(", ")}`,
				),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { claims: active },
			};
		},
	});

	// ── Additional tools ────────────────────────────────────────────────────
}
