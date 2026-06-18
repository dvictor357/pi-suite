/**
 * quest/index.ts — proactive AI project manager for pi
 *
 * Entry point for the quest extension. Imports all modules and registers
 * tools, commands, and event handlers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Quest, TaskStatus } from "./types";
import {
	MAX_BURST,
	MAX_RETRIES,
	MAX_VERIFY_RETRIES,
	MAX_DEPENDENCY_DEPTH,
	TEAMS_DIR,
	FORMAT_DIRECTIVE,
} from "./constants";
import { updateJSON, projectMemoryPath, CONTRACT_VERSION, isFutureContract } from "./utils";
import {
	emptyQuest,
	loadQuest,
	saveQuest,
	archiveQuest,
	syncConventionsToMemory,
	listArchives,
} from "./storage";
import { loadTeams, ensureBuiltInTeams, teamInstallFromGit } from "./teams";
import { syncQuestToTodo, clearQuestFromTodo, compactAwarenessBlock } from "./todo-sync";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { nextPendingTask, formatQuestStatus, buildSteeringMessage } from "./steering";
import { QuestKanban } from "./kanban";
import { detectDependencyCycle, getMaxDependencyDepth } from "./graph";

export default function (pi: ExtensionAPI) {
	let questCache: Quest | null = null;
	let autoPilotLocked = false;

	function getQuest(cwd?: string): Quest | null {
		if (!questCache && cwd) questCache = loadQuest(cwd);
		return questCache;
	}

	/**
	 * The canonical save path — used wherever quest state changes. Persists the
	 * quest, caches it in memory, refreshes the status badge, writes session-meta,
	 * and syncs the tasks into pi-todo. (Some callers deliberately do a subset,
	 * e.g. research saves that don't touch tasks skip the pi-todo sync.)
	 */
	function persist(ctx: ExtensionContext, quest: Quest): void {
		saveQuest(quest, ctx.cwd);
		questCache = quest;
		renderStatus(ctx, quest);
		writeQuestSessionMeta(ctx.cwd, quest);
		syncQuestToTodo(quest, ctx.cwd);
	}

	function validateAndSetTeam(quest: Quest, teamName?: string): void {
		if (!teamName) return;
		ensureBuiltInTeams();
		const config = loadTeams()[teamName];
		if (config) {
			quest.team = teamName;
		}
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "quest_create",
		label: "Quest Create",
		description: [
			"Create a new quest from a goal. This starts the planning phase.",
			"Quest will then auto-pilot through tasks using sub-agents until complete.",
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
						"'auto' skips approval and starts immediately after planning. 'approve' waits for quest_approve before executing tasks.",
				}),
			),
			verifyOnComplete: Type.Optional(
				Type.Boolean({
					description: "Auto-verify completed tasks with a verifier sub-agent (default: true)",
					default: true,
				}),
			),
			gitIntegration: Type.Optional(
				Type.Object({
					autoCommit: Type.Optional(
						Type.Boolean({
							description: "Auto-commit on task completion (default: true)",
							default: true,
						}),
					),
					autoBranch: Type.Optional(
						Type.Boolean({
							description: "Auto-create branches per task (default: true)",
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

			const quest = emptyQuest(
				params.name,
				params.goal,
				undefined,
				params.planningMode ?? "auto",
				params.verifyOnComplete ?? true,
				params.gitIntegration,
			);
			validateAndSetTeam(quest, params.team);
			persist(ctx, quest);

			const modeNote =
				params.planningMode === "approve"
					? `\n⚠ **Approval mode** — after the plan is created, it must be approved with **quest_approve** before execution begins.`
					: "";
			const awareness = compactAwarenessBlock(ctx.cwd);
			return {
				content: [
					{
						type: "text",
						text: [
							`Quest created: **${params.name}**${overwriteWarning}`,
							``,
							`Next: Plan the quest. Use subagent(agent="scout") to explore the codebase,`,
							`then subagent(agent="planner") to create a task breakdown. Save the plan`,
							`with **quest_plan** — pass the tasks array and set autoStart: true.`,
							``,
							`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
							awareness,
							modeNote,
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

	pi.registerTool({
		name: "quest_plan",
		label: "Quest Plan",
		description: [
			"Save a task breakdown for the current quest. Replaces all existing tasks.",
			"Each task needs: content, agent (sub-agent type), context (focused instructions).",
			"Optionally: dependencies (array of task indices that must complete first).",
			"Set autoStart: true to immediately begin auto-pilot execution.",
			"When planningMode='approve' and running interactively, shows the plan to the user for approval.",
		].join(" "),
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					content: Type.String({ description: "Short name of the task" }),
					agent: Type.String({
						description: "Sub-agent type: worker, quick-worker, scout, planner, reviewer, verifier",
					}),
					context: Type.String({
						description: "Focused context/instructions for the sub-agent — keep it lean",
					}),
					dependencies: Type.Optional(
						Type.Array(Type.Number(), {
							description: "Indices of tasks that must complete first (0-based)",
						}),
					),
				}),
				{ description: "Array of tasks in execution order" },
			),
			autoStart: Type.Optional(
				Type.Boolean({
					description: "Start auto-pilot immediately after saving (default: true)",
					default: true,
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

			if (params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No tasks provided." }],
					details: {},
				};
			}

			if (params.tasks.length > 50) {
				return {
					content: [
						{
							type: "text",
							text: "Too many tasks (max 50). Break into smaller quests.",
						},
					],
					details: {},
				};
			}

			quest.tasks = params.tasks.map((t) => ({
				content: t.content,
				status: "pending" as TaskStatus,
				agent: t.agent,
				context: t.context,
				dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
				result: null,
				attempts: 0,
				startedAt: null,
				completedAt: null,
				verified: false,
				verifyResult: null,
				verifyRetries: 0,
				commitHash: null,
				branchName: null,
			}));

			for (let i = 0; i < quest.tasks.length; i++) {
				for (const dep of quest.tasks[i].dependencies) {
					if (dep < 0 || dep >= quest.tasks.length || dep === i) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid dependency in task #${i + 1}: task #${dep + 1} is out of range or self-referencing.`,
								},
							],
							details: {},
						};
					}
				}
			}

			// Detect dependency cycles
			const cyclePath = detectDependencyCycle(quest.tasks);
			if (cyclePath) {
				return {
					content: [
						{
							type: "text",
							text: `Dependency cycle detected: ${cyclePath.map((i) => `#${i + 1}`).join(" → ")}. Break the cycle to proceed.`,
						},
					],
					details: {},
				};
			}

			// Enforce max dependency depth
			const depth = getMaxDependencyDepth(quest.tasks);
			if (depth > MAX_DEPENDENCY_DEPTH) {
				return {
					content: [
						{
							type: "text",
							text: `Dependency depth ${depth} exceeds maximum ${MAX_DEPENDENCY_DEPTH}. Simplify the dependency chain.`,
						},
					],
					details: {},
				};
			}

			const needsApproval = quest.planningMode === "approve" && !quest.planApproved;

			const fullPlan = quest.tasks
				.map((t, i) => {
					const deps = t.dependencies.length
						? ` (requires: ${t.dependencies.map((d) => quest.tasks[d].content).join(", ")})`
						: "";
					return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
				})
				.join("\n\n");

			if (needsApproval && ctx.hasUI) {
				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					`**${quest.tasks.length} tasks planned:**`,
					``,
					fullPlan,
					``,
					`---`,
					`Approve this plan to start executing tasks automatically?`,
				].join("\n");

				const approved = await ctx.ui.confirm("Review Quest Plan", confirmMsg);

				if (approved) {
					quest.planApproved = true;
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;

					persist(ctx, quest);

					ctx.ui.notify(
						`✅ Plan approved. Quest "${quest.name}" is now ACTIVE — ${quest.tasks.length} tasks.`,
						"info",
					);

					const next = nextPendingTask(quest);
					return {
						content: [
							{
								type: "text",
								text: [
									`✅ Plan approved by user: **${quest.name}**`,
									``,
									`${quest.tasks.length} tasks queued. Quest is now **ACTIVE**.`,
									next
										? `First task: ${next.task.content} [${next.task.agent}]`
										: "All tasks ready.",
									``,
									"Auto-pilot will fire the first task on the next turn.",
								].join("\n"),
							},
						],
						details: {
							approved: true,
							tasks: quest.tasks.length,
							nextTask: next?.task.content ?? null,
						},
					};
				}

				const action = await ctx.ui.select("Plan not approved. What would you like to do?", [
					"Edit tasks before approving",
					"Re-plan from scratch",
					"Cancel (keep plan for later)",
				]);

				if (action === "Edit tasks before approving") {
					quest.status = "planning";
					quest.pauseReason =
						"Plan review: user wants edits. Use quest_approve(edits=[...]) to modify tasks and approve.";
					persist(ctx, quest);

					return {
						content: [
							{
								type: "text",
								text: [
									`📝 Plan saved but needs edits before approval.`,
									``,
									`Use **quest_approve(edits=[...])** to modify specific tasks, then approve.`,
									`Or re-plan with quest_plan(tasks=[...]).`,
									``,
									`Tasks that can be edited:`,
									quest.tasks.map((t, i) => `  #${i + 1}: ${t.content}`).join("\n"),
								].join("\n"),
							},
						],
						details: {
							status: "planning",
							userAction: "edit",
							tasks: quest.tasks.length,
						},
					};
				}

				if (action === "Re-plan from scratch") {
					quest.tasks = [];
					quest.status = "planning";
					quest.pauseReason = "User requested re-plan.";
					persist(ctx, quest);

					return {
						content: [
							{
								type: "text",
								text: [
									`🔄 Plan cleared. Call **quest_plan** with a new task breakdown.`,
									``,
									`Original goal: ${quest.goal}`,
								].join("\n"),
							},
						],
						details: { status: "planning", userAction: "replan" },
					};
				}

				// Cancel — keep plan for later
				quest.status = "planning";
				quest.pauseReason =
					"Plan saved, awaiting user approval. Use /quest approve or quest_approve to start.";
				persist(ctx, quest);

				return {
					content: [
						{
							type: "text",
							text: [
								`💾 Plan saved (${quest.tasks.length} tasks) — kept for later.`,
								``,
								`Approve when ready: **quest_approve()** or **/quest approve**`,
							].join("\n"),
						},
					],
					details: { status: "planning", userAction: "defer" },
				};
			}

			if (params.autoStart !== false) {
				if (needsApproval) {
					quest.status = "planning";
					quest.pauseReason =
						"Plan ready — awaiting approval. Use quest_approve or /quest approve to start.";
				} else {
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					quest.planApproved = true;
				}
			} else {
				quest.status = "planning";
			}

			persist(ctx, quest);

			const approvalMsg = needsApproval
				? [
						``,
						`---`,
						``,
						`## Plan Review`,
						``,
						fullPlan,
						``,
						`---`,
						``,
						`⚠ **Plan needs your approval.** Review the tasks above.`,
						`- Approve: call **quest_approve()** or type /quest approve`,
						`- Edit tasks: call **quest_approve(edits=[...])** with task modifications`,
						`- Reject: call quest_plan with a new set of tasks`,
					].join("\n")
				: "";

			return {
				content: [
					{
						type: "text",
						text: [
							`Plan saved: **${quest.tasks.length} tasks**`,
							``,
							`  ${quest.tasks
								.slice(0, 5)
								.map(
									(t, i) =>
										`${i + 1}. ${t.content} [${t.agent}]${t.dependencies.length ? ` ← #${t.dependencies.map((d) => d + 1).join(", #")}` : ""}`,
								)
								.join("\n  ")}`,
							quest.tasks.length > 5 ? `  … and ${quest.tasks.length - 5} more` : "",
							``,
							quest.status === "active"
								? `**Quest is now ACTIVE.** Auto-pilot will fire the first task on the next turn.`
								: needsApproval
									? `Awaiting approval. Review the plan above and call quest_approve to start.`
									: `Quest in planning mode. Call quest_start or /quest start to begin.`,
							approvalMsg,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { tasks: quest.tasks, status: quest.status, needsApproval },
			};
		},
	});

	pi.registerTool({
		name: "quest_update",
		label: "Quest Update",
		description: [
			"Update a task's status in the current quest.",
			"Call this after a sub-agent completes its work on a task.",
			"Pass the task index (0-based) and new status.",
			"Set result to a brief summary of what was done.",
			"To report verification results: pass verifyOutcome='PASS'|'FAIL' and verifyEvidence.",
		].join(" "),
		parameters: Type.Object({
			index: Type.Number({ description: "Task index (0-based)" }),
			status: StringEnum(["done", "failed", "skipped"] as const, {
				description: "New status for the task",
			}),
			result: Type.Optional(Type.String({ description: "Brief summary of what happened" })),
			verifyOutcome: Type.Optional(
				StringEnum(["PASS", "FAIL"] as const, {
					description: "Verification outcome. Use on a 'verifying' task to report PASS or FAIL.",
				}),
			),
			verifyEvidence: Type.Optional(
				Type.String({
					description: "Evidence/details from the verifier for PASS or FAIL",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest." }],
					details: {},
				};
			}

			if (params.index < 0 || params.index >= quest.tasks.length) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid task index ${params.index}. Valid: 0-${quest.tasks.length - 1}.`,
						},
					],
					details: {},
				};
			}

			const task = quest.tasks[params.index];

			// ── Verification outcome ──────────────────────────────────────────
			if (params.verifyOutcome) {
				if (task.status !== "verifying") {
					return {
						content: [
							{
								type: "text",
								text: `Task #${params.index + 1} is not in verifying state. Current: ${task.status}.`,
							},
						],
						details: {},
					};
				}

				task.verifyResult = `[${params.verifyOutcome}] ${params.verifyEvidence || ""}`.trim();
				task.verified = true;

				if (params.verifyOutcome === "PASS") {
					task.status = "done";
					task.completedAt = Date.now();

					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					const done = quest.tasks.filter((t) => t.status === "done").length;
					const next = nextPendingTask(quest);
					const git = quest.gitIntegration;
					const gitPrompt = git?.autoCommit
						? [
								``,
								`📝 **Git:** After committing, record with quest_commit(taskIndex=${params.index}, commitHash="...", commitMessage="[quest/${quest.name}] task #${params.index + 1}: ${task.content}", ...)`,
							].join("\n")
						: "";
					return {
						content: [
							{
								type: "text",
								text: [
									`✅ Task #${params.index + 1} **VERIFIED PASS**: ${task.content}`,
									params.verifyEvidence ? `  Evidence: ${params.verifyEvidence}` : "",
									``,
									`Task marked done. Progress: ${done}/${quest.tasks.length} done`,
									next
										? `Next: ${next.task.content} [${next.task.agent}]`
										: "All tasks done or blocked!",
									gitPrompt,
								]
									.filter(Boolean)
									.join("\n"),
							},
						],
						details: {
							task,
							verified: true,
							outcome: "PASS",
							progress: `${done}/${quest.tasks.length}`,
						},
					};
				}

				// FAIL
				task.verifyRetries++;
				const retriesLeft = MAX_VERIFY_RETRIES - task.verifyRetries;

				if (retriesLeft > 0) {
					task.status = "pending";
					task.attempts = 0;
					task.startedAt = null;
					task.result = `Verification FAIL #${task.verifyRetries}: ${params.verifyEvidence || "no details"}. Fix and retry (${retriesLeft} retries left).`;
					task.context = `${task.context}\n\n[Verification FAIL #${task.verifyRetries}]: ${params.verifyEvidence || "see above"}. Fix the issues and try again.`;
					task.completedAt = null;

					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					return {
						content: [
							{
								type: "text",
								text: [
									`❌ Task #${params.index + 1} **VERIFICATION FAIL**: ${task.content}`,
									params.verifyEvidence ? `  Evidence: ${params.verifyEvidence}` : "",
									``,
									`Retry ${task.verifyRetries}/${MAX_VERIFY_RETRIES}. Task reset to pending with fix context.`,
									`${retriesLeft} verification retries remaining before auto-fail.`,
								].join("\n"),
							},
						],
						details: { task, verified: false, outcome: "FAIL", retriesLeft },
					};
				}

				// No retries left: auto-fail
				task.status = "failed";
				task.completedAt = Date.now();
				task.result = `Verification FAIL after ${MAX_VERIFY_RETRIES} retries: ${params.verifyEvidence || "no details"}`;

				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				persist(ctx, quest);

				return {
					content: [
						{
							type: "text",
							text: [
								`❌ Task #${params.index + 1} **AUTO-FAILED** (${MAX_VERIFY_RETRIES} verification retries exhausted): ${task.content}`,
								params.verifyEvidence ? `  Last evidence: ${params.verifyEvidence}` : "",
							].join("\n"),
						},
					],
					details: { task, verified: false, outcome: "FAIL", exhausted: true },
				};
			}

			// ── Normal completion — check if verification needed ─────────────
			if (params.status === "done" && quest.verifyOnComplete) {
				const team = quest.team ? loadTeams()[quest.team] : null;
				const hasVerifier = team?.verification ?? true;

				if (hasVerifier) {
					task.status = "verifying";
					if (params.result) task.result = params.result;
					task.verifyRetries = 0;
					task.verified = false;
					task.verifyResult = null;

					persist(ctx, quest);

					const verifierAgent =
						team?.members.find((m) => m.agent === "verifier" || m.role === "tester")?.agent ??
						"verifier";
					return {
						content: [
							{
								type: "text",
								text: [
									`🔍 Task #${params.index + 1} **entered verification**: ${task.content}`,
									``,
									`**Task result to verify:**`,
									`> ${params.result || task.result || "(no result provided)"}`,
									``,
									`**Verification step:** Spawn a \`subagent(agent="${verifierAgent}")\` to verify this task.`,
									`The verifier should check:`,
									`1. Does the result match the task requirements?`,
									`2. Is the implementation correct and complete?`,
									`3. Are there any issues or missing pieces?`,
									`4. Is the code formatted and lint-clean per the project's own conventions? ${FORMAT_DIRECTIVE} If the project's formatter/linter was not run or leaves the tree dirty/inconsistent, this is a FAIL.`,
									``,
									`**After verification, call quest_update with:**`,
									`- **verifyOutcome="PASS"** and verifyEvidence if the result is correct`,
									`- **verifyOutcome="FAIL"** and verifyEvidence explaining what needs fixing`,
									``,
									`Task context: ${task.context}`,
									`${MAX_VERIFY_RETRIES} verification retries available before auto-fail.`,
								].join("\n"),
							},
						],
						details: { task, verifying: true, verifierAgent },
					};
				}
			}

			task.status = params.status;
			if (params.result) task.result = params.result;
			if (params.status === "done" || params.status === "failed") {
				task.completedAt = Date.now();
			}

			const git = quest.gitIntegration;
			const gitPrompt =
				params.status === "done" && git?.autoCommit
					? [
							``,
							`---`,
							``,
							`## Git Integration`,
							``,
							git.autoBranch
								? `**Recommended branch:** \`${git.branchPrefix || "quest/"}task-${params.index + 1}-${quest.tasks[
										params.index
									].content
										.replace(/[^a-z0-9]+/gi, "-")
										.toLowerCase()
										.slice(0, 40)}\``
								: "",
							`**Commit message prefix:** \`[quest/${quest.name}] task #${params.index + 1}: ${quest.tasks[params.index].content}\``,
							``,
							`After committing, record the commit with **quest_commit**:`,
							`\`quest_commit(taskIndex=${params.index}, commitHash="...", commitMessage="...", branchName="...")\``,
							`Or call quest_git_summary() to review all quest commits.`,
						]
							.filter(Boolean)
							.join("\n")
					: "";

			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;

			persist(ctx, quest);

			const done = quest.tasks.filter((t) => t.status === "done").length;
			const total = quest.tasks.length;
			const next = nextPendingTask(quest);

			return {
				content: [
					{
						type: "text",
						text: [
							`Task #${params.index + 1} → **${params.status.toUpperCase()}**: ${task.content}`,
							params.result ? `  Result: ${params.result}` : "",
							``,
							`Progress: ${done}/${total} done`,
							next
								? `Next: ${next.task.content} [${next.task.agent}]`
								: "All tasks done or blocked!",
							``,
							quest.status === "active"
								? "Auto-pilot will fire the next task."
								: "Quest is paused. /quest resume to continue.",
							gitPrompt,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					task,
					progress: `${done}/${total}`,
					nextTask: next?.task.content ?? null,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_approve",
		label: "Quest Approve",
		description: [
			"Approve the current quest plan and start execution.",
			"Only needed when planningMode is 'approve'.",
			"When running interactively, shows a confirmation dialog with the full plan before approving.",
			"Optionally pass edits to modify tasks before starting.",
		].join(" "),
		parameters: Type.Object({
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						index: Type.Number({ description: "Task index to edit (0-based)" }),
						content: Type.Optional(Type.String({ description: "New task content" })),
						agent: Type.Optional(Type.String({ description: "New sub-agent type" })),
						context: Type.Optional(Type.String({ description: "New context/instructions" })),
						dependencies: Type.Optional(
							Type.Array(Type.Number(), {
								description: "New dependency indices",
							}),
						),
					}),
					{ description: "Optional task edits to apply before starting" },
				),
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

			if (quest.planApproved) {
				return {
					content: [
						{
							type: "text",
							text: "Plan already approved. Quest is in progress or completed.",
						},
					],
					details: {},
				};
			}

			if (quest.tasks.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No tasks to approve. Use quest_plan to create a task breakdown first.",
						},
					],
					details: {},
				};
			}

			let editsApplied = 0;
			if (params.edits) {
				for (const edit of params.edits) {
					if (edit.index < 0 || edit.index >= quest.tasks.length) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid edit index ${edit.index}. Valid: 0-${quest.tasks.length - 1}.`,
								},
							],
							details: {},
						};
					}
					const task = quest.tasks[edit.index];
					if (edit.content !== undefined) task.content = edit.content;
					if (edit.agent !== undefined) task.agent = edit.agent;
					if (edit.context !== undefined) task.context = edit.context;
					if (edit.dependencies !== undefined) task.dependencies = edit.dependencies;
					editsApplied++;
				}
				// Re-validate all dependencies after edits
				for (let i = 0; i < quest.tasks.length; i++) {
					for (const dep of quest.tasks[i].dependencies) {
						if (dep < 0 || dep >= quest.tasks.length || dep === i) {
							return {
								content: [
									{
										type: "text",
										text: `Invalid dependency after edit in task #${i + 1}: task #${dep + 1} is out of range or self-referencing.`,
									},
								],
								details: {},
							};
						}
					}
				}
			}

			if (ctx.hasUI) {
				const planSummary = quest.tasks
					.map((t, i) => {
						const deps = t.dependencies.length
							? ` (requires: ${t.dependencies.map((d) => quest.tasks[d].content).join(", ")})`
							: "";
						return `${i + 1}. **${t.content}** [${t.agent}]${deps}`;
					})
					.join("\n");

				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					`**${quest.tasks.length} tasks:**`,
					planSummary,
					``,
					`---`,
					editsApplied > 0 ? `${editsApplied} task(s) edited. ` : "",
					`Start executing tasks now?`,
				].join("\n");

				const approved = await ctx.ui.confirm("Approve Quest Plan", confirmMsg);
				if (!approved) {
					persist(ctx, quest);

					return {
						content: [
							{
								type: "text",
								text: [
									editsApplied > 0
										? `📝 ${editsApplied} task edit(s) saved. Plan not approved — kept in planning.`
										: `Plan not approved. Kept in planning.`,
									``,
									`Approve when ready with **quest_approve()** or **/quest approve**.`,
								].join("\n"),
							},
						],
						details: { approved: false, editsApplied },
					};
				}
			}

			quest.planApproved = true;
			quest.status = "active";
			quest.tasksSincePause = 0;
			quest.lastFiredTaskIndex = -1;
			quest.sameTaskCount = 0;
			quest.pauseReason = null;

			persist(ctx, quest);

			const next = nextPendingTask(quest);
			return {
				content: [
					{
						type: "text",
						text: [
							`✅ Plan approved: **${quest.name}**`,
							``,
							`${quest.tasks.length} tasks queued. Quest is now **ACTIVE**.`,
							next ? `First task: ${next.task.content} [${next.task.agent}]` : "All tasks ready.",
							``,
							"Auto-pilot will fire the first task on the next turn.",
						].join("\n"),
					},
				],
				details: {
					approved: true,
					tasks: quest.tasks.length,
					nextTask: next?.task.content ?? null,
				},
			};
		},
	});

	pi.registerTool({
		name: "quest_status",
		label: "Quest Status",
		description: "Show the current quest, its tasks, and progress.",
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
			return {
				content: [{ type: "text", text: formatQuestStatus(quest) }],
				details: { quest },
			};
		},
	});

	pi.registerTool({
		name: "quest_commit",
		label: "Quest Commit",
		description: [
			"Record a git commit as a deliverable for a completed quest task.",
			"Use this after committing code changes for a specific task.",
			"Each commit is tracked and included in the quest's git summary.",
		].join(" "),
		parameters: Type.Object({
			taskIndex: Type.Number({
				description: "Task index (0-based) that this commit belongs to",
			}),
			commitHash: Type.String({
				description: "Git commit hash (short or full SHA)",
			}),
			commitMessage: Type.String({ description: "Commit message" }),
			branchName: Type.Optional(
				Type.String({ description: "Branch name where the commit was made" }),
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

			if (params.taskIndex < 0 || params.taskIndex >= quest.tasks.length) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid task index ${params.taskIndex}. Valid: 0-${quest.tasks.length - 1}.`,
						},
					],
					details: {},
				};
			}

			const task = quest.tasks[params.taskIndex];
			task.commitHash = params.commitHash;
			if (params.branchName) task.branchName = params.branchName;

			quest.commits.push({
				taskIndex: params.taskIndex,
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
							`📝 Commit recorded for task #${params.taskIndex + 1}: **${task.content}**`,
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
					taskIndex: params.taskIndex,
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
					const task = quest.tasks[c.taskIndex];
					const key = `#${c.taskIndex + 1} ${task?.content || "unknown"}`;
					if (!acc[key]) acc[key] = [];
					acc[key].push(c);
					return acc;
				},
				{} as Record<string, typeof quest.commits>,
			);

			const lines: string[] = [
				`## Git Summary: ${quest.name}`,
				``,
				`**${quest.commits.length} commit(s)** across **${Object.keys(commitsByTask).length} task(s)**`,
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
					`**Tasks completed:** ${quest.tasks.filter((t) => t.status === "done").length}/${quest.tasks.length}`,
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
				return `${idx + 1}. **${a.name}** — ${a.done}/${a.tasks} done — ${date}\n   ${a.goal}`;
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
			questCache = quest;
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

	// ── Additional tools ────────────────────────────────────────────────────

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
			const done = quest.tasks.filter((t) => t.status === "done").length;
			const total = quest.tasks.length;
			if (quest.status !== "done") {
				quest.status = "done";
				quest.completedAt = Date.now();
				archiveQuest(quest, ctx.cwd);
			}
			questCache = null;
			renderStatus(ctx, null);
			writeQuestSessionMeta(ctx.cwd, null);
			clearQuestFromTodo(ctx.cwd); // flush stale [Quest] items from pi-todo
			return {
				content: [
					{
						type: "text",
						text: `Quest "${name}" aborted and archived (${done}/${total} tasks done).`,
					},
				],
				details: { name, done, total },
			};
		},
	});

	pi.registerTool({
		name: "quest_task_detail",
		label: "Quest Task Detail",
		description:
			"Get full details for a specific task including context, result, attempts, timing, and verification status.",
		parameters: Type.Object({
			index: Type.Number({ description: "Task index (0-based)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const quest = getQuest(ctx.cwd);
			if (!quest) {
				return {
					content: [{ type: "text", text: "No active quest." }],
					details: {},
				};
			}
			if (params.index < 0 || params.index >= quest.tasks.length) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid task index ${params.index}. Valid: 0-${quest.tasks.length - 1}.`,
						},
					],
					details: {},
				};
			}
			const t = quest.tasks[params.index];
			const deps = t.dependencies.length
				? t.dependencies.map((d) => `#${d + 1} ${quest.tasks[d].content}`).join(", ")
				: "none";
			const time = t.startedAt
				? `${Math.round(((t.completedAt ?? Date.now()) - t.startedAt) / 1000)}s`
				: "not started";
			const lines = [
				`## Task #${params.index + 1}: ${t.content}`,
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
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { task: t, index: params.index },
			};
		},
	});

	// ── Auto-pilot ────────────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (autoPilotLocked) return;
		try {
			const quest = getQuest(ctx.cwd);
			if (!quest || quest.status !== "active") return;

			const next = nextPendingTask(quest);
			if (!next) {
				const verifyingTasks = quest.tasks.filter((t) => t.status === "verifying");
				if (verifyingTasks.length > 0) {
					const allResolved = quest.tasks.every(
						(t) =>
							t.status === "done" ||
							t.status === "skipped" ||
							t.status === "failed" ||
							t.status === "verifying",
					);
					const vfyList = verifyingTasks
						.map((t) => {
							const idx = quest.tasks.indexOf(t);
							return `- #${idx + 1} **${t.content}**`;
						})
						.join("\n");
					if (allResolved) {
						if (ctx.hasUI) {
							const action = await ctx.ui.select(
								`${verifyingTasks.length} task(s) need verification. What now?`,
								[
									"Verify them now (agent will handle it)",
									"Skip verification for all",
									"Pause quest",
								],
							);

							if (action === "Verify them now (agent will handle it)") {
								autoPilotLocked = true;
								try {
									pi.sendUserMessage(
										[
											`## Verification Pending ⏳`,
											``,
											`${verifyingTasks.length} task(s) awaiting verification:`,
											verifyingTasks
												.map((t) => {
													const idx = quest.tasks.indexOf(t);
													return `- #${idx + 1} **${t.content}** — Use subagent(agent="verifier") then call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
												})
												.join("\n"),
											``,
											`After resolving verification, /quest resume.`,
										].join("\n"),
										{ deliverAs: "steer" },
									);
								} finally {
									autoPilotLocked = false;
								}
								return;
							}

							if (action === "Skip verification for all") {
								for (const t of verifyingTasks) {
									t.status = "done";
									t.verified = true;
									t.verifyResult = "[SKIP] Verification skipped by user.";
									t.completedAt = Date.now();
								}
								persist(ctx, quest);
								ctx.ui.notify(
									`${verifyingTasks.length} task(s) verified (skipped). Continuing...`,
									"info",
								);
								return;
							}
						}

						quest.status = "paused";
						quest.pauseReason = `Waiting for verification on ${verifyingTasks.length} task(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Resolve with quest_update(verifyOutcome=...).`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);

						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} task(s) need verification.\n${vfyList}`,
								"warning",
							);
						} else {
							autoPilotLocked = true;
							try {
								pi.sendUserMessage(
									[
										`## Verification Pending ⏳`,
										``,
										`${verifyingTasks.length} task(s) awaiting verification:`,
										verifyingTasks
											.map((t) => {
												const idx = quest.tasks.indexOf(t);
												return `- #${idx + 1} **${t.content}** — call quest_update(index=${idx}, verifyOutcome="PASS"|"FAIL", verifyEvidence=...)`;
											})
											.join("\n"),
										``,
										`/quest resume after resolving verification.`,
									].join("\n"),
									{ deliverAs: "steer" },
								);
							} finally {
								autoPilotLocked = false;
							}
						}
						return;
					} else {
						// allResolved is false — some tasks pending because deps are verifying
						quest.status = "paused";
						quest.pauseReason = `Verification pending on ${verifyingTasks.length} task(s): ${verifyingTasks.map((t) => t.content).join(", ")}. Complete verification to unblock dependent tasks.`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Quest paused: ${verifyingTasks.length} task(s) need verification before dependents can proceed.\n${vfyList}`,
								"warning",
							);
						}
						return;
					}
				}

				const allDone = quest.tasks.every((t) => t.status === "done" || t.status === "skipped");
				const anyFailed = quest.tasks.some((t) => t.status === "failed");

				if (allDone && !anyFailed) {
					quest.status = "done";
					quest.completedAt = Date.now();
					syncConventionsToMemory(quest, ctx.cwd);
					archiveQuest(quest, ctx.cwd);
					persist(ctx, quest);

					const git = quest.gitIntegration;
					const gitSection =
						quest.commits.length > 0
							? [
									``,
									`## Git Summary`,
									``,
									`**${quest.commits.length} commit(s)** recorded.`,
									quest.commits
										.slice(0, 5)
										.map((c) => `- \`${c.hash.slice(0, 8)}\` ${c.message}`)
										.join("\n"),
									quest.commits.length > 5 ? `- ... and ${quest.commits.length - 5} more` : "",
									git?.autoPR
										? [``, `**🔀 Auto-PR enabled.** Generate a PR with quest_git_summary().`].join(
												"\n",
											)
										: "",
								]
									.filter(Boolean)
									.join("\n")
							: git?.autoCommit
								? `\n\n⚠ No commits were recorded for this quest. Use quest_commit to track deliverables.`
								: "";

					autoPilotLocked = true;
					try {
						pi.sendUserMessage(
							[
								`## Quest Complete: ${quest.name} 🎉`,
								``,
								`${quest.tasks.filter((t) => t.status === "done").length}/${quest.tasks.length} tasks done.`,
								gitSection,
								``,
								quest.conventions.length
									? `Saved ${quest.conventions.length} convention(s) to project memory.`
									: `No quest conventions to save to project memory.`,
								``,
								`Start a new quest with /quest create, or review with quest_history.`,
							]
								.filter(Boolean)
								.join("\n"),
							{ deliverAs: "steer" },
						);
					} finally {
						autoPilotLocked = false;
					}
				} else if (anyFailed) {
					const failedTasks = quest.tasks.filter((t) => t.status === "failed");
					const failedList = failedTasks
						.map((t) => {
							const i = quest.tasks.indexOf(t);
							return `  #${i + 1}: ${t.content} — ${t.result || "no details"}`;
						})
						.join("\n");

					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`${failedTasks.length} task(s) failed. What would you like to do?`,
							["Retry failed tasks", "Skip all failed", "Pause and review"],
						);

						if (action === "Retry failed tasks") {
							for (const t of failedTasks) {
								t.status = "pending";
								t.attempts = 0;
								t.startedAt = null;
								t.completedAt = null;
								t.result = null;
							}
							quest.status = "active";
							quest.tasksSincePause = 0;
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(
								`${failedTasks.length} task(s) reset for retry. Auto-pilot resuming.`,
								"info",
							);
							return;
						}

						if (action === "Skip all failed") {
							for (const t of failedTasks) {
								t.status = "skipped";
								t.result = `Skipped by user.`;
								t.completedAt = Date.now();
							}
							quest.status = "active";
							quest.tasksSincePause = 0;
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							quest.pauseReason = null;
							persist(ctx, quest);
							ctx.ui.notify(`${failedTasks.length} task(s) skipped. Auto-pilot resuming.`, "info");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = "Some tasks failed. Review and decide: retry, skip, or redefine.";
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(
							`Quest paused: ${failedTasks.length} task(s) failed.\nFailed:\n${failedList}`,
							"warning",
						);
					} else {
						autoPilotLocked = true;
						try {
							pi.sendUserMessage(
								[
									`## Quest Paused: ${quest.name} ⚠`,
									``,
									`Some tasks failed. Review the status with quest_status and decide next steps:`,
									`- Fix the issue and call quest_update to retry`,
									`- Skip failed tasks with quest_update(status="skipped")`,
									`- /quest resume to continue`,
								].join("\n"),
								{ deliverAs: "steer" },
							);
						} finally {
							autoPilotLocked = false;
						}
					}
				} else {
					quest.status = "paused";
					quest.pauseReason = "All remaining tasks are blocked by unfinished dependencies.";
					persist(ctx, quest);
				}
				return;
			}

			// Stall detection
			if (next.index === quest.lastFiredTaskIndex) {
				quest.sameTaskCount++;
				if (quest.sameTaskCount > 2) {
					if (ctx.hasUI) {
						const action = await ctx.ui.select(
							`Task "${next.task.content}" stalled after ${quest.sameTaskCount} attempts. What now?`,
							["Skip this task", "Mark as failed", "Pause quest"],
						);

						if (action === "Skip this task") {
							next.task.status = "skipped";
							next.task.result = `Skipped by user after stalling (${quest.sameTaskCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Task #${next.index + 1} skipped.`, "info");
							return;
						}

						if (action === "Mark as failed") {
							next.task.status = "failed";
							next.task.result = `Failed by user after stalling (${quest.sameTaskCount} attempts).`;
							next.task.completedAt = Date.now();
							quest.lastFiredTaskIndex = -1;
							quest.sameTaskCount = 0;
							persist(ctx, quest);
							ctx.ui.notify(`Task #${next.index + 1} marked failed.`, "warning");
							return;
						}
					}

					quest.status = "paused";
					quest.pauseReason = `Task #${next.index + 1} stalled (${quest.sameTaskCount} attempts without progress).`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					if (ctx.hasUI) {
						ctx.ui.notify(`Quest paused: stalled task. /quest resume to continue.`, "warning");
					} else {
						autoPilotLocked = true;
						try {
							pi.sendUserMessage(
								`## Quest Paused: Stalled ⚠\n\nTask #${next.index + 1} "${next.task.content}" has been attempted ${quest.sameTaskCount} times without completion.\nUse quest_update to mark it failed or skipped, then /quest resume.`,
								{ deliverAs: "steer" },
							);
						} finally {
							autoPilotLocked = false;
						}
					}
					return;
				}
			} else {
				quest.sameTaskCount = 1;
			}

			if (next.task.attempts > MAX_RETRIES) {
				next.task.status = "failed";
				next.task.result = `Auto-failed after ${MAX_RETRIES + 1} attempts.`;
				quest.lastFiredTaskIndex = -1;
				quest.sameTaskCount = 0;
				persist(ctx, quest);
				return;
			}

			if (quest.tasksSincePause >= MAX_BURST) {
				const done = quest.tasks.filter((t) => t.status === "done").length;
				const total = quest.tasks.length;

				if (ctx.hasUI) {
					const cont = await ctx.ui.confirm(
						"Quest Checkpoint",
						[
							`**${quest.tasksSincePause} tasks** completed in this burst.`,
							``,
							`Progress: **${done}/${total}** done`,
							`Next: **${next.task.content}** [${next.task.agent}]`,
							``,
							`Continue to next task?`,
						].join("\n"),
					);

					if (cont) {
						quest.tasksSincePause = 0;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
					} else {
						quest.status = "paused";
						quest.pauseReason = `User paused at checkpoint after ${quest.tasksSincePause} tasks. /quest resume to continue.`;
						quest.lastFiredTaskIndex = -1;
						quest.sameTaskCount = 0;
						persist(ctx, quest);
						ctx.ui.notify(`Quest paused. /quest resume to continue.`, "info");
						return;
					}
				} else {
					quest.status = "paused";
					quest.pauseReason = `Auto-paused after ${MAX_BURST} tasks. /quest resume to continue.`;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);

					autoPilotLocked = true;
					try {
						pi.sendUserMessage(
							`## Quest Paused: Checkpoint ⏸\n\n${quest.tasksSincePause}/${MAX_BURST} tasks completed. Progress:\n${formatQuestStatus(quest)}\n\n/quest resume to continue.`,
							{ deliverAs: "steer" },
						);
					} finally {
						autoPilotLocked = false;
					}
					return;
				}
			}

			// Fire the next task
			next.task.status = "running";
			next.task.attempts++;
			if (!next.task.startedAt) next.task.startedAt = Date.now();
			quest.lastFiredTaskIndex = next.index;
			quest.tasksSincePause++;
			persist(ctx, quest);

			autoPilotLocked = true;
			try {
				pi.sendUserMessage(buildSteeringMessage(quest, next.task, next.index, ctx.cwd), {
					deliverAs: "steer",
				});
			} finally {
				autoPilotLocked = false;
			}
		} catch (e) {
			console.error("[pi-quest] agent_end handler crashed:", e);
			const quest = getQuest(ctx.cwd);
			if (quest) {
				quest.status = "paused";
				quest.pauseReason = `Auto-pilot error: ${(e as Error)?.message || String(e)}`;
				saveQuest(quest, ctx.cwd);
				questCache = quest;
			}
			renderStatus(ctx, quest);
			writeQuestSessionMeta(ctx.cwd, quest);
			if (quest) syncQuestToTodo(quest, ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Quest auto-pilot error: ${(e as Error)?.message || String(e)}. Quest paused.`,
					"error",
				);
			}
		}
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		questCache = loadQuest(ctx.cwd);
		renderStatus(ctx, questCache);
		writeQuestSessionMeta(ctx.cwd, questCache);
		if (questCache?.status === "active") syncQuestToTodo(questCache, ctx.cwd);

		if (questCache?.status === "active") {
			ctx.ui.notify(
				`Quest active: ${questCache.name} (${questCache.tasks.filter((t) => t.status === "done").length}/${questCache.tasks.length} done)`,
				"info",
			);
		} else if (questCache?.status === "paused") {
			ctx.ui.notify(
				`Quest paused: ${questCache.name} — ${questCache.pauseReason ?? "/quest resume to continue"}`,
				"warning",
			);
		} else if (
			questCache?.planningMode === "approve" &&
			!questCache.planApproved &&
			questCache.tasks.length > 0
		) {
			ctx.ui.notify(
				`Quest awaiting approval: ${questCache.name} — ${questCache.tasks.length} tasks planned. /quest approve to start.`,
				"warning",
			);
		} else if (questCache?.status === "planning") {
			ctx.ui.notify(
				`Quest planning: ${questCache.name} — ${questCache.tasks.length} tasks. /quest start or quest_plan to continue.`,
				"info",
			);
		} else if (questCache?.status === "done") {
			const done = questCache.tasks.filter((t) => t.status === "done").length;
			ctx.ui.notify(
				`Quest completed: ${questCache.name} — ${done}/${questCache.tasks.length} tasks done.`,
				"info",
			);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		renderStatus(ctx, questCache);
		writeQuestSessionMeta(ctx.cwd, questCache);
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("quest", {
		description:
			"Quest: proactive AI project manager. /quest create|start|pause|resume|approve|cancel|kanban|status|history|git|team [list|create]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const spaceIdx = trimmed.indexOf(" ");
			const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			switch (sub) {
				case "": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest. Use /quest create <name>: <goal> to start.", "info");
						return;
					}
					if (ctx.hasUI) {
						await ctx.ui.custom(
							(tui, theme, _kb, done) => {
								const kanban = new QuestKanban(quest, theme);
								kanban.onClose = () => done(undefined);
								return {
									render: (w: number) => {
										const fresh = loadQuest(ctx.cwd);
										if (fresh) kanban.setQuest(fresh);
										return kanban.render(w);
									},
									invalidate: () => kanban.invalidate(),
									handleInput: (data: string) => {
										kanban.handleInput(data);
										tui.requestRender();
									},
								};
							},
							{ overlay: true },
						);
					} else {
						ctx.ui.notify(formatQuestStatus(quest), "info");
					}
					return;
				}
				case "create": {
					const colonIdx = rest.indexOf(":");
					const name = colonIdx === -1 ? rest : rest.slice(0, colonIdx).trim();
					const goal = colonIdx === -1 ? "" : rest.slice(colonIdx + 1).trim();

					if (!name) {
						ctx.ui.notify("Usage: /quest create <name>: <goal description>", "error");
						return;
					}

					if (getQuest(ctx.cwd)?.status === "active") {
						ctx.ui.notify("A quest is already active. /quest pause first.", "error");
						return;
					}

					const quest = emptyQuest(name, goal || name);
					persist(ctx, quest);

					ctx.ui.notify(
						`Quest created: "${name}"\n\nPlan it with quest_plan or let the agent explore and plan.\n/quest start when ready.`,
						"info",
					);

					autoPilotLocked = true;
					try {
						pi.sendUserMessage(
							[
								`## New Quest: ${name}`,
								goal ? `**Goal:** ${goal}` : "",
								compactAwarenessBlock(ctx.cwd),
								``,
								`Plan this quest. Use subagent(agent="scout") to explore the codebase,`,
								`then subagent(agent="planner") to create a task breakdown.`,
								`Save the plan with **quest_plan(tasks=[...], autoStart=true)**.`,
								``,
								`Research: Note the current date. Use web_search to find the latest relevant information about this goal (best practices, APIs, security considerations, etc.). Save key findings with quest_memory_save.`,
							]
								.filter(Boolean)
								.join("\n"),
							{ deliverAs: "steer" },
						);
					} finally {
						autoPilotLocked = false;
					}
					return;
				}
				case "team": {
					const args = rest.split(/\s+/).filter(Boolean);
					const subCmd = args[0] || "list";
					const subRest = args.slice(1).join(" ");

					if (subCmd === "list" || !rest) {
						ensureBuiltInTeams();
						const teams = loadTeams();
						const names = Object.keys(teams);
						if (names.length === 0) {
							ctx.ui.notify("No teams found. Built-in teams will be created on next load.", "info");
							return;
						}
						const lines = names.map((n) => {
							const t = teams[n]!;
							const members = t.members.map((m) => `${m.role}:${m.agent}`).join(", ");
							const agentInfo = t.agents?.length
								? `\n  Custom agents: ${t.agents.map((a) => a.name).join(", ")}`
								: "";
							return `**${t.name}** — ${t.description}\n  Lead: ${t.lead} · Default: ${t.defaultAgent} · Verify: ${t.verification}\n  Members: ${members}${agentInfo}`;
						});
						ctx.ui.notify(`Teams:\n\n${lines.join("\n\n")}`, "info");
						return;
					}

					if (subCmd === "install") {
						const gitUrl = subRest;
						if (!gitUrl || !gitUrl.startsWith("http")) {
							ctx.ui.notify(
								"Usage: /quest team install <git-url>\n\nExample: /quest team install https://github.com/user/quest-team-content",
								"error",
							);
							return;
						}
						ctx.ui.notify(`Installing team from ${gitUrl}...`, "info");

						const result = teamInstallFromGit(gitUrl);
						if (result.success) {
							const t = result.team!;
							const members = t.members.map((m) => `${m.role}:${m.agent}`).join(", ");
							ctx.ui.notify(
								`✅ Team installed: **${t.name}**\n\n${t.description}\nLead: ${t.lead} · Default: ${t.defaultAgent}\nMembers: ${members}`,
								"info",
							);
						} else {
							ctx.ui.notify(`❌ Install failed: ${result.error}`, "error");
						}
						return;
					}

					if (subCmd === "create") {
						ctx.ui.notify(
							[
								`## Create a Team Template`,
								``,
								`To create a custom team, create a JSON file in:`,
								`\`${TEAMS_DIR}/your-team-name.json\``,
								``,
								`**Required fields:**`,
								`\`\`\`json`,
								JSON.stringify(
									{
										name: "my-team",
										description: "My custom team description",
										lead: "worker",
										members: [
											{ role: "developer", agent: "worker" },
											{ role: "reviewer", agent: "reviewer" },
										],
										defaultAgent: "worker",
										verification: true,
									},
									null,
									2,
								),
								`\`\`\``,
								``,
								`**Optional: custom agents** — add agent markdown files to:`,
								`\`${join(homedir(), ".pi", "agent", "agents")}/<agent-name>.md\``,
								``,
								`Then reference them in \`members\`. To share, push your team JSON +`,
								`agent markdown files to a GitHub repo and others can install with:`,
								`\`/quest team install <git-url>\``,
							].join("\n"),
							"info",
						);
						return;
					}

					ctx.ui.notify("Usage: /quest team [list|install <git-url>|create]", "error");
					return;
				}
				case "start": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.status === "active") {
						ctx.ui.notify("Quest is already active.", "info");
						return;
					}
					if (quest.tasks.length === 0) {
						ctx.ui.notify("No tasks planned. Use quest_plan to add tasks first.", "error");
						return;
					}
					if (quest.planningMode === "approve" && !quest.planApproved) {
						ctx.ui.notify(
							"This quest requires plan approval before starting.\n\nUse /quest approve to review and approve the plan.",
							"warning",
						);
						return;
					}
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					ctx.ui.notify(
						`Quest "${quest.name}" started — ${quest.tasks.length} tasks. Auto-pilot engaged.`,
						"info",
					);
					return;
				}
				case "pause": {
					const quest = getQuest(ctx.cwd);
					if (!quest || quest.status !== "active") {
						ctx.ui.notify("No active quest to pause.", "info");
						return;
					}
					quest.status = "paused";
					quest.pauseReason = "Paused by user.";
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					persist(ctx, quest);
					ctx.ui.notify(`Quest "${quest.name}" paused. /quest resume to continue.`, "info");
					return;
				}
				case "resume": {
					const quest = getQuest(ctx.cwd);
					if (!quest || quest.status !== "paused") {
						ctx.ui.notify("No paused quest to resume.", "info");
						return;
					}
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					const done = quest.tasks.filter((t) => t.status === "done").length;
					const next = nextPendingTask(quest);
					ctx.ui.notify(
						`Quest "${quest.name}" resumed. ${done}/${quest.tasks.length} done.${next ? ` Next: ${next.task.content}` : ""}`,
						"info",
					);
					return;
				}
				case "approve": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No quest created. /quest create first.", "error");
						return;
					}
					if (quest.planApproved) {
						ctx.ui.notify("Plan already approved. Quest is in progress.", "info");
						return;
					}
					if (quest.tasks.length === 0) {
						ctx.ui.notify("No tasks to approve. Use quest_plan to create a plan first.", "error");
						return;
					}

					const planSummary = quest.tasks
						.slice(0, 8)
						.map((t, i) => `${i + 1}. ${t.content} [${t.agent}]`)
						.join("\n");
					const moreTasks =
						quest.tasks.length > 8 ? `\n  … and ${quest.tasks.length - 8} more` : "";

					quest.planApproved = true;
					quest.status = "active";
					quest.tasksSincePause = 0;
					quest.lastFiredTaskIndex = -1;
					quest.sameTaskCount = 0;
					quest.pauseReason = null;
					persist(ctx, quest);

					const next = nextPendingTask(quest);
					ctx.ui.notify(
						`✅ Plan approved: "${quest.name}" — ${quest.tasks.length} tasks. Auto-pilot engaged.${next ? ` First: ${next.task.content}` : ""}\n\n${planSummary}${moreTasks}`,
						"info",
					);
					return;
				}
				case "kanban": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					if (ctx.hasUI) {
						await ctx.ui.custom(
							(tui, theme, _kb, done) => {
								const kanban = new QuestKanban(quest, theme);
								kanban.onClose = () => done(undefined);
								// Refresh quest data on re-render so status updates are visible
								return {
									render: (w: number) => {
										const fresh = loadQuest(ctx.cwd);
										if (fresh) kanban.setQuest(fresh);
										return kanban.render(w);
									},
									invalidate: () => kanban.invalidate(),
									handleInput: (data: string) => {
										kanban.handleInput(data);
										tui.requestRender();
									},
								};
							},
							{ overlay: true },
						);
					} else {
						ctx.ui.notify(formatQuestStatus(quest), "info");
					}
					return;
				}
				case "status": {
					const quest = loadQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					ctx.ui.notify(formatQuestStatus(quest), "info");
					return;
				}
				case "git": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest.", "info");
						return;
					}
					const git = quest.gitIntegration;
					if (!git) {
						ctx.ui.notify("Git integration not configured for this quest.", "info");
						return;
					}
					const config = [
						`## Git Integration: ${quest.name}`,
						``,
						`- Auto-commit: ${git.autoCommit ? "✅ on" : "❌ off"}`,
						`- Auto-branch: ${git.autoBranch ? "✅ on" : "❌ off"}${git.autoBranch ? ` (prefix: \`${git.branchPrefix}\`)` : ""}`,
						`- Auto-PR: ${git.autoPR ? "✅ on" : "❌ off"}`,
						``,
						`Commits recorded: ${quest.commits.length}`,
					].join("\n");

					let commitList = "";
					if (quest.commits.length > 0) {
						commitList =
							"\n\n" +
							quest.commits
								.map((c) => {
									return `- \`${c.hash.slice(0, 8)}\` #${c.taskIndex + 1}: ${c.message}`;
								})
								.join("\n");
					}
					ctx.ui.notify(config + commitList, "info");
					return;
				}
				case "history": {
					const limit = parseInt(rest, 10) || 10;
					const archives = listArchives(limit, ctx.cwd);
					if (archives.length === 0) {
						ctx.ui.notify("No completed quests yet.", "info");
						return;
					}
					const lines = archives.map((a, idx) => {
						const date = a.completedAt
							? new Date(a.completedAt).toLocaleDateString("en-US", {
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})
							: "?";
						return `${idx + 1}. **${a.name}** — ${a.done}/${a.tasks} done — ${date}\n   ${a.goal}`;
					});
					ctx.ui.notify(`Completed quests:\n\n${lines.join("\n\n")}`, "info");
					return;
				}
				case "cancel": {
					const quest = getQuest(ctx.cwd);
					if (!quest) {
						ctx.ui.notify("No active quest to cancel.", "info");
						return;
					}
					if (quest.status === "active") {
						ctx.ui.notify("Cannot cancel an active quest. /quest pause first.", "error");
						return;
					}
					const name = quest.name;
					const done = quest.tasks.filter((t) => t.status === "done").length;
					if (quest.status !== "done") {
						quest.status = "done";
						quest.completedAt = Date.now();
						archiveQuest(quest, ctx.cwd);
					}
					questCache = null;
					renderStatus(ctx, null);
					writeQuestSessionMeta(ctx.cwd, null);
					clearQuestFromTodo(ctx.cwd); // flush quest items, not re-sync them as completed
					ctx.ui.notify(
						`Quest "${name}" cancelled and archived (${done}/${quest.tasks.length} tasks done).`,
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /quest [create <name>: <goal>|start|pause|resume|approve|cancel|kanban|status|history|git|team [list|install <url>|create]]",
						"error",
					);
			}
		},
	});
}
