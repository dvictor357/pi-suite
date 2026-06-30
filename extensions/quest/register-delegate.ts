import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FORMAT_DIRECTIVE } from "./constants";
import { archiveQuest, loadAgentModels, rememberAgentModel } from "./storage";
import { resolveTaskModel, buildSubAgentPrompt } from "./delegate";
import { clearQuestFromTodo } from "./todo-sync";
import { loadTeams } from "./teams";
import { matchModel, promptModelAssignment, toModelLike } from "./models";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { resolveSandboxProfile, sandboxToolsForRole } from "./sandbox";
import { logDeprecatedParam } from "./deprecation";
import { runSubAgent } from "./subagent";
import type { QuestRuntime } from "./runtime";

export function registerDelegateTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, textResult, resolvePersona, stampTaskModel } = rt;

	pi.registerTool({
		name: "quest_assign_model",
		label: "Quest Assign Model",
		description: [
			"Assign a model to a sub-agent role for this project. As orchestrator you propose a model;",
			"the user approves it or picks another from their configured models. The approved choice is",
			"remembered in project memory (so the user is asked once per role) and, when stepIndex is given,",
			"stamped onto that step. Call this before quest_delegate when a role has no model yet.",
		].join(" "),
		parameters: Type.Object({
			role: Type.String({
				description: "Sub-agent role (e.g. 'scout', 'worker', 'verifier')",
			}),
			proposed: Type.String({
				description:
					"Model id you propose for this role (e.g. 'claude-opus-4-5' or 'deepseek/deepseek-v4-flash')",
			}),
			reason: Type.Optional(
				Type.String({ description: "Short rationale for proposing this model" }),
			),
			taskIndex: Type.Optional(
				Type.Number({
					description:
						"Also stamp the approved model onto this step (0-based) — legacy, prefer stepIndex",
				}),
			),
			stepIndex: Type.Optional(
				Type.Number({
					description: "Also stamp the approved model onto this step (0-based)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			const role = params.role.trim();
			if (!role) return textResult("Role is required.");

			const index = params.stepIndex ?? params.taskIndex;
			if (params.taskIndex !== undefined && params.stepIndex === undefined) {
				logDeprecatedParam(
					"quest_assign_model",
					params as Record<string, unknown>,
					"taskIndex",
					"stepIndex",
				);
			}

			if (!ctx.hasUI) {
				const available = ctx.modelRegistry.getAvailable().map(toModelLike);
				const matched = matchModel(available, params.proposed);
				if (!matched) {
					return textResult(
						`Running headlessly and "${params.proposed}" isn't an available model — cannot assign a model for "${role}".`,
					);
				}
				rememberAgentModel(ctx.cwd, role, {
					model: matched.id,
					provider: matched.provider,
					reason: params.reason,
					timestamp: Date.now(),
				});
				stampTaskModel(quest, index, matched.id, ctx);
				return {
					content: [
						{
							type: "text",
							text: `(headless) Assigned "${role}" → ${matched.id} · ${matched.provider}.`,
						},
					],
					details: { role, model: matched.id, provider: matched.provider, outcome: "assigned" },
				};
			}

			const result = await promptModelAssignment(ctx, {
				role,
				proposed: params.proposed,
				reason: params.reason,
			});
			if (result.outcome === "cancelled") {
				return {
					content: [{ type: "text", text: `Model assignment for "${role}" cancelled.` }],
					details: { role, outcome: "cancelled" },
				};
			}
			if (result.outcome === "default") {
				return {
					content: [
						{
							type: "text",
							text: `Kept harness default for "${role}" (no override). quest_delegate will run it with the session's current model.`,
						},
					],
					details: { role, outcome: "default" },
				};
			}
			const m = result.model;
			rememberAgentModel(ctx.cwd, role, {
				model: m.id,
				provider: m.provider,
				reason: params.reason,
				timestamp: Date.now(),
			});
			stampTaskModel(quest, index, m.id, ctx);
			return {
				content: [
					{
						type: "text",
						text: `Assigned sub-agent "${role}" → ${m.id} · ${m.provider}. Remembered for this project.`,
					},
				],
				details: { role, model: m.id, provider: m.provider, outcome: "assigned" },
			};
		},
	});

	pi.registerTool({
		name: "quest_delegate",
		label: "Quest Delegate",
		description: [
			"Run a quest step by spawning an isolated sub-agent with the model assigned to its role.",
			"The model is resolved from the task, else the project's remembered choice for the role.",
			"If none is assigned, pass `proposed` (or call quest_assign_model first). Read-only roles",
			"(scout/verifier/reviewer/planner) get a read-only tool scope. Returns the sub-agent's",
			"result; you then call quest_update to record completion.",
		].join(" "),
		parameters: Type.Object({
			index: Type.Number({ description: "Step index to delegate (0-based)" }),
			proposed: Type.Optional(
				Type.String({ description: "Model to propose if the role has none assigned yet" }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) return textResult("No active quest. Use quest_create first.");
			if (params.index < 0 || params.index >= quest.steps.length) {
				return textResult(
					`Invalid step index ${params.index}. Valid: 0-${quest.steps.length - 1}.`,
				);
			}
			const task = quest.steps[params.index];
			const role = task.agent;

			const remembered = loadAgentModels(ctx.cwd)[role]?.model;
			const resolved = resolveTaskModel({ taskModel: task.model, rememberedModel: remembered });
			let modelId = resolved.model;

			if (resolved.needsPrompt) {
				const teamHints = quest.team ? (loadTeams()[quest.team]?.modelHints ?? {}) : {};
				const proposal = params.proposed?.trim() || teamHints[role];
				if (!proposal) {
					return textResult(
						`No model assigned for role "${role}". Call quest_assign_model(role="${role}", proposed="…", stepIndex=${params.index}) first, or pass proposed= to quest_delegate.`,
					);
				}
				if (!ctx.hasUI) {
					modelId = proposal;
				} else {
					const result = await promptModelAssignment(ctx, { role, proposed: proposal });
					if (result.outcome === "cancelled") {
						return textResult(`Delegation cancelled — no model approved for "${role}".`);
					}
					if (result.outcome === "assigned") {
						modelId = result.model.id;
						rememberAgentModel(ctx.cwd, role, {
							model: result.model.id,
							provider: result.model.provider,
							timestamp: Date.now(),
						});
						stampTaskModel(quest, params.index, result.model.id, ctx);
					}
					// "default" → leave modelId unset and fall back to ctx.model below.
				}
			}

			const available = ctx.modelRegistry.getAvailable();
			const model = (modelId ? matchModel(available, modelId) : undefined) ?? ctx.model;
			if (!model) {
				return textResult(
					`Could not resolve a model to run "${role}" (assigned "${modelId ?? "none"}"). Assign one with quest_assign_model.`,
				);
			}

			const sandboxProfile = resolveSandboxProfile(quest.sandbox, task.sandbox);
			const sandboxTools = sandboxToolsForRole(role, sandboxProfile);

			const dependencyResults = task.dependencies.map((d) => ({
				content: quest.steps[d]?.content ?? "",
				result: quest.steps[d]?.result ?? null,
			}));
			const prompt = buildSubAgentPrompt({
				role,
				content: task.content,
				context: task.context,
				persona: resolvePersona(quest.team, role),
				dependencyResults,
				formatDirective: FORMAT_DIRECTIVE,
				sandboxProfile,
			});

			const res = await runSubAgent(
				ctx,
				{ role, model, prompt, tools: sandboxTools, sandboxProfile },
				signal,
			);

			if (!res.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Sub-agent for step #${params.index + 1} failed: ${res.error ?? "unknown error"}`,
						},
					],
					details: { index: params.index, role, model: model.id, ok: false, error: res.error },
				};
			}
			return {
				content: [
					{
						type: "text",
						text: [
							`Sub-agent (\`${role}\` · ${model.id}) finished step #${params.index + 1}: **${task.content}**`,
							``,
							res.output || "(no output)",
							``,
							`Record the outcome with quest_update(index=${params.index}, status="done", result="…").`,
						].join("\n"),
					},
				],
				details: { index: params.index, role, model: model.id, ok: true, output: res.output },
			};
		},
	});

	pi.registerTool({
		name: "quest_abort",
		label: "Quest Abort",
		description:
			"Permanently archive the current quest and clear it. Only works when quest is not actively running (paused, planning, or done).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest to abort." }],
					details: {},
				};
			}
			if (quest.status === "active") {
				return {
					content: [
						{
							type: "text",
							text: "Cannot abort an active quest. Pause it first with /quest pause.",
						},
					],
					details: {},
				};
			}
			const name = quest.name;
			const done = quest.steps.filter((t) => t.status === "done").length;
			const total = quest.steps.length;
			if (quest.status !== "done") {
				quest.status = "done";
				quest.completedAt = Date.now();
				archiveQuest(quest, ctx.cwd);
			}
			rt.setQuest(null);
			renderStatus(ctx, null);
			writeQuestSessionMeta(ctx.cwd, null);
			clearQuestFromTodo(ctx.cwd); // flush stale [Quest] items from pi-todo
			return {
				content: [
					{
						type: "text",
						text: `Quest "${name}" aborted and archived (${done}/${total} steps done).`,
					},
				],
				details: { name, done, total },
			};
		},
	});

	// quest_task_detail — legacy name, kept for backward compatibility
	const detailParams = Type.Object({
		index: Type.Number({ description: "Step index (0-based)" }),
	});
	const detailExecute = async (
		_id: string,
		params: { index: number },
		_signal: unknown,
		_onUpdate: unknown,
		ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	) => {
		const quest = getQuest(ctx.cwd);
		if (!quest) {
			return {
				content: [{ type: "text" as const, text: "No active quest." }],
				details: {},
			};
		}
		if (params.index < 0 || params.index >= quest.steps.length) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Invalid step index ${params.index}. Valid: 0-${quest.steps.length - 1}.`,
					},
				],
				details: {},
			};
		}
		const t = quest.steps[params.index];
		const deps = t.dependencies.length
			? t.dependencies.map((d) => `#${d + 1} ${quest.steps[d].content}`).join(", ")
			: "none";
		const time = t.startedAt
			? `${Math.round(((t.completedAt ?? Date.now()) - t.startedAt) / 1000)}s`
			: "not started";
		const lines = [
			`## Step #${params.index + 1}: ${t.content}`,
			``,
			`**Status:** ${t.status}  |  **Agent:** ${t.agent}  |  **Attempts:** ${t.attempts}`,
			`**Dependencies:** ${deps}`,
			`**Timing:** ${time}${t.completedAt ? ` (completed)` : ""}`,
			``,
			`**Context:**`,
			t.context,
		];
		if (t.result) {
			lines.push(``, `**Result:**`, t.result);
		}
		if (t.verified) {
			lines.push(``, `**Verification:** ✅ ${t.verifyResult || "passed"}`);
		} else if (t.status === "verifying") {
			lines.push(``, `**Verification:** 🔍 in progress (retries: ${t.verifyRetries})`);
		}
		if (t.commitHash) {
			lines.push(
				``,
				`**Commit:** \`${t.commitHash.slice(0, 8)}\`${t.branchName ? ` on ${t.branchName}` : ""}`,
			);
		}
		if (quest.sandbox || t.sandbox) {
			const mode = t.sandbox?.mode || quest.sandbox?.mode;
			const sandboxLines: string[] = [];
			if (mode) {
				sandboxLines.push(`**Sandbox:** ${mode} 🔒`);
			}
			if (t.sandbox?.mode) {
				sandboxLines.push(`  Step override: +${t.sandbox.mode}`);
			}
			if (quest.sandbox?.worktree?.path) {
				sandboxLines.push(`  Worktree: ${quest.sandbox.worktree.path}`);
			}
			if (quest.sandbox?.allowedPaths?.length) {
				sandboxLines.push(`  Allowed paths: ${quest.sandbox.allowedPaths.join(", ")}`);
			}
			if (sandboxLines.length > 0) {
				lines.push(``, ...sandboxLines);
			}
		}
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: { step: t, task: t, index: params.index },
		};
	};

	pi.registerTool({
		name: "quest_task_detail",
		label: "Quest Step Detail",
		description:
			"Get full details for a specific step including context, result, attempts, timing, and verification status.",
		parameters: detailParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return detailExecute(_id, params, _signal, _onUpdate, ctx);
		},
	});

	// quest_step_detail — canonical name
	pi.registerTool({
		name: "quest_step_detail",
		label: "Quest Step Detail",
		description:
			"Get full details for a specific step including context, result, attempts, timing, and verification status.",
		parameters: detailParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return detailExecute(_id, params, _signal, _onUpdate, ctx);
		},
	});

	// ── Auto-pilot ────────────────────────────────────────────────────────────
}
