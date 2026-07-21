import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ParallelConfig, SandboxPolicy } from "./types";
import { emptyQuest } from "./storage";
import { compactAwarenessBlock } from "./todo-sync";
import { codebaseStatusSummary, hasCodebaseCache, loadCodebaseIndex } from "./codebase";
import type { QuestRuntime } from "./runtime";

export function registerCreateTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, validateAndSetTeam, ensureLedgers, codebaseToolAvailable } = rt;

	pi.registerTool({
		name: "quest_create",
		label: "Quest Create",
		description: [
			"Create a new quest from a goal. This starts the planning phase.",
			"Quest will then auto-pilot through steps using sub-agents until complete.",
			"Call this when the user gives a project goal or multi-step task.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({
				description: "Short name for the quest (e.g. 'Add user auth')",
			}),
			goal: Type.String({
				description: "Full goal description — what needs to be accomplished",
			}),
			team: Type.Optional(
				Type.String({
					description: "Team configuration name (e.g. 'engineering', 'research')",
				}),
			),
			planningMode: Type.Optional(
				StringEnum(["auto", "approve"] as const, {
					description:
						"'auto' skips approval and starts immediately after planning. 'approve' waits for quest_approve before executing steps.",
				}),
			),
			verifyOnComplete: Type.Optional(
				Type.Boolean({
					description: "Auto-verify completed steps with a verifier sub-agent (default: true)",
					default: true,
				}),
			),
			parallel: Type.Optional(
				Type.Object({
					enabled: Type.Boolean({
						description: "Explicitly enable isolated parallel execution (default: false)",
					}),
					maxConcurrent: Type.Optional(
						Type.Number({ description: "Maximum concurrent steps (1-8, default: 3)" }),
					),
					stepTimeoutMs: Type.Optional(
						Type.Number({ description: "Per-step timeout in milliseconds (default: 600000)" }),
					),
				}),
			),
			gitIntegration: Type.Optional(
				Type.Object({
					autoCommit: Type.Optional(
						Type.Boolean({
							description: "Auto-commit on step completion (default: true)",
							default: true,
						}),
					),
					autoBranch: Type.Optional(
						Type.Boolean({
							description: "Auto-create branches per step (default: true)",
							default: true,
						}),
					),
					autoPR: Type.Optional(
						Type.Boolean({
							description: "Open PR on quest completion (default: false)",
							default: false,
						}),
					),
					branchPrefix: Type.Optional(
						Type.String({
							description: "Branch name prefix (default: 'quest/')",
							default: "quest/",
						}),
					),
				}),
			),
			sandbox: Type.Optional(
				Type.Object({
					mode: StringEnum(["restricted", "isolated"] as const, {
						description:
							"Sandbox mode — current MVP uses prompt/tool-scope constraints; 'isolated' also records worktree metadata.",
					}),
					allowedPaths: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Allowed path globs (relative to cwd) for prompt/verifier policy. Empty = deny all in restricted/isolated mode.",
						}),
					),
					deniedPaths: Type.Optional(
						Type.Array(Type.String(), {
							description: "Denied path globs. Overrides allowed.",
						}),
					),
					allowCommands: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Allowed command prefixes/patterns for prompt/tool-scope policy. Empty removes bash in restricted/isolated mode.",
						}),
					),
					denyCommands: Type.Optional(
						Type.Array(Type.String(), {
							description: "Denied command patterns. Overrides allowed.",
						}),
					),
					allowNetwork: Type.Optional(
						Type.Boolean({
							description: "Whether network access is permitted (default: false when sandboxed)",
							default: false,
						}),
					),
					allowPackageInstall: Type.Optional(
						Type.Boolean({
							description: "Whether package install is permitted (default: false when sandboxed)",
							default: false,
						}),
					),
					worktree: Type.Optional(
						Type.Object({
							baseBranch: Type.String({
								description: "Branch to base the worktree on (e.g. 'main', 'master')",
							}),
							path: Type.String({
								description:
									"Worktree path relative to project root (e.g. '.pi/worktrees/<quest-name>')",
							}),
							autoCleanup: Type.Optional(
								Type.Boolean({
									description:
										"Whether to prune the worktree after quest completion (default: true)",
									default: true,
								}),
							),
						}),
					),
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (getQuest(ctx.cwd)?.status === "active") {
				return {
					content: [
						{
							type: "text",
							text: "A quest is already active. Pause or complete it first with /quest pause.",
						},
					],
					details: {},
				};
			}

			const existing = getQuest(ctx.cwd);
			const overwriteWarning =
				existing && existing.status !== "active"
					? `\n⚠ Replacing existing quest "${existing.name}" (status: ${existing.status}). Previous quest will be archived on completion.`
					: "";

			// Parallel multi-task minion batches do not apply Quest sandbox-guard.
			// When both parallel.enabled and restricted/isolated sandbox are set,
			// force sequential (disable parallel) and surface a clear note (#21).
			const sandboxPolicy = params.sandbox as SandboxPolicy | undefined;
			let parallelConfig = params.parallel as ParallelConfig | undefined;
			let parallelSandboxNote = "";
			if (
				parallelConfig?.enabled &&
				sandboxPolicy?.mode &&
				(sandboxPolicy.mode === "restricted" || sandboxPolicy.mode === "isolated")
			) {
				parallelConfig = undefined;
				parallelSandboxNote =
					`\n⚠ **Parallel disabled** — sandbox mode \`${sandboxPolicy.mode}\` requires sequential ` +
					`\`quest_delegate\` (multi-task minion batches do not enforce Quest sandbox-guard).`;
			}

			const quest = emptyQuest(
				params.name,
				params.goal,
				undefined,
				params.planningMode ?? "auto",
				params.verifyOnComplete ?? true,
				params.gitIntegration,
				sandboxPolicy,
				parallelConfig,
			);
			validateAndSetTeam(quest, params.team);
			ensureLedgers(ctx.cwd, quest.name);
			persist(ctx, quest);

			const modeNote =
				params.planningMode === "approve"
					? `\n⚠ **Approval mode** — after the plan is created, it must be approved with **quest_approve** before execution begins.`
					: "";
			const awareness = compactAwarenessBlock(ctx.cwd, ctx.model);
			const codebaseAvailable = codebaseToolAvailable();
			const codebaseCache = loadCodebaseIndex(ctx.cwd);
			const codebaseGuidance = [
				`Codebase intelligence: ${codebaseStatusSummary(codebaseCache)}`,
				codebaseAvailable
					? `Before planning large code steps, call codebase(operation="scan"), then codebase(operation="query", pattern=...) and codebase(operation="map", file=...) to discover relevant files and dependency context.`
					: hasCodebaseCache(ctx.cwd)
						? `The codebase tool is unavailable; use direct fallback from .pi/codebase-index.json for planning context.`
						: `The codebase tool is unavailable and no cache exists; proceed with normal scout/read exploration.`,
			].join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`Quest created: **${params.name}**${overwriteWarning}`,
							``,
							`Next: Plan the quest. Use subagent(agent="scout") to explore the codebase,`,
							`then subagent(agent="planner") to create a step breakdown. Save the plan`,
							`with **quest_plan** — pass the steps array and set autoStart: true.`,
							``,
							`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
							awareness,
							codebaseGuidance,
							modeNote,
							parallelSandboxNote,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { quest },
			};
		},
	});

	pi.registerTool({
		name: "quest_decide",
		label: "Quest Decide",
		description: [
			"Ask the user a question during quest planning or execution.",
			"Call this whenever the quest plan has a branch, ambiguity, or decision point",
			"that needs human judgment — e.g. picking between approaches, confirming tradeoffs,",
			"or resolving unknowns the agent can't determine alone.",
			"Presents the options to the user via an interactive select dialog and returns their choice.",
		].join(" "),
		parameters: Type.Object({
			question: Type.String({
				description: "The decision to present to the user. Be clear about the tradeoffs.",
			}),
			options: Type.Array(Type.String(), {
				description: "List of options the user can choose from (max 10).",
			}),
			context: Type.Optional(
				Type.String({
					description: "Background context to help the user make an informed decision.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `Decision needed: "${params.question}" — options: ${params.options.join(", ")}. Running headlessly — defaulting to first option: "${params.options[0]}".`,
						},
					],
					details: { choice: params.options[0], index: 0, headless: true },
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "No options provided." }],
					details: {},
				};
			}

			if (params.options.length > 10) {
				return {
					content: [
						{
							type: "text",
							text: "Too many options (max 10). Narrow them down.",
						},
					],
					details: {},
				};
			}

			const message = [
				params.context ? `${params.context}\n` : "",
				`**Question:** ${params.question}`,
				``,
				`Pick an option:`,
			]
				.filter(Boolean)
				.join("\n");

			const choice = await ctx.ui.select(message, params.options);
			if (choice === undefined) {
				return {
					content: [{ type: "text", text: "User dismissed the selection without choosing." }],
					details: { question: params.question, choice: null, index: -1, options: params.options },
				};
			}
			const idx = params.options.indexOf(choice);

			return {
				content: [
					{
						type: "text",
						text: [
							`**User decided:** ${choice}`,
							``,
							`Question: ${params.question}`,
							`Chosen: **${choice}** (option ${idx + 1}/${params.options.length})`,
						].join("\n"),
					},
				],
				details: {
					question: params.question,
					choice,
					index: idx,
					options: params.options,
				},
			};
		},
	});
}
