import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TaskStatus } from "./types";
import { FORMAT_DIRECTIVE, MAX_DEPENDENCY_DEPTH, MAX_VERIFY_RETRIES } from "./constants";
import { loadTeams } from "./teams";
import { buildSandboxComplianceChecks } from "./verifier";
import { buildVerificationImpactContext, enrichPlanningContext } from "./codebase";
import { detectDependencyCycle, getMaxDependencyDepth } from "./graph";
import { nextPendingTask } from "./steering";
import { resolveSandboxProfile } from "./sandbox";
import type { QuestRuntime } from "./runtime";

export function registerPlanningTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, recordRun, recordEval, makeEval, codebaseToolAvailable } = rt;

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
					model: Type.Optional(
						Type.String({
							description:
								"Model id to run this task's sub-agent with. Usually leave unset — quest assigns it via quest_assign_model (asking the user once per role).",
						}),
					),
					sandbox: Type.Optional(
						Type.Object({
							mode: Type.Optional(
								StringEnum(["restricted", "isolated"] as const, {
									description:
										"Escalate sandbox mode for this task (cannot de-escalate quest-level).",
								}),
							),
							allowedPaths: Type.Optional(
								Type.Array(Type.String(), {
									description: "Additional allowed paths (intersect with quest-level).",
								}),
							),
							deniedPaths: Type.Optional(
								Type.Array(Type.String(), {
									description: "Additional denied paths (union with quest-level).",
								}),
							),
							allowCommands: Type.Optional(
								Type.Array(Type.String(), {
									description: "Additional allowed commands (intersect with quest-level).",
								}),
							),
							denyCommands: Type.Optional(
								Type.Array(Type.String(), {
									description: "Additional denied commands (union with quest-level).",
								}),
							),
							allowNetwork: Type.Optional(
								Type.Boolean({
									description: "Override network access (can only go true→false).",
								}),
							),
							allowPackageInstall: Type.Optional(
								Type.Boolean({
									description: "Override package-install permission (can only go true→false).",
								}),
							),
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
				model: t.model?.trim() || undefined,
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
				sandbox:
					t.sandbox && typeof t.sandbox === "object" && Object.keys(t.sandbox).length > 0
						? (t.sandbox as import("./types").SandboxOverrides)
						: undefined,
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

			const codebaseEnrichment = enrichPlanningContext(quest.tasks, quest.goal, ctx.cwd);
			quest.tasks = codebaseEnrichment.enrichedTasks;

			const needsApproval = quest.planningMode === "approve" && !quest.planApproved;

			const fullPlan = quest.tasks
				.map((t, i) => {
					const deps = t.dependencies.length
						? ` (requires: ${t.dependencies.map((d) => quest.tasks[d].content).join(", ")})`
						: "";
					return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
				})
				.join("\n\n");

			// In approval mode, do not show the full plan in ctx.ui.confirm here: extension
			// confirm dialogs render their message in a non-scrollable selector title. Return
			// the full plan as normal tool output instead so users can review it in scrollback,
			// then explicitly approve with quest_approve or /quest approve.

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
							codebaseEnrichment.summary,
							codebaseToolAvailable()
								? `For additional planning precision, use codebase(operation="query", pattern=...) and codebase(operation="map", file=...) before delegating broad tasks.`
								: `codebase tool unavailable; used direct cache fallback when compatible.`,
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

					recordRun(ctx.cwd, {
						kind: "verify_pass",
						taskIndex: params.index,
						taskContent: task.content,
						agent: "verifier",
						timestamp: Date.now(),
						evidence: params.verifyEvidence,
					});
					recordEval(
						ctx.cwd,
						makeEval(quest, task, params.index, "done", true, params.verifyEvidence),
					);

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

					recordRun(ctx.cwd, {
						kind: "verify_fail",
						taskIndex: params.index,
						taskContent: task.content,
						agent: "verifier",
						timestamp: Date.now(),
						evidence: params.verifyEvidence,
						verifyRetriesLeft: retriesLeft,
					});
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

				recordRun(ctx.cwd, {
					kind: "verify_fail",
					taskIndex: params.index,
					taskContent: task.content,
					agent: "verifier",
					timestamp: Date.now(),
					evidence: params.verifyEvidence,
					verifyRetriesLeft: 0,
				});
				recordEval(
					ctx.cwd,
					makeEval(quest, task, params.index, "failed", false, params.verifyEvidence),
				);

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

					const impactContext = buildVerificationImpactContext(
						ctx.cwd,
						`${task.content}\n${task.context}\n${params.result || task.result || ""}`,
					);
					const sandboxProfile = resolveSandboxProfile(quest.sandbox, task.sandbox);
					const sandboxChecks = buildSandboxComplianceChecks(sandboxProfile);
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
									`5. Review dependency impact for changed files before PASS.`,
									...(sandboxChecks.length > 0 ? [``, ...sandboxChecks] : []),
									``,
									impactContext,
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

			const reviewPlan = quest.tasks
				.map((t, i) => {
					const deps = t.dependencies.length
						? ` (requires: ${t.dependencies.map((d) => quest.tasks[d].content).join(", ")})`
						: "";
					return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
				})
				.join("\n\n");

			if (ctx.hasUI) {
				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					editsApplied > 0 ? `${editsApplied} task edit(s) saved.` : "",
					`Approve ${quest.tasks.length} planned task(s) and start executing now?`,
					``,
					`Use No to keep the plan in scrollable output for review.`,
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
									`## Plan Review`,
									``,
									reviewPlan,
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
}
