import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { StepStatus } from "./types";
import type { FailureCode } from "../../core";
import { LADDER, MAX_DEPENDENCY_DEPTH, MAX_VERIFY_RETRIES, VERIFICATION } from "./constants";
import { loadModelLadder } from "./storage";
import { loadTeams } from "./teams";
import { buildSandboxComplianceChecks, buildVerifierHandoff } from "./verifier";
import { briefBudgetForModel } from "./ladder";
import {
	failureCodeForCheck,
	firstFailure,
	planChecks,
	runChecks,
	summarizeChecks,
} from "./checks";
import { collectDiffEvidence, type StepEvidence } from "./evidence";
import { buildVerificationImpactContext, enrichPlanningContext } from "./codebase";
import { detectDependencyCycle, getMaxDependencyDepth } from "./graph";
import { enrichStepsWithMemoryGraph } from "./memory-graph-read";
import { nextPendingStep } from "./steering";
import { persistHandoff } from "./context-broker";
import { normalizeClaims, validateClaims, validateParallelWriteClaims } from "./write-claim";
import { resolveSandboxProfile } from "./sandbox";
import type { QuestRuntime } from "./runtime";
import { loadProjectMemory } from "./utils";
import type { MemoryGraph } from "../../core";
import {
	applyVerifyFailBookkeeping,
	formatTerminalUpdateMessage,
	formatVerifyPassMessage,
	planCheckFail,
	planTerminalUpdate,
	planVerifyFail,
	planVerifyInconclusive,
	planVerifyPass,
	resolveEffectiveOutcome,
	snapshotStepForVerify,
	type PlanVerifyFailResult,
	type VerifyRunEvent,
} from "./verify-outcome";

