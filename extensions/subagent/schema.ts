import { THINKING_LEVELS as THINKING_LEVEL_VALUES } from "../../core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_RETRIES } from "./constants.js";

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(Type.String({ description: "Model override for this invocation" })),
	output: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema the agent's final answer must satisfy (overrides the agent's frontmatter output). The answer is validated, repaired once if needed, and passed on as JSON; later steps can use {previous.field}.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVEL_VALUES, {
			description: "Thinking override for this invocation",
		}),
	),
	readClaim: Type.Optional(Type.Array(Type.String(), { description: "Paths this task reads" })),
	writeClaim: Type.Optional(Type.Array(Type.String(), { description: "Paths this task writes" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const PipelineStage = Type.Object({
	agent: Type.String({ description: "Name of the agent for this stage" }),
	task: Type.String({
		description:
			"Stage instruction. {item} = the current item; {previous} = prior stage's output for this item.",
	}),
	model: Type.Optional(Type.String({ description: "Model override for this stage" })),
	output: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema the agent's final answer must satisfy (overrides the agent's frontmatter output). The answer is validated, repaired once if needed, and passed on as JSON; later steps can use {previous.field}.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVEL_VALUES, {
			description: "Thinking override for this stage",
		}),
	),
	readClaim: Type.Optional(
		Type.Array(Type.String(), {
			description: "Paths this stage reads; {item} is expanded",
		}),
	),
	writeClaim: Type.Optional(
		Type.Array(Type.String(), {
			description: "Paths this stage writes; {item} is expanded",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	output: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema the agent's final answer must satisfy (overrides the agent's frontmatter output). The answer is validated, repaired once if needed, and passed on as JSON; later steps can use {previous.field}.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVEL_VALUES, {
			description: "Thinking override for this step",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	model: Type.Optional(Type.String({ description: "Model override for single mode" })),
	output: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema the agent's final answer must satisfy (overrides the agent's frontmatter output). The answer is validated, repaired once if needed, and passed on as JSON; later steps can use {previous.field}.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVEL_VALUES, {
			description: "Thinking override for single mode",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	items: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Pipeline mode: list of items. Each item flows through every `stages` step independently (no barrier between stages — item B can be in stage 1 while item A is in stage 3). Requires `stages`.",
		}),
	),
	stages: Type.Optional(
		Type.Array(PipelineStage, {
			description: "Pipeline mode: ordered stages each item passes through. Use with `items`.",
		}),
	),
	retries: Type.Optional(
		Type.Number({
			description: `Retry a failed subagent up to N times (transient failures only). Default 0. Max ${MAX_RETRIES}.`,
			default: 0,
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Maximum runtime per subagent attempt in milliseconds. Default comes from settings.json subagent.timeoutMs or 180000. Use 0 to disable.",
			default: DEFAULT_AGENT_TIMEOUT_MS,
		}),
	),
	maxCost: Type.Optional(
		Type.Number({
			description:
				"USD spend cap for this whole call (all subagents, retries, and steps). When reached, running subagents are stopped and queued ones skipped; results are partial. Checked after each model turn, so in-flight turns can overshoot slightly. Default from settings.json subagent.maxCost; 0 disables.",
		}),
	),
	maxTokens: Type.Optional(
		Type.Number({
			description:
				"Input+output token cap for this whole call (cache reads/writes not counted). Same behavior as maxCost. Default from settings.json subagent.maxTokens; 0 disables.",
		}),
	),
	onError: Type.Optional(
		StringEnum(["stop", "continue"] as const, {
			description:
				"For chain/pipeline: on a step failure, 'stop' (default) halts; 'continue' passes the error output forward and proceeds.",
			default: "stop",
		}),
	),
	isolation: Type.Optional(
		StringEnum(["none", "worktree"] as const, {
			description:
				"Single/parallel only. 'worktree' runs each writer agent in its own git worktree from HEAD; changes are committed to a pi-minions/<run>/<n>-<agent> branch for review/merge, and writeClaim is not required. Read-only agents run in place. Uncommitted changes in the main checkout are NOT visible to isolated agents. Default 'none'.",
			default: "none",
		}),
	),
	rerun: Type.Optional(
		Type.String({
			description:
				"Re-run a recorded run by id (or unique id prefix) instead of passing a mode. By default only failed work is redone: failed parallel tasks, failed pipeline items, or a chain resumed from its first failed step with the stored {previous}. Other params given alongside (retries, maxCost, isolation, …) override the stored ones.",
		}),
	),
	rerunScope: Type.Optional(
		StringEnum(["failed", "all"] as const, {
			description:
				"With rerun: 'failed' (default) redoes only failed/unfinished work; 'all' repeats the whole call.",
			default: "failed",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

/** Codebase tool operation enum. Exported for schema testing. */
export const CodebaseOperation = StringEnum(["scan", "query", "map", "impact"] as const, {
	description:
		"Operation: scan (re-index), query (find files), map (deps), impact (transitive reverse deps)",
});

/** Codebase tool parameter schema. Exported for testing. */
export const CodebaseParams = Type.Object({
	operation: Type.Optional(CodebaseOperation),
	pattern: Type.Optional(
		Type.String({
			description:
				"Search pattern for query operation (matched against file paths, symbols, exports)",
		}),
	),
	file: Type.Optional(
		Type.String({
			description: "File relative path for map/impact operations",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "Force a full re-scan instead of using the cache",
			default: false,
		}),
	),
});
