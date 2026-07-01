import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { StepStatus } from "./types";
import { FORMAT_DIRECTIVE, MAX_DEPENDENCY_DEPTH, MAX_VERIFY_RETRIES } from "./constants";
import { loadTeams } from "./teams";
import { buildSandboxComplianceChecks, parseVerifyOutcome } from "./verifier";
import { buildVerificationImpactContext, enrichPlanningContext } from "./codebase";
import { detectDependencyCycle, getMaxDependencyDepth } from "./graph";
import { nextPendingStep } from "./steering";
import { resolveSandboxProfile } from "./sandbox";
import { logDeprecatedParam } from "./deprecation";
import type { QuestRuntime } from "./runtime";

export function registerPlanningTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const { getQuest, persist, recordRun, recordEval, makeEval, codebaseToolAvailable } = rt;

	pi.registerTool({
		name: "quest_plan",
		label: "Quest Plan",
		description: [
			"Save a step breakdown for the current quest. Replaces all existing steps.",
			"Each step needs: content, agent (sub-agent type), context (focused instructions).",
			"Optionally: dependencies (array of step indices that must complete first).",
			"Set autoStart: true to immediately begin auto-pilot execution.",
			"When planningMode='approve' and running interactively, shows the plan to the user for approval.",
		].join(" "),
		parameters: Type.Object({
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						content: Type.String({ description: "Short name of the step" }),
						agent: Type.String({
							description:
								"Sub-agent type: worker, quick-worker, scout, planner, reviewer, verifier",
						}),
						context: Type.String({
							description: "Focused context/instructions for the sub-agent — keep it lean",
						}),
						dependencies: Type.Optional(
							Type.Array(Type.Number(), {
								description: "Indices of steps that must complete first (0-based)",
							}),
						),
						model: Type.Optional(
							Type.String({
								description:
									"Model id to run this step's sub-agent with. Usually leave unset — quest assigns it via quest_assign_model (asking the user once per role).",
							}),
						),
						sandbox: Type.Optional(
							Type.Object({
								mode: Type.Optional(
									StringEnum(["restricted", "isolated"] as const, {
										description:
											"Escalate sandbox mode for this step (cannot de-escalate quest-level).",
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
					{ description: "Array of steps in execution order" },
				),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						content: Type.String({ description: "Short name of the step" }),
						agent: Type.String({
							description:
								"Sub-agent type: worker, quick-worker, scout, planner, reviewer, verifier",
						}),
						context: Type.String({
							description: "Focused context/instructions for the sub-agent — keep it lean",
						}),
						dependencies: Type.Optional(
							Type.Array(Type.Number(), {
								description: "Indices of steps that must complete first (0-based)",
							}),
						),
						model: Type.Optional(
							Type.String({
								description:
									"Model id to run this step's sub-agent with. Usually leave unset — quest assigns it via quest_assign_model (asking the user once per role).",
							}),
						),
						sandbox: Type.Optional(
							Type.Object({
								mode: Type.Optional(
									StringEnum(["restricted", "isolated"] as const, {
										description:
											"Escalate sandbox mode for this step (cannot de-escalate quest-level).",
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
					{
						description:
							"Legacy alias for steps. Prefer steps for new calls; tasks remains accepted for backward compatibility.",
					},
				),
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

			const plannedSteps = params.steps ?? params.tasks ?? [];
			if (params.tasks !== undefined && params.steps === undefined) {
				logDeprecatedParam("quest_plan", params as Record<string, unknown>, "tasks", "steps");
			}

			if (plannedSteps.length === 0) {
				return {
					content: [{ type: "text", text: "No steps provided." }],
					details: {},
				};
			}

			if (plannedSteps.length > 50) {
				return {
					content: [
						{
							type: "text",
							text: "Too many steps (max 50). Break into smaller quests.",
						},
					],
					details: {},
				};
			}

			quest.steps = plannedSteps.map((t) => ({
				content: t.content,
				status: "pending" as StepStatus,
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

			for (let i = 0; i < quest.steps.length; i++) {
				for (const dep of quest.steps[i].dependencies) {
					if (dep < 0 || dep >= quest.steps.length || dep === i) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid dependency in step #${i + 1}: step #${dep + 1} is out of range or self-referencing.`,
								},
							],
							details: {},
						};
					}
				}
			}

			// Detect dependency cycles
			const cyclePath = detectDependencyCycle(quest.steps);
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
			const depth = getMaxDependencyDepth(quest.steps);
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

			const codebaseEnrichment = enrichPlanningContext(quest.steps, quest.goal, ctx.cwd);
			quest.steps = codebaseEnrichment.enrichedTasks;

			const needsApproval = quest.planningMode === "approve" && !quest.planApproved;

			const fullPlan = quest.steps
				.map((t, i) => {
					const deps = t.dependencies.length
						? ` (requires: ${t.dependencies.map((d) => quest.steps[d].content).join(", ")})`
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
					quest.stepsSincePause = 0;
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
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
						`⚠ **Plan needs your approval.** Review the steps above.`,
						`- Approve: call **quest_approve()** or type /quest approve`,
						`- Edit steps: call **quest_approve(edits=[...])** with step modifications`,
						`- Reject: call quest_plan with a new set of steps`,
					].join("\n")
				: "";

			return {
				content: [
					{
						type: "text",
						text: [
							`Plan saved: **${quest.steps.length} steps**`,
							codebaseEnrichment.summary,
							codebaseToolAvailable()
								? `For additional planning precision, use codebase(operation="query", pattern=...) and codebase(operation="map", file=...) before delegating broad steps.`
								: `codebase tool unavailable; used direct cache fallback when compatible.`,
							``,
							`  ${quest.steps
								.slice(0, 5)
								.map(
									(t, i) =>
										`${i + 1}. ${t.content} [${t.agent}]${t.dependencies.length ? ` ← #${t.dependencies.map((d) => d + 1).join(", #")}` : ""}`,
								)
								.join("\n  ")}`,
							quest.steps.length > 5 ? `  … and ${quest.steps.length - 5} more` : "",
							``,
							quest.status === "active"
								? `**Quest is now ACTIVE.** Auto-pilot will fire the first step on the next turn.`
								: needsApproval
									? `Awaiting approval. Review the plan above and call quest_approve to start.`
									: `Quest in planning mode. Call quest_start or /quest start to begin.`,
							approvalMsg,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { steps: quest.steps, status: quest.status, needsApproval },
			};
		},
	});

	pi.registerTool({
		name: "quest_update",
		label: "Quest Update",
		description: [
			"Update a step's status in the current quest.",
			"Call this after a sub-agent completes its work on a step.",
			"Pass the step index (0-based) and new status.",
			"Set result to a brief summary of what was done.",
			"To report verification results: pass verifyOutcome='PASS'|'FAIL' and verifyEvidence.",
		].join(" "),
		parameters: Type.Object({
			index: Type.Number({ description: "Step index (0-based)" }),
			status: StringEnum(["done", "failed", "skipped"] as const, {
				description: "New status for the step",
			}),
			result: Type.Optional(Type.String({ description: "Brief summary of what happened" })),
			verifyOutcome: Type.Optional(
				StringEnum(["PASS", "FAIL"] as const, {
					description: "Verification outcome. Use on a 'verifying' step to report PASS or FAIL.",
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

			if (params.index < 0 || params.index >= quest.steps.length) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid step index ${params.index}. Valid: 0-${quest.steps.length - 1}.`,
						},
					],
					details: {},
				};
			}

			const task = quest.steps[params.index];

			// ── Verification outcome ──────────────────────────────────────────
			// The explicit verifyOutcome flag wins. Otherwise, when the step is
			// already awaiting verification, infer the verdict deterministically
			// from the reported result text (parseVerifyOutcome tolerates markdown,
			// labels, emoji, and trailing verdicts). This keeps the quality gate
			// working when a smaller orchestrator states the verdict in prose but
			// omits the structured flag — without it, such a call would bounce the
			// step back into verification instead of resolving it.
			let effectiveOutcome: "PASS" | "FAIL" | undefined = params.verifyOutcome;
			if (!effectiveOutcome && task.status === "verifying") {
				const parsed = parseVerifyOutcome(params.result ?? "");
				if (parsed === "pass") effectiveOutcome = "PASS";
				else if (parsed === "fail") effectiveOutcome = "FAIL";
			}
			const inferredOutcome = !params.verifyOutcome && effectiveOutcome !== undefined;
			// When inferred from prose, use the result text itself as the evidence.
			const effectiveEvidence =
				params.verifyEvidence ?? (inferredOutcome ? params.result : undefined);

			if (effectiveOutcome) {
				if (task.status !== "verifying") {
					return {
						content: [
							{
								type: "text",
								text: `Step #${params.index + 1} is not in verifying state. Current: ${task.status}.`,
							},
						],
						details: {},
					};
				}

				task.verifyResult = `[${effectiveOutcome}] ${effectiveEvidence || ""}`.trim();
				task.verified = true;

				if (effectiveOutcome === "PASS") {
					task.status = "done";
					task.completedAt = Date.now();

					recordRun(ctx.cwd, {
						kind: "verify_pass",
						taskIndex: params.index,
						taskContent: task.content,
						agent: "verifier",
						timestamp: Date.now(),
						evidence: effectiveEvidence,
					});
					recordEval(ctx.cwd, makeEval(quest, task, params.index, "done", true, effectiveEvidence));

					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);

					const done = quest.steps.filter((t) => t.status === "done").length;
					const next = nextPendingStep(quest);
					const git = quest.gitIntegration;
					const gitPrompt = git?.autoCommit
						? [
								``,
								`📝 **Git:** After committing, record with quest_commit(stepIndex=${params.index}, commitHash="...", commitMessage="[quest/${quest.name}] step #${params.index + 1}: ${task.content}", ...)`,
							].join("\n")
						: "";
					return {
						content: [
							{
								type: "text",
								text: [
									`✅ Step #${params.index + 1} **VERIFIED PASS**: ${task.content}`,
									effectiveEvidence ? `  Evidence: ${effectiveEvidence}` : "",
									``,
									`Step marked done. Progress: ${done}/${quest.steps.length} done`,
									next
										? `Next: ${next.task.content} [${next.task.agent}]`
										: "All steps done or blocked!",
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
							progress: `${done}/${quest.steps.length}`,
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
					task.result = `Verification FAIL #${task.verifyRetries}: ${effectiveEvidence || "no details"}. Fix and retry (${retriesLeft} retries left).`;
					task.context = `${task.context}\n\n[Verification FAIL #${task.verifyRetries}]: ${effectiveEvidence || "see above"}. Fix the issues and try again.`;
					task.completedAt = null;

					recordRun(ctx.cwd, {
						kind: "verify_fail",
						taskIndex: params.index,
						taskContent: task.content,
						agent: "verifier",
						timestamp: Date.now(),
						evidence: effectiveEvidence,
						verifyRetriesLeft: retriesLeft,
					});
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);

					return {
						content: [
							{
								type: "text",
								text: [
									`❌ Step #${params.index + 1} **VERIFICATION FAIL**: ${task.content}`,
									effectiveEvidence ? `  Evidence: ${effectiveEvidence}` : "",
									``,
									`Retry ${task.verifyRetries}/${MAX_VERIFY_RETRIES}. Step reset to pending with fix context.`,
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
				task.result = `Verification FAIL after ${MAX_VERIFY_RETRIES} retries: ${effectiveEvidence || "no details"}`;

				recordRun(ctx.cwd, {
					kind: "verify_fail",
					taskIndex: params.index,
					taskContent: task.content,
					agent: "verifier",
					timestamp: Date.now(),
					evidence: effectiveEvidence,
					verifyRetriesLeft: 0,
				});
				recordEval(
					ctx.cwd,
					makeEval(quest, task, params.index, "failed", false, effectiveEvidence),
				);

				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				persist(ctx, quest);

				return {
					content: [
						{
							type: "text",
							text: [
								`❌ Step #${params.index + 1} **AUTO-FAILED** (${MAX_VERIFY_RETRIES} verification retries exhausted): ${task.content}`,
								effectiveEvidence ? `  Last evidence: ${effectiveEvidence}` : "",
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
									`🔍 Step #${params.index + 1} **entered verification**: ${task.content}`,
									``,
									`**Step result to verify:**`,
									`> ${params.result || task.result || "(no result provided)"}`,
									``,
									`**Verification step:** Spawn a \`subagent(agent="${verifierAgent}")\` to verify this task.`,
									`The verifier should check:`,
									`1. Does the result match the step requirements?`,
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
									`Step context: ${task.context}`,
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
								? `**Recommended branch:** \`${git.branchPrefix || "quest/"}task-${params.index + 1}-${quest.steps[
										params.index
									].content
										.replace(/[^a-z0-9]+/gi, "-")
										.toLowerCase()
										.slice(0, 40)}\``
								: "",
							`**Commit message prefix:** \`[quest/${quest.name}] step #${params.index + 1}: ${quest.steps[params.index].content}\``,
							``,
							`After committing, record the commit with **quest_commit**:`,
							`\`quest_commit(stepIndex=${params.index}, commitHash="...", commitMessage="...", branchName="...")\``,
							`Or call quest_git_summary() to review all quest commits.`,
						]
							.filter(Boolean)
							.join("\n")
					: "";

			quest.lastFiredStepIndex = -1;
			quest.sameStepCount = 0;

			persist(ctx, quest);

			const done = quest.steps.filter((t) => t.status === "done").length;
			const total = quest.steps.length;
			const next = nextPendingStep(quest);

			return {
				content: [
					{
						type: "text",
						text: [
							`Step #${params.index + 1} → **${params.status.toUpperCase()}**: ${task.content}`,
							params.result ? `  Result: ${params.result}` : "",
							``,
							`Progress: ${done}/${total} done`,
							next
								? `Next: ${next.task.content} [${next.task.agent}]`
								: "All steps done or blocked!",
							``,
							quest.status === "active"
								? "Auto-pilot will fire the next step."
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
			"Optionally pass edits to modify steps before starting.",
		].join(" "),
		parameters: Type.Object({
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						index: Type.Number({ description: "Step index to edit (0-based)" }),
						content: Type.Optional(Type.String({ description: "New step content" })),
						agent: Type.Optional(Type.String({ description: "New sub-agent type" })),
						context: Type.Optional(Type.String({ description: "New context/instructions" })),
						dependencies: Type.Optional(
							Type.Array(Type.Number(), {
								description: "New dependency indices",
							}),
						),
					}),
					{ description: "Optional step edits to apply before starting" },
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

			if (quest.steps.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No steps to approve. Use quest_plan to create a step breakdown first.",
						},
					],
					details: {},
				};
			}

			let editsApplied = 0;
			if (params.edits) {
				for (const edit of params.edits) {
					if (edit.index < 0 || edit.index >= quest.steps.length) {
						return {
							content: [
								{
									type: "text",
									text: `Invalid edit index ${edit.index}. Valid: 0-${quest.steps.length - 1}.`,
								},
							],
							details: {},
						};
					}
					const task = quest.steps[edit.index];
					if (edit.content !== undefined) task.content = edit.content;
					if (edit.agent !== undefined) task.agent = edit.agent;
					if (edit.context !== undefined) task.context = edit.context;
					if (edit.dependencies !== undefined) task.dependencies = edit.dependencies;
					editsApplied++;
				}
				// Re-validate all dependencies after edits
				for (let i = 0; i < quest.steps.length; i++) {
					for (const dep of quest.steps[i].dependencies) {
						if (dep < 0 || dep >= quest.steps.length || dep === i) {
							return {
								content: [
									{
										type: "text",
										text: `Invalid dependency after edit in step #${i + 1}: step #${dep + 1} is out of range or self-referencing.`,
									},
								],
								details: {},
							};
						}
					}
				}
			}

			const reviewPlan = quest.steps
				.map((t, i) => {
					const deps = t.dependencies.length
						? ` (requires: ${t.dependencies.map((d) => quest.steps[d].content).join(", ")})`
						: "";
					return `${i + 1}. **${t.content}** [${t.agent}]${deps}\n   ${t.context}`;
				})
				.join("\n\n");

			if (ctx.hasUI) {
				const confirmMsg = [
					`**Quest:** ${quest.name}`,
					`**Goal:** ${quest.goal}`,
					``,
					editsApplied > 0 ? `${editsApplied} step edit(s) saved.` : "",
					`Approve ${quest.steps.length} planned step(s) and start executing now?`,
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
										? `📝 ${editsApplied} step edit(s) saved. Plan not approved — kept in planning.`
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
			quest.stepsSincePause = 0;
			quest.lastFiredStepIndex = -1;
			quest.sameStepCount = 0;
			quest.pauseReason = null;

			persist(ctx, quest);

			const next = nextPendingStep(quest);
			return {
				content: [
					{
						type: "text",
						text: [
							`✅ Plan approved: **${quest.name}**`,
							``,
							`${quest.steps.length} steps queued. Quest is now **ACTIVE**.`,
							next ? `First step: ${next.task.content} [${next.task.agent}]` : "All steps ready.",
							``,
							"Auto-pilot will fire the first step on the next turn.",
						].join("\n"),
					},
				],
				details: {
					approved: true,
					steps: quest.steps.length,
					nextTask: next?.task.content ?? null,
				},
			};
		},
	});
}