export function registerPlanningTools(pi: ExtensionAPI, rt: QuestRuntime): void {
	const {
		getQuest,
		persist,
		recordRun,
		recordEval,
		makeEval,
		codebaseToolAvailable,
		textResult,
		claims: claimReg,
	} = rt;

	pi.registerTool({
		name: "quest_plan",
		label: "Quest Plan",
		description: [
			"Save a step breakdown for the current quest. Replaces all existing steps.",
			"Each step needs: content, agent (sub-agent type), context (focused instructions).",
			"Optionally: dependencies, readClaim, and writeClaim (cwd-relative path arrays).",
			"Exploration/judge roles are read-only; concurrent writers need disjoint write claims.",
			"When parallel is enabled, every execution-role step must declare a non-empty writeClaim.",
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
						readClaim: Type.Optional(
							Type.Array(Type.String(), { description: "Cwd-relative paths this step reads" }),
						),
						writeClaim: Type.Optional(
							Type.Array(Type.String(), { description: "Cwd-relative paths this step writes" }),
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
						readClaim: Type.Optional(
							Type.Array(Type.String(), { description: "Cwd-relative paths this step reads" }),
						),
						writeClaim: Type.Optional(
							Type.Array(Type.String(), { description: "Cwd-relative paths this step writes" }),
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

			for (let i = 0; i < plannedSteps.length; i++) {
				const step = plannedSteps[i];
				const policyError = validateClaims(step.agent, step.writeClaim, step.readClaim);
				try {
					if (policyError) throw new Error(policyError);
					normalizeClaims(step.readClaim, ctx.cwd);
					normalizeClaims(step.writeClaim, ctx.cwd);
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid claims in step #${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: {},
					};
				}
			}

			// Parallel writers must declare non-empty writeClaim so empty claims
			// cannot silently overlap (R3). Read-only roles may keep empty claims.
			if (quest.parallel?.enabled) {
				const parallelClaimError = validateParallelWriteClaims(plannedSteps);
				if (parallelClaimError) {
					return {
						content: [{ type: "text", text: parallelClaimError }],
						details: {},
					};
				}
			}

			quest.steps = plannedSteps.map((t) => ({
				content: t.content,
				status: "pending" as StepStatus,
				phase: "queued" as const,
				phaseChangedAt: Date.now(),
				agent: t.agent,
				model: t.model?.trim() || undefined,
				context: t.context,
				dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
				readClaim: t.readClaim?.length ? [...new Set(t.readClaim)] : undefined,
				writeClaim: t.writeClaim?.length ? [...new Set(t.writeClaim)] : undefined,
				result: null,
				attempts: 0,
				startedAt: null,
				completedAt: null,
				verified: false,
				verifyResult: null,
				verifyRetries: 0,
				commitHash: null,
				branchName: null,
				rung: undefined,
				escalations: 0,
				failureBriefs: [],
				lastModel: undefined,
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

			// Attach 1–2 keyword-overlapping memory-graph nodes to step context
			// (non-eval only). Best-effort; missing graph is a no-op.
			const projectMemory = loadProjectMemory(ctx.cwd);
			const memoryGraph =
				projectMemory?.graph && typeof projectMemory.graph === "object"
					? (projectMemory.graph as MemoryGraph)
					: null;
			const graphEnrichment = enrichStepsWithMemoryGraph(quest.steps, memoryGraph, quest.goal);
			quest.steps = graphEnrichment.enrichedSteps;

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
							graphEnrichment.summary,
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

			const emitRunEvents = (events: readonly VerifyRunEvent[]) => {
				for (const e of events) recordRun(ctx.cwd, e);
			};

			// Adapter for the pure verify-fail plan (LLM FAIL + deterministic checks).
			// I/O only: beginStepRetry, transitionStep, ledger, claims, persist.
			const applyVerifyFailPlan = (plan: PlanVerifyFailResult) => {
				applyVerifyFailBookkeeping(task, plan.bookkeeping);

				if (plan.kind === "retry") {
					if (!rt.beginStepRetry(ctx, quest, params.index, plan.beginRetryReason)) {
						return textResult("Retry blocked; the owned worktree was retained as evidence.");
					}
					task.attempts = plan.patches.attempts;
					task.startedAt = plan.patches.startedAt;
					task.completedAt = plan.patches.completedAt;
					task.result = plan.patches.result;
					rt.transitionStep(ctx, quest, params.index, plan.nextPhase, plan.transitionReason);
					emitRunEvents(plan.events);
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);
					return {
						content: [{ type: "text" as const, text: plan.messageLines.join("\n") }],
						details: { task, ...plan.details },
					};
				}

				if (plan.kind === "escalate") {
					if (!rt.beginStepRetry(ctx, quest, params.index, plan.beginRetryReason)) {
						return textResult("Escalation blocked; the owned worktree was retained as evidence.");
					}
					task.attempts = plan.patches.attempts;
					task.verifyRetries = plan.patches.verifyRetries;
					task.rung = plan.patches.rung;
					task.escalations = plan.patches.escalations;
					task.startedAt = plan.patches.startedAt;
					task.completedAt = plan.patches.completedAt;
					task.result = plan.patches.result;
					rt.transitionStep(ctx, quest, params.index, plan.nextPhase, plan.transitionReason);
					emitRunEvents(plan.events);
					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					persist(ctx, quest);
					return {
						content: [{ type: "text" as const, text: plan.messageLines.join("\n") }],
						details: { task, ...plan.details },
					};
				}

				// plan.kind === "fail"
				if (!rt.transitionStep(ctx, quest, params.index, plan.nextPhase, plan.transitionReason)) {
					return textResult("Cannot mark failed from the current phase.");
				}
				task.completedAt = plan.patches.completedAt;
				task.result = plan.patches.result;
				emitRunEvents(plan.events);
				recordEval(
					ctx.cwd,
					makeEval(
						quest,
						task,
						params.index,
						plan.evalIntent.status,
						plan.evalIntent.verified,
						plan.evalIntent.evidence,
						plan.evalIntent.failureCode,
					),
				);
				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				claimReg.unregister(ctx.cwd, params.index);
				rt.dispatchGuard.release(ctx.cwd, params.index);
				persist(ctx, quest);
				return {
					content: [{ type: "text" as const, text: plan.messageLines.join("\n") }],
					details: { task, ...plan.details },
				};
			};

			const planFailFrom = (
				evidence: string | undefined,
				inferred: boolean,
				failureCode?: FailureCode,
			) => {
				const ladder = task.rung !== undefined ? loadModelLadder(ctx.cwd) : null;
				return planVerifyFail({
					step: snapshotStepForVerify(task),
					stepIndex: params.index,
					evidence,
					inferred,
					failureCode,
					ladderLength: ladder?.rungs.length ?? 0,
					ladderRungs: ladder?.rungs,
					briefBudget: briefBudgetForModel(
						task.lastModel || task.model ? { id: task.lastModel ?? task.model } : undefined,
						LADDER,
					),
					maxBriefs: LADDER.maxBriefs,
				});
			};

			// ── Verification outcome ──────────────────────────────────────────
			// Explicit verifyOutcome wins; otherwise prose-infer while verifying
			// (see resolveEffectiveOutcome / parseVerifyOutcome).
			const resolved = resolveEffectiveOutcome({
				verifyOutcome: params.verifyOutcome,
				stepStatus: task.status,
				resultText: params.result,
				verifyEvidence: params.verifyEvidence,
			});
			const {
				outcome: effectiveOutcome,
				inferred: inferredOutcome,
				evidence: effectiveEvidence,
			} = resolved;

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

				if (effectiveOutcome === "PASS") {
					const plan = planVerifyPass({
						step: snapshotStepForVerify(task),
						stepIndex: params.index,
						evidence: effectiveEvidence,
						parallelEnabled: Boolean(quest.parallel?.enabled),
					});
					if (!rt.transitionStep(ctx, quest, params.index, plan.nextPhase, plan.transitionReason)) {
						return textResult("Cannot complete from the current phase.");
					}
					task.verifyResult = plan.patches.verifyResult;
					task.verified = plan.patches.verified;
					task.completedAt = plan.patches.completedAt;

					emitRunEvents(plan.events);
					recordEval(
						ctx.cwd,
						makeEval(
							quest,
							task,
							params.index,
							plan.evalIntent.status,
							plan.evalIntent.verified,
							plan.evalIntent.evidence,
						),
					);

					quest.lastFiredStepIndex = -1;
					quest.sameStepCount = 0;
					if (plan.releaseClaims) {
						claimReg.unregister(ctx.cwd, params.index);
						rt.dispatchGuard.release(ctx.cwd, params.index);
					}
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
								text: formatVerifyPassMessage({
									stepIndex: params.index,
									content: task.content,
									evidence: effectiveEvidence,
									progress: `${done}/${quest.steps.length}`,
									nextLabel: next ? `${next.task.content} [${next.task.agent}]` : null,
									gitPrompt,
								}),
							},
						],
						details: {
							task,
							...plan.details,
							progress: `${done}/${quest.steps.length}`,
						},
					};
				}

				// FAIL — shared retry/escalate/auto-fail machine (LLM verdict source).
				// No deterministic check failed: attribute to model quality so eval
				// stats can distinguish soft quality fails from hard check failures.
				return applyVerifyFailPlan(
					planFailFrom(effectiveEvidence, inferredOutcome, "MODEL_QUALITY"),
				);
			}

			// ── Inconclusive while verifying: one re-prompt, then auto-fail ───
			// No structured/prose PASS|FAIL. Prefer machine-readable re-handoff
			// over free-form "try again"; second inconclusive exhausts the budget.
			if (task.status === "verifying") {
				const inconclusivePlan = planVerifyInconclusive({
					step: snapshotStepForVerify(task),
					stepIndex: params.index,
					resultText: params.result,
				});

				if (inconclusivePlan.kind === "reprompt") {
					task.verifyInconclusives = inconclusivePlan.nextInconclusives;
					persist(ctx, quest);

					const team = quest.team ? loadTeams()[quest.team] : null;
					const verifierAgent =
						team?.members.find((m) => m.agent === "verifier" || m.role === "tester")?.agent ??
						"verifier";
					const verificationCwd = task.sandboxArtifacts?.worktreePath ?? ctx.cwd;
					const impactContext = buildVerificationImpactContext(
						ctx.cwd,
						`${task.content}\n${task.context}\n${params.result || task.result || ""}`,
					);
					const sandboxProfile = resolveSandboxProfile(quest.sandbox, task.sandbox);
					const sandboxChecks = buildSandboxComplianceChecks(sandboxProfile);
					const checksSummary = task.evidence ? summarizeChecks(task.evidence.checks) : undefined;
					const handoff = buildVerifierHandoff({
						stepIndex: params.index,
						stepContent: task.content,
						stepContext: task.context,
						stepResult: task.result,
						verifierAgent,
						verificationCwd: task.sandboxArtifacts?.worktreePath ? verificationCwd : undefined,
						evidence: task.evidence,
						impactContext,
						sandboxChecks,
						checksSummary,
						maxVerifyRetries: MAX_VERIFY_RETRIES,
						rePrompt: true,
						previousInconclusive: params.result,
					});
					return {
						content: [{ type: "text" as const, text: handoff.message }],
						details: {
							task,
							...inconclusivePlan.details,
							verifierAgent,
							handoff: handoff.payload,
						},
					};
				}

				// Exhausted re-prompt budget — fail with MODEL_QUALITY.
				if (
					!rt.transitionStep(
						ctx,
						quest,
						params.index,
						inconclusivePlan.nextPhase,
						inconclusivePlan.transitionReason,
					)
				) {
					return textResult("Cannot mark failed from the current phase.");
				}
				task.verifyResult = inconclusivePlan.patches.verifyResult;
				task.verified = inconclusivePlan.patches.verified;
				task.verifyInconclusives = inconclusivePlan.patches.verifyInconclusives;
				task.completedAt = inconclusivePlan.patches.completedAt;
				task.result = inconclusivePlan.patches.result;
				emitRunEvents(inconclusivePlan.events);
				recordEval(
					ctx.cwd,
					makeEval(
						quest,
						task,
						params.index,
						inconclusivePlan.evalIntent.status,
						inconclusivePlan.evalIntent.verified,
						inconclusivePlan.evalIntent.evidence,
						inconclusivePlan.evalIntent.failureCode,
					),
				);
				quest.lastFiredStepIndex = -1;
				quest.sameStepCount = 0;
				claimReg.unregister(ctx.cwd, params.index);
				rt.dispatchGuard.release(ctx.cwd, params.index);
				persist(ctx, quest);
				return {
					content: [{ type: "text" as const, text: inconclusivePlan.messageLines.join("\n") }],
					details: { task, ...inconclusivePlan.details },
				};
			}

			// Persist the child completion payload at the quest_update boundary. Keep
			// task.result unchanged for legacy consumers while downstream steps receive
			// only the bounded structured handoff. (Verifying steps return above.)
			if (params.result) {
				persistHandoff(quest, params.index, params.result);
			}

			// ── Normal completion — check if verification needed ─────────────
			if (params.status === "done" && quest.verifyOnComplete) {
				const team = quest.team ? loadTeams()[quest.team] : null;
				const hasVerifier = team?.verification ?? true;

				if (hasVerifier) {
					if (params.result) task.result = params.result;

					// ── Deterministic gate ──────────────────────────────────────
					// Run the project's own type/lint/format/test checks BEFORE any
					// LLM verifier. A failing check is objective ground truth: the
					// step fails immediately (through the shared fail machine, tagged
					// with a taxonomy code) and no verifier is spawned. Only when the
					// checks pass does the LLM judge what they cannot.
					//
					// Checks run ONLY when the step actually changed files: repo-wide
					// checks reflect the whole tree, so running them on a no-op step
					// (e.g. a research/scout step) would wrongly attribute pre-existing
					// redness to it. With no changes there is nothing to gate — the LLM
					// verifier then judges whether the step should have produced changes.
					if (
						!rt.transitionStep(ctx, quest, params.index, "checking", "running deterministic checks")
					) {
						return textResult("Cannot start checks from the current phase.");
					}
					const verificationCwd = task.sandboxArtifacts?.worktreePath ?? ctx.cwd;
					const diff = collectDiffEvidence(verificationCwd, task.baselineSha ?? null);
					const checkResults =
						VERIFICATION.enabled && diff.changedFiles.length > 0
							? runChecks(planChecks(verificationCwd), verificationCwd)
							: [];
					const evidence: StepEvidence = {
						changedFiles: diff.changedFiles,
						diffStat: diff.diffStat,
						baselineSha: task.baselineSha ?? null,
						checks: checkResults,
						capturedAt: Date.now(),
					};
					task.evidence = evidence;
					const checksSummary = summarizeChecks(checkResults);
					const failed = firstFailure(checkResults);

					if (checkResults.length > 0) {
						recordRun(ctx.cwd, {
							kind: "checks",
							taskIndex: params.index,
							taskContent: task.content,
							agent: task.agent,
							timestamp: Date.now(),
							checksSummary,
							failureCode: failed ? failureCodeForCheck(failed.kind) : undefined,
						});
					}

					if (failed) {
						const evidenceText = [
							`Deterministic ${failed.kind} check failed (\`${failed.command}\`, exit ${failed.exitCode}).`,
							`Checks: ${checksSummary}.`,
							failed.summary ? `Output tail:\n${failed.summary}` : "",
						]
							.filter(Boolean)
							.join("\n");
						const ladder = task.rung !== undefined ? loadModelLadder(ctx.cwd) : null;
						return applyVerifyFailPlan(
							planCheckFail({
								step: snapshotStepForVerify(task),
								stepIndex: params.index,
								evidence: evidenceText,
								failureCode: failureCodeForCheck(failed.kind),
								ladderLength: ladder?.rungs.length ?? 0,
								ladderRungs: ladder?.rungs,
								briefBudget: briefBudgetForModel(
									task.lastModel || task.model ? { id: task.lastModel ?? task.model } : undefined,
									LADDER,
								),
								maxBriefs: LADDER.maxBriefs,
							}),
						);
					}

					if (!rt.transitionStep(ctx, quest, params.index, "verifying", "checks passed")) {
						return textResult("Cannot enter verification from the current phase.");
					}
					// Preserve verifyRetries across same-rung retry attempts. Escalation
					// resets it explicitly, so the budget stays per-rung.
					task.verified = false;
					task.verifyResult = null;
					// Fresh verify entry clears inconclusive re-prompt counter.
					task.verifyInconclusives = 0;

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
					const handoff = buildVerifierHandoff({
						stepIndex: params.index,
						stepContent: task.content,
						stepContext: task.context,
						stepResult: params.result || task.result,
						verifierAgent,
						verificationCwd: task.sandboxArtifacts?.worktreePath ? verificationCwd : undefined,
						evidence,
						impactContext,
						sandboxChecks,
						checksSummary: checkResults.length > 0 ? checksSummary : undefined,
						maxVerifyRetries: MAX_VERIFY_RETRIES,
					});
					return {
						content: [{ type: "text" as const, text: handoff.message }],
						details: {
							task,
							verifying: true,
							verifierAgent,
							checksSummary,
							handoff: handoff.payload,
						},
					};
				}
			}

			// Terminal status without verification gate (or verification disabled).
			const terminal = planTerminalUpdate({
				step: snapshotStepForVerify(task),
				stepIndex: params.index,
				status: params.status,
				result: params.result,
				parallelEnabled: Boolean(quest.parallel?.enabled),
			});
			if (
				!rt.transitionStep(ctx, quest, params.index, terminal.nextPhase, terminal.transitionReason)
			) {
				return textResult(`Invalid phase transition for step #${params.index + 1}.`);
			}

			if (terminal.patches.result !== undefined) task.result = terminal.patches.result;
			if (terminal.patches.completedAt !== undefined) {
				task.completedAt = terminal.patches.completedAt;
			}
			if (terminal.releaseClaims) {
				claimReg.unregister(ctx.cwd, params.index);
				rt.dispatchGuard.release(ctx.cwd, params.index);
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
						text: formatTerminalUpdateMessage({
							stepIndex: params.index,
							content: task.content,
							status: params.status,
							result: params.result,
							progress: `${done}/${total}`,
							nextLabel: next ? `${next.task.content} [${next.task.agent}]` : null,
							questActive: quest.status === "active",
							gitPrompt,
						}),
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
