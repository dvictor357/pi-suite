/**
 * Per-mode runners for one subagent tool call. `runSubagentCall` (execute.ts)
 * resolves the shared call state into a {@link CallScope} — agents, limits,
 * budget, isolation — then hands it to exactly one of these.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { RunBudget } from "./budget.js";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, MAX_PIPELINE_ITEMS } from "./constants.js";
import { substitutePrevious } from "./contract.js";
import type { SubagentCallParams, SubagentToolResult } from "./execute.js";
import {
	failedResult,
	type IsolationContext,
	runIsolated,
	validateConcurrentWriteClaims,
} from "./isolation.js";
import {
	getAnswerText,
	getResultOutput,
	isFailedResult,
	type SingleResult,
	type SubagentDetails,
	type SubagentProgress,
	truncateParallelOutput,
} from "./render.js";
import {
	mapWithConcurrencyLimit,
	type OnUpdateCallback,
	type RuntimeOverride,
	runAgentWithRetry,
} from "./runner.js";
import { formatWorktreeOutcome } from "./worktree.js";

export type CallMode = "single" | "parallel" | "chain" | "pipeline";

/** Call-wide state shared by every mode runner. */
export interface CallScope {
	ctx: ExtensionContext;
	agents: AgentConfig[];
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	retries: number;
	timeoutMs: number;
	onError: "stop" | "continue";
	budget: RunBudget;
	/** Worktree isolation context; null when running in the main checkout. */
	isolation: IsolationContext | null;
	/** Note appended when isolated agents could not see uncommitted changes. */
	isolationNote: string;
	makeDetails: (mode: CallMode) => (results: SingleResult[]) => SubagentDetails;
}

type ChainStep = NonNullable<SubagentCallParams["chain"]>[number];
type ParallelTask = NonNullable<SubagentCallParams["tasks"]>[number];
type PipelineStage = NonNullable<SubagentCallParams["stages"]>[number];

function budgetNote(scope: CallScope): string {
	return scope.budget.exceeded
		? `\n\n${scope.budget.exceededReason}. Remaining work was stopped or skipped; results above are partial.`
		: "";
}

/** Run one agent with the call's retries, timeout, budget, and signal. */
function runAgent(
	scope: CallScope,
	mode: CallMode,
	agent: string,
	task: string,
	cwd: string | undefined,
	runtime: RuntimeOverride,
	step: number | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
	return runAgentWithRetry(
		scope.ctx.cwd,
		scope.agents,
		agent,
		task,
		cwd,
		runtime,
		step,
		scope.signal,
		onUpdate,
		scope.makeDetails(mode),
		scope.retries,
		scope.timeoutMs,
		undefined,
		scope.budget,
	);
}

/** Placeholder for a slot whose agent has not reported yet. */
function pendingResult(agent: string, task: string): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task,
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

function statusLabel(r: SingleResult): string {
	return isFailedResult(r)
		? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
		: "completed";
}

export async function runChainMode(
	scope: CallScope,
	chain: ChainStep[],
): Promise<SubagentToolResult> {
	const { onUpdate, makeDetails } = scope;
	const results: SingleResult[] = [];
	let previousOutput = "";
	let previousStructured: unknown;

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
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
			: await runAgent(
					scope,
					"chain",
					step.agent,
					substituted.text,
					step.cwd,
					{ model: step.model, thinking: step.thinking, output: step.output },
					i + 1,
					chainUpdate,
				);
		results.push(result);

		const isError = isFailedResult(result);
		if (isError && scope.onError === "stop") {
			const errorMsg = getResultOutput(result);
			return {
				content: [
					{
						type: "text",
						text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${budgetNote(scope)}`,
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
				text: `${getResultOutput(results[results.length - 1])}${budgetNote(scope)}`,
			},
		],
		details: makeDetails("chain")(results),
	};
}

export async function runParallelMode(
	scope: CallScope,
	tasks: ParallelTask[],
): Promise<SubagentToolResult> {
	const { ctx, onUpdate, makeDetails, isolation } = scope;
	// Worktrees give every writer its own checkout, so claims are moot.
	const claimError = isolation
		? null
		: validateConcurrentWriteClaims(
				ctx.cwd,
				tasks.map((task, index) => ({
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

	if (tasks.length > MAX_PARALLEL_TASKS)
		return {
			content: [
				{
					type: "text",
					text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				},
			],
			details: makeDetails("parallel")([]),
		};

	// Track all results for streaming updates
	const allResults: SingleResult[] = tasks.map((t) => pendingResult(t.agent, t.task));
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

	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const result = await runIsolated(
			isolation,
			index,
			scope.agents,
			t.agent,
			t.task,
			ctx.cwd,
			t.cwd,
			(cwd) =>
				runAgent(
					scope,
					"parallel",
					t.agent,
					t.task,
					cwd,
					{ model: t.model, thinking: t.thinking, output: t.output },
					undefined,
					// Per-task update callback
					(partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							lastProgress = partial.details?.progress;
							emitParallelUpdate();
						}
					},
				),
		);
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		const worktree = r.worktree ? `\n\n${formatWorktreeOutcome(r.worktree)}` : "";
		return `### [${r.agent}] ${statusLabel(r)}\n\n${output}${worktree}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${scope.isolationNote}${budgetNote(scope)}`,
			},
		],
		details: makeDetails("parallel")(results),
	};
}

export async function runPipelineMode(
	scope: CallScope,
	items: string[],
	stages: PipelineStage[],
): Promise<SubagentToolResult> {
	const { ctx, onUpdate, makeDetails } = scope;
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
	const allResults: SingleResult[] = items.map((item) => pendingResult(stages[0].agent, item));
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
				: await runAgent(
						scope,
						"pipeline",
						stage.agent,
						substituted.text,
						stage.cwd,
						{ model: stage.model, thinking: stage.thinking, output: stage.output },
						s + 1,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[idx] = partial.details.results[0];
								lastPipelineProgress = partial.details?.progress;
								emitPipelineUpdate();
							}
						},
					);
			last = r;
			allResults[idx] = r;
			emitPipelineUpdate();
			if (isFailedResult(r)) {
				if (scope.onError === "continue") {
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
		const label = items[i].length > 50 ? `${items[i].slice(0, 50)}…` : items[i];
		return `### [${label}] ${statusLabel(r)}\n\n${output}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Pipeline: ${successCount}/${finals.length} items succeeded (${stages.length} stages each)\n\n${summaries.join("\n\n---\n\n")}${budgetNote(scope)}`,
			},
		],
		details: makeDetails("pipeline")(finals),
	};
}

export async function runSingleMode(
	scope: CallScope,
	agentName: string,
	task: string,
	params: SubagentCallParams,
): Promise<SubagentToolResult> {
	const { ctx, makeDetails } = scope;
	const result = await runIsolated(
		scope.isolation,
		0,
		scope.agents,
		agentName,
		task,
		ctx.cwd,
		params.cwd,
		(cwd) =>
			runAgent(
				scope,
				"single",
				agentName,
				task,
				cwd,
				{ model: params.model, thinking: params.thinking, output: params.output },
				undefined,
				scope.onUpdate,
			),
	);
	const worktreeText = result.worktree
		? `\n\n${formatWorktreeOutcome(result.worktree)}${scope.isolationNote}`
		: "";
	if (isFailedResult(result)) {
		const errorMsg = getResultOutput(result);
		return {
			content: [
				{
					type: "text",
					text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${worktreeText}${budgetNote(scope)}`,
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
