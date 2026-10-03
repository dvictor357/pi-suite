import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { normalizeLimit, RunBudget } from "./budget.js";
import { historyRoot, loadRun, newRunId, planRerun, runStatus, saveRun } from "./history.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_RETRIES } from "./constants.js";
import { type SingleResult, type SubagentDetails, isFailedResult } from "./render.js";
import { type IsolationContext, prepareIsolation } from "./isolation.js";
import { type OnUpdateCallback, readSubagentSettings } from "./runner.js";
import { SubagentParams } from "./schema.js";
import {
	type CallMode,
	type CallScope,
	runChainMode,
	runParallelMode,
	runPipelineMode,
	runSingleMode,
} from "./modes.js";

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

	const makeDetails =
		(mode: CallMode) =>
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

	const scope: CallScope = {
		ctx,
		agents,
		signal,
		onUpdate,
		retries,
		timeoutMs,
		onError,
		budget,
		isolation,
		isolationNote,
		makeDetails,
	};
	if (params.chain && params.chain.length > 0) return runChainMode(scope, params.chain);
	if (params.tasks && params.tasks.length > 0) return runParallelMode(scope, params.tasks);
	if (hasPipeline && params.items && params.stages)
		return runPipelineMode(scope, params.items, params.stages);
	if (params.agent && params.task) return runSingleMode(scope, params.agent, params.task, params);

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
