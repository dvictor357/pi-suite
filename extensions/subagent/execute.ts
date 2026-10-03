import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { substitutePrevious } from "./contract.js";
import { normalizeLimit, RunBudget } from "./budget.js";
import { historyRoot, loadRun, newRunId, planRerun, runStatus, saveRun } from "./history.js";
import { formatWorktreeOutcome } from "./worktree.js";
import {
	DEFAULT_AGENT_TIMEOUT_MS,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	MAX_PIPELINE_ITEMS,
	MAX_RETRIES,
} from "./constants.js";
import {
	type SingleResult,
	type SubagentDetails,
	type SubagentProgress,
	getAnswerText,
	getResultOutput,
	isFailedResult,
	truncateParallelOutput,
} from "./render.js";
import {
	failedResult,
	type IsolationContext,
	prepareIsolation,
	runIsolated,
	validateConcurrentWriteClaims,
} from "./isolation.js";
import {
	type OnUpdateCallback,
	mapWithConcurrencyLimit,
	readSubagentSettings,
	runAgentWithRetry,
} from "./runner.js";
import { SubagentParams } from "./schema.js";

export type SubagentCallParams = Static<typeof SubagentParams>;
/** Tool results also carry the `isError` flag the tool has always returned. */
export type SubagentToolResult = AgentToolResult<SubagentDetails> & {
	isError?: boolean;
};

export function textResult(text: string, details: SubagentDetails): SubagentToolResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

/**
 * Tool entry point: expands `rerun` into concrete params, runs the call, and
 * records it to history. Recording failures never fail the call.
 */
export async function executeWithHistory(
	params: SubagentCallParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
	root = historyRoot(),
): Promise<SubagentToolResult> {
	const emptyDetails: SubagentDetails = {
		mode: "single",
		agentScope: params.agentScope ?? "user",
		projectAgentsDir: null,
		bundledAgentsDir: null,
		results: [],
	};

	let callParams = params;
	let rerunOf: string | undefined;
	let rerunPrefix = "";
	if (params.rerun !== undefined) {
		if (
			params.agent ||
			params.task ||
			params.tasks?.length ||
			params.chain?.length ||
			params.items?.length ||
			params.stages?.length
		)
			return textResult(
				"rerun cannot be combined with agent/task/tasks/chain/items/stages; pass only rerun (plus options to override).",
				emptyDetails,
			);
		let plan: ReturnType<typeof planRerun>;
		try {
			const { rerun, rerunScope, ...overrides } = params;
			const record = loadRun(ctx.cwd, rerun, root);
			plan = planRerun(record, rerunScope ?? "failed", overrides);
			rerunOf = record.id;
		} catch (error) {
			return textResult(error instanceof Error ? error.message : String(error), emptyDetails);
		}
		if ("error" in plan) return textResult(plan.error, emptyDetails);
		callParams = plan.params as SubagentCallParams;
		rerunPrefix = `Re-running ${plan.summary}.\n\n`;
	}

	if (readSubagentSettings().history === false) {
		const result = await runSubagentCall(callParams, signal, onUpdate, ctx);
		return withPrefix(result, rerunPrefix, "");
	}

	const id = newRunId();
	const startedAt = Date.now();
	let lastDetails: SubagentDetails | undefined;
	const trackingUpdate: OnUpdateCallback = (partial) => {
		if (partial.details) lastDetails = partial.details;
		onUpdate?.(partial);
	};

	const record = (
		details: SubagentDetails | undefined,
		outputText: string,
		aborted: boolean,
	): boolean => {
		if (!details || details.results.length === 0) return false;
		try {
			saveRun(
				{
					version: 1,
					id,
					cwd: ctx.cwd,
					startedAt: new Date(startedAt).toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - startedAt,
					mode: details.mode,
					status: runStatus(details.results, aborted),
					params: callParams as Record<string, unknown>,
					outputText,
					results: details.results,
					budget: details.budget,
					rerunOf,
				},
				root,
			);
			return true;
		} catch {
			return false; // history is best-effort
		}
	};

	let result: SubagentToolResult;
	try {
		result = await runSubagentCall(callParams, signal, trackingUpdate, ctx);
	} catch (error) {
		record(lastDetails, error instanceof Error ? error.message : String(error), true);
		throw error;
	}
	const first = result.content[0];
	const saved = record(result.details, first?.type === "text" ? first.text : "", false);
	const failedCount = result.details.results.filter(isFailedResult).length;
	const suffix =
		saved && failedCount > 0
			? `\n\nRun id: ${id}. Re-run the failed work with subagent({ rerun: "${id}" }).`
			: "";
	return withPrefix(result, rerunPrefix, suffix);
}

export function withPrefix(
	result: SubagentToolResult,
	prefix: string,
	suffix: string,
): SubagentToolResult {
	const first = result.content[0];
	if ((!prefix && !suffix) || first?.type !== "text") return result;
	return {
		...result,
		content: [{ ...first, text: `${prefix}${first.text}${suffix}` }, ...result.content.slice(1)],
	};
}

/** Run one subagent tool call (any mode). */
export async function runSubagentCall(
	params: SubagentCallParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): Promise<SubagentToolResult> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const hasPipeline = (params.items?.length ?? 0) > 0 && (params.stages?.length ?? 0) > 0;
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasPipeline);

	const retries = Math.max(0, Math.min(MAX_RETRIES, Math.floor(params.retries ?? 0)));
	const settings = readSubagentSettings();
	const rawTimeoutMs = params.timeoutMs ?? settings.timeoutMs;
	const timeoutMs = Number.isFinite(rawTimeoutMs)
		? Math.max(0, Math.floor(rawTimeoutMs as number))
		: DEFAULT_AGENT_TIMEOUT_MS;
	const onError: "stop" | "continue" = params.onError === "continue" ? "continue" : "stop";
	// Explicit 0 disables a cap configured in settings.json.
	const budget = new RunBudget({
		maxCost: normalizeLimit(params.maxCost ?? settings.maxCost),
		maxTokens: normalizeLimit(params.maxTokens ?? settings.maxTokens),
	});
	const budgetNote = () =>
		budget.exceeded
			? `\n\n${budget.exceededReason}. Remaining work was stopped or skipped; results above are partial.`
			: "";

	const makeDetails =
		(mode: "single" | "parallel" | "chain" | "pipeline") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			bundledAgentsDir: discovery.bundledAgentsDir,
			results,
			...(budget.enabled ? { budget: budget.snapshot() } : {}),
		});

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single")([]),
		};
	}

	let isolation: IsolationContext | null = null;
	let isolationNote = "";
	if (params.isolation === "worktree") {
		if (hasChain || hasPipeline)
			return {
				content: [
					{
						type: "text",
						text: 'isolation "worktree" supports single and parallel modes only.',
					},
				],
				details: makeDetails(hasChain ? "chain" : "pipeline")([]),
				isError: true,
			};
		const prepared = await prepareIsolation(ctx.cwd);
		if ("error" in prepared)
			return {
				content: [{ type: "text", text: prepared.error }],
				details: makeDetails(hasTasks ? "parallel" : "single")([]),
				isError: true,
			};
		isolation = prepared.context;
		if (prepared.dirty)
			isolationNote = `\n\nNote: worktrees start from HEAD (${prepared.context.baseRef.slice(0, 12)}); uncommitted changes in the main checkout were not visible to isolated agents.`;
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.stages) for (const s of params.stages) requestedAgentNames.add(s.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					content: [
						{
							type: "text",
							text: "Canceled: project-local agents not approved.",
						},
					],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
				};
		}
	}

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";
		let previousStructured: unknown;

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const substituted = substitutePrevious(step.task, previousOutput, previousStructured);

			// Create update callback that includes all previous results
			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						// Combine completed results with current streaming result
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							const allResults = [...results, currentResult];
							onUpdate({
								content: partial.content,
								details: {
									...makeDetails("chain")(allResults),
									progress: partial.details?.progress,
								},
							});
						}
					}
				: undefined;

			// A bad {previous.path} fails the step without spawning anything.
			const result = !substituted.ok
				? {
						...failedResult(step.agent, step.task, substituted.error),
						step: i + 1,
					}
				: await runAgentWithRetry(
						ctx.cwd,
						agents,
						step.agent,
						substituted.text,
						step.cwd,
						{
							model: step.model,
							thinking: step.thinking,
							output: step.output,
						},
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						retries,
						timeoutMs,
						undefined,
						budget,
					);
			results.push(result);

			const isError = isFailedResult(result);
			if (isError && onError === "stop") {
				const errorMsg = getResultOutput(result);
				return {
					content: [
						{
							type: "text",
							text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${budgetNote()}`,
						},
					],
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			// onError === "continue" (or success): pass this step's output forward.
			previousOutput = isError ? getResultOutput(result) : getAnswerText(result);
			previousStructured = isError ? undefined : result.structured;
		}
		return {
			content: [
				{
					type: "text",
					text: `${getResultOutput(results[results.length - 1])}${budgetNote()}`,
				},
			],
			details: makeDetails("chain")(results),
		};
	}

	if (params.tasks && params.tasks.length > 0) {
		// Worktrees give every writer its own checkout, so claims are moot.
		const claimError = isolation
			? null
			: validateConcurrentWriteClaims(
					ctx.cwd,
					params.tasks.map((task, index) => ({
						...task,
						label: `parallel task #${index + 1} (${task.agent})`,
						sequentialGroup: index,
					})),
				);
		if (claimError)
			return {
				content: [{ type: "text", text: `Write ownership rejected: ${claimError}` }],
				details: makeDetails("parallel")([]),
				isError: true,
			};

		if (params.tasks.length > MAX_PARALLEL_TASKS)
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: makeDetails("parallel")([]),
			};

		// Track all results for streaming updates
		const allResults: SingleResult[] = new Array(params.tasks.length);

		// Initialize placeholder results
		for (let i = 0; i < params.tasks.length; i++) {
			allResults[i] = {
				agent: params.tasks[i].agent,
				agentSource: "unknown",
				task: params.tasks[i].task,
				exitCode: -1, // -1 = still running
				messages: [],
				stderr: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
			};
		}

		let lastProgress: SubagentProgress | undefined;

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [
						{
							type: "text",
							text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
						},
					],
					details: {
						...makeDetails("parallel")([...allResults]),
						progress: lastProgress,
					},
				});
			}
		};

		const results = await mapWithConcurrencyLimit(
			params.tasks,
			MAX_CONCURRENCY,
			async (t, index) => {
				const result = await runIsolated(
					isolation,
					index,
					agents,
					t.agent,
					t.task,
					ctx.cwd,
					t.cwd,
					(cwd) =>
						runAgentWithRetry(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							cwd,
							{
								model: t.model,
								thinking: t.thinking,
								output: t.output,
							},
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									lastProgress = partial.details?.progress;
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							retries,
							timeoutMs,
							undefined,
							budget,
						),
				);
				allResults[index] = result;
				emitParallelUpdate();
				return result;
			},
		);

		const successCount = results.filter((r) => !isFailedResult(r)).length;
		const summaries = results.map((r) => {
			const output = truncateParallelOutput(getResultOutput(r));
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			const worktree = r.worktree ? `\n\n${formatWorktreeOutcome(r.worktree)}` : "";
			return `### [${r.agent}] ${status}\n\n${output}${worktree}`;
		});
		return {
			content: [
				{
					type: "text",
					text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${isolationNote}${budgetNote()}`,
				},
			],
			details: makeDetails("parallel")(results),
		};
	}

	if (hasPipeline && params.items && params.stages) {
		const items = params.items;
		const stages = params.stages;
		const claimError = validateConcurrentWriteClaims(
			ctx.cwd,
			items.flatMap((item, itemIndex) =>
				stages.map((stage, stageIndex) => ({
					...stage,
					readClaim: stage.readClaim?.map((claim) => claim.replace(/\{item\}/g, item)),
					writeClaim: stage.writeClaim?.map((claim) => claim.replace(/\{item\}/g, item)),
					label: `pipeline item #${itemIndex + 1}, stage #${stageIndex + 1} (${stage.agent})`,
					sequentialGroup: itemIndex,
				})),
			),
		);
		if (claimError)
			return {
				content: [{ type: "text", text: `Write ownership rejected: ${claimError}` }],
				details: makeDetails("pipeline")([]),
				isError: true,
			};

		if (items.length > MAX_PIPELINE_ITEMS)
			return {
				content: [
					{
						type: "text",
						text: `Too many pipeline items (${items.length}). Max is ${MAX_PIPELINE_ITEMS}.`,
					},
				],
				details: makeDetails("pipeline")([]),
			};

		// One slot per item, holding that item's latest stage result (for
		// streaming) and ultimately its final-stage result.
		const allResults: SingleResult[] = new Array(items.length);
		for (let i = 0; i < items.length; i++) {
			allResults[i] = {
				agent: stages[0].agent,
				agentSource: "unknown",
				task: items[i],
				exitCode: -1, // still running
				messages: [],
				stderr: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
			};
		}

		let lastPipelineProgress: SubagentProgress | undefined;

		const emitPipelineUpdate = () => {
			if (!onUpdate) return;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			const running = allResults.length - done;
			onUpdate({
				content: [
					{
						type: "text",
						text: `Pipeline: ${done}/${items.length} done, ${running} running...`,
					},
				],
				details: {
					...makeDetails("pipeline")([...allResults]),
					progress: lastPipelineProgress,
				},
			});
		};

		// Each item runs its OWN sequential chain through the stages; items run
		// concurrently with no barrier between stages — item B can be in stage 1
		// while item A is already in stage 3.
		const finals = await mapWithConcurrencyLimit(items, MAX_CONCURRENCY, async (item, idx) => {
			let previous = "";
			let previousStructured: unknown;
			let last: SingleResult | null = null;
			for (let s = 0; s < stages.length; s++) {
				const stage = stages[s];
				const substituted = substitutePrevious(
					stage.task.replace(/\{item\}/g, item),
					previous,
					previousStructured,
				);
				const r = !substituted.ok
					? {
							...failedResult(stage.agent, stage.task, substituted.error),
							step: s + 1,
						}
					: await runAgentWithRetry(
							ctx.cwd,
							agents,
							stage.agent,
							substituted.text,
							stage.cwd,
							{
								model: stage.model,
								thinking: stage.thinking,
								output: stage.output,
							},
							s + 1,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[idx] = partial.details.results[0];
									lastPipelineProgress = partial.details?.progress;
									emitPipelineUpdate();
								}
							},
							makeDetails("pipeline"),
							retries,
							timeoutMs,
							undefined,
							budget,
						);
				last = r;
				allResults[idx] = r;
				emitPipelineUpdate();
				if (isFailedResult(r)) {
					if (onError === "continue") {
						previous = getResultOutput(r);
						previousStructured = undefined;
						continue;
					}
					break; // stop this item's chain
				}
				previous = getAnswerText(r);
				previousStructured = r.structured;
			}
			return last as SingleResult;
		});

		const successCount = finals.filter((r) => r && !isFailedResult(r)).length;
		const summaries = finals.map((r, i) => {
			const output = truncateParallelOutput(getResultOutput(r));
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			const label = items[i].length > 50 ? `${items[i].slice(0, 50)}…` : items[i];
			return `### [${label}] ${status}\n\n${output}`;
		});
		return {
			content: [
				{
					type: "text",
					text: `Pipeline: ${successCount}/${finals.length} items succeeded (${stages.length} stages each)\n\n${summaries.join("\n\n---\n\n")}${budgetNote()}`,
				},
			],
			details: makeDetails("pipeline")(finals),
		};
	}

	if (params.agent && params.task) {
		const agentName = params.agent;
		const task = params.task;
		const result = await runIsolated(
			isolation,
			0,
			agents,
			agentName,
			task,
			ctx.cwd,
			params.cwd,
			(cwd) =>
				runAgentWithRetry(
					ctx.cwd,
					agents,
					agentName,
					task,
					cwd,
					{
						model: params.model,
						thinking: params.thinking,
						output: params.output,
					},
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					retries,
					timeoutMs,
					undefined,
					budget,
				),
		);
		const worktreeText = result.worktree
			? `\n\n${formatWorktreeOutcome(result.worktree)}${isolationNote}`
			: "";
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [
					{
						type: "text",
						text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${worktreeText}${budgetNote()}`,
					},
				],
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `${getAnswerText(result) || "(no output)"}${worktreeText}`,
				},
			],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [
			{
				type: "text",
				text: `Invalid parameters. Available agents: ${available}`,
			},
		],
		details: makeDetails("single")([]),
	};
}
