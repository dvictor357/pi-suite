/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Pipeline: { items: [...], stages: [{ agent, task: "... {item} ..." }, ...] }
 *
 * Single and parallel modes can run writer agents in isolated git worktrees
 * (`isolation: "worktree"`); see ./worktree.ts.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import {
	loadAgentModels as loadQuestAgentModels,
	THINKING_LEVELS as THINKING_LEVEL_VALUES,
} from "../../core";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import {
	allFiles,
	depMap,
	getImpact,
	indexSummary,
	queryFiles,
	scanIndex,
} from "./codebase/query.js";
import type { IndexData } from "./codebase/types.js";
import {
	checkContract,
	contractInstructions,
	formatStructured,
	type JsonSchema,
	repairTask,
	substitutePrevious,
} from "./contract.js";
import { type BudgetSnapshot, formatBudget, normalizeLimit, RunBudget } from "./budget.js";
import {
	formatRunDetail,
	formatRunList,
	historyRoot,
	listRuns,
	loadRun,
	newRunId,
	planRerun,
	runStatus,
	saveRun,
} from "./history.js";
import {
	createWorktree,
	finalizeWorktree,
	findRepoRoot,
	formatWorktreeOutcome,
	hasUncommittedChanges,
	mapCwdIntoWorktree,
	resolveHead,
	worktreeBranchName,
	type WorktreeOutcome,
} from "./worktree.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_PIPELINE_ITEMS = 16;
const MAX_RETRIES = 3;
const DEFAULT_AGENT_TIMEOUT_MS = 3 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const HEARTBEAT_MS = 2000;

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return `${min}m${rem}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep":
		case "ffgrep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", `${toolName} `) +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "fffind": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "fffind ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Present when the task ran in an isolated git worktree. */
	worktree?: WorktreeOutcome;
	/** Validated JSON answer when the run had an output contract. */
	structured?: unknown;
}

type SubagentPhase =
	| "queued"
	| "starting"
	| "running"
	| "tool_call"
	| "retrying"
	| "completed"
	| "failed"
	| "aborted";

interface SubagentProgress {
	runId: string;
	phase: SubagentPhase;
	activity: string;
	agent: string;
	step?: number;
	attempt: number;
	maxAttempts: number;
	elapsedMs: number;
	currentTool?: string;
	currentPath?: string;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "pipeline";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	bundledAgentsDir: string | null;
	results: SingleResult[];
	progress?: SubagentProgress;
	/** Spend against maxCost/maxTokens; present when a cap is set. */
	budget?: BudgetSnapshot;
}

export type { SubagentProgress };

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "budget" ||
		result.stopReason === "invalid_output"
	);
}

/** A result's answer as text: canonical JSON when it had a contract. */
function getAnswerText(result: SingleResult): string {
	return result.structured !== undefined
		? formatStructured(result.structured)
		: getFinalOutput(result.messages);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getAnswerText(result) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

function safePath(p: unknown): string | undefined {
	if (typeof p !== "string" || !p) return undefined;
	const home = os.homedir();
	const shortened = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	return shortened;
}

export function buildToolActivity(
	name: string,
	args: Record<string, unknown>,
): { activity: string; currentTool: string; currentPath?: string } {
	const currentTool = name;
	switch (name) {
		case "bash":
			return { activity: "running command", currentTool };
		case "read": {
			const p = safePath(args.path ?? args.file_path);
			return {
				activity: `reading ${p ?? "file"}`,
				currentTool,
				currentPath: p,
			};
		}
		case "write": {
			const p = safePath(args.path ?? args.file_path);
			return {
				activity: `writing ${p ?? "file"}`,
				currentTool,
				currentPath: p,
			};
		}
		case "edit": {
			const p = safePath(args.path ?? args.file_path);
			return {
				activity: `editing ${p ?? "file"}`,
				currentTool,
				currentPath: p,
			};
		}
		case "ls": {
			const p = safePath(args.path);
			return {
				activity: `listing ${p ?? "directory"}`,
				currentTool,
				currentPath: p,
			};
		}
		case "find":
		case "fffind": {
			const p = safePath(args.path);
			return {
				activity: `finding in ${p ?? "directory"}`,
				currentTool,
				currentPath: p,
			};
		}
		case "grep":
		case "ffgrep": {
			const p = safePath(args.path);
			return {
				activity: `searching in ${p ?? "directory"}`,
				currentTool,
				currentPath: p,
			};
		}
		default:
			return { activity: `${name}`, currentTool };
	}
}

export function buildProgressPayload(options: {
	runId: string;
	phase: SubagentPhase;
	agent: string;
	attempt: number;
	maxAttempts: number;
	startTime: number;
	step?: number;
	activity?: string;
	currentTool?: string;
	currentPath?: string;
}): SubagentProgress {
	return {
		runId: options.runId,
		phase: options.phase,
		activity: options.activity || `${options.phase}...`,
		agent: options.agent,
		step: options.step,
		attempt: options.attempt,
		maxAttempts: options.maxAttempts,
		elapsedMs: Date.now() - options.startTime,
		currentTool: options.currentTool,
		currentPath: options.currentPath,
	};
}

const READ_ONLY_AGENTS = new Set(["scout", "planner", "reviewer", "verifier"]);
const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

/** Read-only agents never need a worktree: known read-only names, or an
 *  explicit tool list with no way to modify files. */
function isReadOnlyAgent(agentName: string, agents: AgentConfig[]): boolean {
	if (READ_ONLY_AGENTS.has(agentName.trim().toLowerCase())) return true;
	const tools = agents.find((a) => a.name === agentName)?.tools;
	return (
		tools !== undefined &&
		tools.length > 0 &&
		!tools.some((t) => WRITE_TOOLS.has(t.trim().toLowerCase()))
	);
}

function failedResult(agentName: string, task: string, message: string): SingleResult {
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: message,
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

export interface IsolationContext {
	repoRoot: string;
	baseRef: string;
	/** Short id shared by every branch created in one tool call. */
	runId: string;
}

/**
 * Prepare worktree isolation for one tool call. Returns an error message when
 * the caller's cwd cannot be isolated (not a git repo, no commits).
 */
export async function prepareIsolation(
	cwd: string,
): Promise<{ context: IsolationContext; dirty: boolean } | { error: string }> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot)
		return {
			error: `isolation "worktree" requires a git repository, but ${cwd} is not inside one`,
		};
	try {
		const baseRef = await resolveHead(repoRoot);
		const dirty = await hasUncommittedChanges(repoRoot);
		const runId = crypto.randomUUID().slice(0, 8);
		return { context: { repoRoot, baseRef, runId }, dirty };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Run a task in its own worktree when isolation is on and the agent can write.
 * Changes are committed to a per-task branch even if the run fails or aborts,
 * so partial work stays inspectable.
 */
export async function runIsolated(
	isolation: IsolationContext | null,
	index: number,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	defaultCwd: string,
	taskCwd: string | undefined,
	run: (cwd: string | undefined) => Promise<SingleResult>,
): Promise<SingleResult> {
	if (!isolation || isReadOnlyAgent(agentName, agents)) return run(taskCwd);

	let handle: Awaited<ReturnType<typeof createWorktree>>;
	let isolatedCwd: string;
	try {
		// Validate before creating anything so a bad cwd leaves no worktree behind.
		mapCwdIntoWorktree(isolation.repoRoot, isolation.repoRoot, defaultCwd, taskCwd);
		handle = await createWorktree(
			isolation.repoRoot,
			isolation.baseRef,
			worktreeBranchName(isolation.runId, index, agentName),
		);
		isolatedCwd = mapCwdIntoWorktree(isolation.repoRoot, handle.path, defaultCwd, taskCwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failedResult(agentName, task, `Worktree setup failed: ${message}`);
	}

	let result: SingleResult | undefined;
	try {
		result = await run(isolatedCwd);
		return result;
	} finally {
		const outcome = await finalizeWorktree(
			handle,
			`pi-minions: ${agentName} task #${index + 1}\n\n${task.slice(0, 2000)}`,
		);
		if (result) result.worktree = outcome;
	}
}

interface ClaimParticipant {
	agent: string;
	cwd?: string;
	readClaim?: string[];
	writeClaim?: string[];
	/** Participants in the same sequential group cannot overlap in time. */
	sequentialGroup?: number;
	label: string;
}

function canonicalPath(raw: string, cwd: string): string {
	if (!raw.trim()) throw new Error("claim paths must not be empty");
	const absolute = path.resolve(cwd, raw);
	let ancestor = absolute;
	while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
		ancestor = path.dirname(ancestor);
	}
	let resolved = absolute;
	try {
		resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
	} catch {
		// The lexical path is still checked against cwd below.
	}
	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`claim path ${JSON.stringify(raw)} escapes working directory ${cwd}`);
	}
	return resolved;
}

function pathsOverlap(a: string, b: string): boolean {
	const rel = path.relative(a, b);
	const reverse = path.relative(b, a);
	return (
		rel === "" ||
		(!rel.startsWith("..") && !path.isAbsolute(rel)) ||
		(!reverse.startsWith("..") && !path.isAbsolute(reverse))
	);
}

/** Validate all processes that may run concurrently before spawning any child. */
export function validateConcurrentWriteClaims(
	defaultCwd: string,
	participants: ClaimParticipant[],
): string | null {
	try {
		const normalized = participants.map((participant) => {
			const cwd = fs.existsSync(participant.cwd ?? defaultCwd)
				? fs.realpathSync(participant.cwd ?? defaultCwd)
				: path.resolve(participant.cwd ?? defaultCwd);
			const read = [...new Set((participant.readClaim ?? []).map((p) => canonicalPath(p, cwd)))];
			const write = [...new Set((participant.writeClaim ?? []).map((p) => canonicalPath(p, cwd)))];
			if (READ_ONLY_AGENTS.has(participant.agent.trim().toLowerCase()) && write.length > 0) {
				throw new Error(
					`${participant.label} uses read-only agent "${participant.agent}" and cannot declare writeClaim`,
				);
			}
			return { ...participant, cwd, read, write };
		});

		for (let i = 0; i < normalized.length; i++) {
			const a = normalized[i];
			if (READ_ONLY_AGENTS.has(a.agent.trim().toLowerCase())) continue;
			for (let j = i + 1; j < normalized.length; j++) {
				const b = normalized[j];
				if (
					READ_ONLY_AGENTS.has(b.agent.trim().toLowerCase()) ||
					(a.sequentialGroup !== undefined && a.sequentialGroup === b.sequentialGroup)
				) {
					continue;
				}
				if (a.cwd !== b.cwd && (a.write.length === 0 || b.write.length === 0)) continue;
				if (a.write.length === 0 || b.write.length === 0) {
					throw new Error(
						`${a.label} and ${b.label} may write concurrently in ${a.cwd}; declare non-empty disjoint writeClaim arrays or run them in isolated cwd directories`,
					);
				}
				for (const left of a.write) {
					for (const right of b.write) {
						if (pathsOverlap(left, right)) {
							throw new Error(
								`${a.label} and ${b.label} have overlapping write claims: ${left} ↔ ${right}; use disjoint paths or isolated cwd directories`,
							);
						}
					}
				}
			}
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

type AbortKillProcess = {
	kill(signal: NodeJS.Signals): unknown;
	on(event: "close", listener: () => void): unknown;
};

export function attachAbortKillFallback(
	proc: AbortKillProcess,
	signal: AbortSignal,
	onAbort: () => void,
	killDelayMs = 5000,
): void {
	let closed = false;
	let killTimeout: ReturnType<typeof setTimeout> | null = null;

	proc.on("close", () => {
		closed = true;
		if (killTimeout) {
			clearTimeout(killTimeout);
			killTimeout = null;
		}
	});

	const killProc = () => {
		onAbort();
		proc.kill("SIGTERM");
		killTimeout = setTimeout(() => {
			if (!closed) proc.kill("SIGKILL");
		}, killDelayMs);
	};

	if (signal.aborted) killProc();
	else signal.addEventListener("abort", killProc, { once: true });
}

/**
 * Record a spawn error on a result object. Exported so the error-preservation
 * path is independently testable without mocking the full `runSingleAgent` flow.
 */
export function recordSpawnError(
	err: Error,
	result: { stderr: string; errorMessage?: string },
): void {
	result.stderr += err.message;
	result.errorMessage = err.message;
}

const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

interface SubagentSettings {
	models?: Record<string, string>;
	thinking?: Record<string, string>;
	timeoutMs?: number;
	/** Default USD cap per tool call. */
	maxCost?: number;
	/** Default input+output token cap per tool call. */
	maxTokens?: number;
	/** Set false to stop recording run history. */
	history?: boolean;
}

/**
 * Read the `subagent` block from settings.json. Shape (plus optional
 * timeoutMs, maxCost, maxTokens defaults):
 *   "subagent": {
 *     "models":   { "fast": "deepseek/deepseek-v4-flash", "reasoning": "deepseek/deepseek-v4-pro" },
 *     "thinking": { "fast": "low" }
 *   }
 * Read fresh each call (cheap next to spawning a process) so edits hot-apply.
 */
function readSubagentSettings(): SubagentSettings {
	try {
		// Resolved per call: follows PI_CODING_AGENT_DIR like pi itself does.
		const settingsPath = path.join(getAgentDir(), "settings.json");
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		if (raw?.subagent && typeof raw.subagent === "object") return raw.subagent as SubagentSettings;
	} catch {
		/* missing/malformed → no tier config, fall back to pi defaults */
	}
	return {};
}

export { loadAgentModels as loadQuestAgentModels } from "../../core";

/**
 * Resolve an agent's concrete model + thinking level. Model precedence:
 *   invocation override > explicit frontmatter (model:) > pi-quest's
 *   project-approved role model (agentModels) > tier mapping > unset.
 * Thinking precedence: invocation override > explicit frontmatter (thinking:)
 *   > pi-quest's role thinking > tier mapping > unset.
 * "Unset" means we pass no flag and the spawned pi inherits its own defaults.
 */
/** Per-invocation settings that override the agent definition. */
export interface RuntimeOverride {
	model?: string;
	thinking?: string;
	/** Output contract; replaces the agent's frontmatter `output`. */
	output?: JsonSchema;
}

export function resolveAgentRuntime(
	agent: AgentConfig,
	cwd: string,
	override: { model?: string; thinking?: string } = {},
): {
	model?: string;
	thinking?: string;
} {
	const cfg = readSubagentSettings();
	const tier = agent.tier;
	const questChoice = loadQuestAgentModels(cwd)[agent.name];
	const questModel = questChoice?.model?.trim();
	const model =
		override.model?.trim() ||
		agent.model?.trim() ||
		questModel ||
		(tier ? cfg.models?.[tier] : undefined);
	const thinking = [
		override.thinking,
		agent.thinking,
		questChoice?.thinkingLevel,
		tier ? cfg.thinking?.[tier] : undefined,
	]
		.map((value) => value?.trim())
		.find((value): value is string => Boolean(value && THINKING_LEVELS.has(value)));
	return { model, thinking };
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	runtimeOverride: RuntimeOverride | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	timeoutMs: number,
	attempt = 0,
	maxAttempts = 1,
	providedRunId?: string,
	spawnImpl: typeof spawn = spawn,
	budget?: RunBudget,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	if (budget?.exceeded) {
		const skipped = failedResult(agentName, task, `Not started: ${budget.exceededReason}`);
		return {
			...skipped,
			agentSource: agent.source,
			stopReason: "budget",
			step,
		};
	}

	const runId = providedRunId ?? crypto.randomUUID();
	const startTime = Date.now();

	// Resolve model + thinking from the agent's tier (settings.json) or explicit
	// frontmatter. Without --thinking, subagents inherit the global
	// defaultThinkingLevel (often xhigh) — wasteful for recon/mechanical agents.
	const runtime = resolveAgentRuntime(agent, defaultCwd, runtimeOverride);
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (runtime.model) args.push("--model", runtime.model);
	if (runtime.thinking) args.push("--thinking", runtime.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
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
		model: runtime.model,
		thinking: runtime.thinking,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	let lastActivityTime = startTime;

	const emitProgress = (
		phase: SubagentPhase,
		activity?: string,
		currentTool?: string,
		currentPath?: string,
	) => {
		lastActivityTime = Date.now();
		if (!onUpdate) return;
		onUpdate({
			content: [
				{
					type: "text",
					text: activity || `${agentName}: ${phase}`,
				},
			],
			details: {
				...makeDetails([currentResult]),
				progress: buildProgressPayload({
					runId,
					phase,
					agent: agentName,
					attempt,
					maxAttempts,
					startTime,
					step,
					activity,
					currentTool,
					currentPath,
				}),
			},
		});
	};

	// Emit "queued" so the caller sees an immediate status.
	// On retry attempts we skip this to avoid "queued → retrying → queued".
	if (attempt === 0) {
		emitProgress("queued", `${agentName} queued`);
	}

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;
		let budgetStopped = false;

		const exitCode = await new Promise<number>((resolve) => {
			emitProgress(
				"starting",
				`Starting ${agentName}${attempt > 0 ? ` (attempt ${attempt + 1}/${maxAttempts})` : ""}…`,
			);
			const invocation = getPiInvocation(args);
			const proc = spawnImpl(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let closed = false;
			let settled = false;
			let terminating = false;
			let forcedExitCode: number | null = null;
			let killTimer: ReturnType<typeof setTimeout> | null = null;
			let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
			let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
			let abortHandler: (() => void) | null = null;
			// True while the child's latest assistant turn had no tool call, i.e. it
			// is delivering its final answer and will exit on its own.
			let finalTurn = false;
			const unsubscribeBudget = budget?.onExceeded((reason) => {
				if (finalTurn) return;
				budgetStopped = true;
				terminate(reason);
			});

			const clearTimers = () => {
				if (killTimer) clearTimeout(killTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				killTimer = null;
				timeoutTimer = null;
				heartbeatTimer = null;
			};

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimers();
				proc.stdout.off("data", onStdoutData);
				proc.stderr.off("data", onStderrData);
				proc.off("close", onClose);
				proc.off("error", onProcError);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				unsubscribeBudget?.();
				resolve(code);
			};

			const killChild = (killSignal: NodeJS.Signals) => {
				if (closed) return;
				try {
					if (process.platform !== "win32" && proc.pid) {
						process.kill(-proc.pid, killSignal);
					} else {
						proc.kill(killSignal);
					}
				} catch {
					try {
						proc.kill(killSignal);
					} catch {
						/* ignore */
					}
				}
			};

			const terminate = (reason: string) => {
				if (closed || settled || terminating) return;
				terminating = true;
				forcedExitCode = 1;
				if (reason) {
					currentResult.stderr += currentResult.stderr ? `\n${reason}` : reason;
					currentResult.errorMessage = reason;
				}
				killChild("SIGTERM");
				killTimer = setTimeout(() => {
					killChild("SIGKILL");
					// Do not let a wedged child keep the parent tool pending forever.
					setTimeout(() => finish(1), 1000).unref?.();
				}, KILL_GRACE_MS);
				killTimer.unref?.();
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;

						const toolCallPart = msg.content.find((p) => p.type === "toolCall");
						finalTurn = !toolCallPart;
						if (budget && usage)
							budget.charge(usage.cost?.total || 0, (usage.input || 0) + (usage.output || 0));
						if (toolCallPart) {
							const { activity, currentTool, currentPath } = buildToolActivity(
								toolCallPart.name,
								toolCallPart.arguments,
							);
							emitProgress("tool_call", activity, currentTool, currentPath);
						} else {
							emitProgress("running", `${agentName} running…`);
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitProgress("running", `${agentName} running…`);
					emitUpdate();
				}
			};

			const onStdoutData = (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			};

			const onStderrData = (data: Buffer) => {
				currentResult.stderr += data.toString();
			};

			const onClose = (code: number | null) => {
				closed = true;
				if (buffer.trim()) processLine(buffer);
				finish(code ?? forcedExitCode ?? 0);
			};

			const onProcError = (err: Error) => {
				recordSpawnError(err, currentResult);
				finish(1);
			};

			proc.stdout.on("data", onStdoutData);
			proc.stderr.on("data", onStderrData);
			proc.on("close", onClose);
			proc.on("error", onProcError);

			heartbeatTimer = setInterval(() => {
				const silent = Date.now() - lastActivityTime;
				if (silent >= HEARTBEAT_MS) {
					emitProgress(
						"running",
						`${agentName} running… (${formatDuration(Date.now() - startTime)})`,
					);
				}
			}, HEARTBEAT_MS);
			heartbeatTimer.unref?.();

			if (timeoutMs > 0) {
				timeoutTimer = setTimeout(() => {
					terminate(`Subagent timed out after ${timeoutMs}ms`);
				}, timeoutMs);
				timeoutTimer.unref?.();
			}

			// Another subagent may have tripped the budget while this one started.
			if (budget?.exceeded && !budgetStopped) {
				budgetStopped = true;
				terminate(budget.exceededReason ?? "Budget exceeded");
			}

			if (signal) {
				if (signal.aborted) {
					wasAborted = true;
					terminate("Subagent was aborted");
				} else {
					abortHandler = () => {
						wasAborted = true;
						terminate("Subagent was aborted");
					};
					signal.addEventListener("abort", abortHandler, { once: true });
				}
			}
		});

		currentResult.exitCode = exitCode;
		if (budgetStopped) {
			// A child that exits cleanly on SIGTERM still did not finish its task.
			currentResult.stopReason = "budget";
			if (currentResult.exitCode === 0) currentResult.exitCode = 1;
		}
		const terminalPhase: SubagentPhase = wasAborted
			? "aborted"
			: exitCode === 0
				? "completed"
				: "failed";
		emitProgress(
			terminalPhase,
			`${agentName} ${terminalPhase} (${formatDuration(Date.now() - startTime)})`,
		);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/**
 * Run a subagent, retrying on transient failure (non-zero exit, error/aborted
 * stop reason) up to `retries` times. Deterministic failures (unknown agent) are
 * NOT retried. Returns the last result regardless, so callers still decide policy.
 */
export async function runAgentWithRetry(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	runtimeOverride: RuntimeOverride | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	retries: number,
	timeoutMs: number,
	spawnImpl: typeof spawn = spawn,
	budget?: RunBudget,
): Promise<SingleResult> {
	const runId = crypto.randomUUID();
	const runStartTime = Date.now();
	const maxAttempts = retries + 1;
	const schema = runtimeOverride?.output ?? agents.find((a) => a.name === agentName)?.output;
	const originalTask = task;
	if (schema) task = task + contractInstructions(schema);

	const emitRetryProgress = (attempt: number) => {
		if (!onUpdate) return;
		onUpdate({
			content: [
				{
					type: "text",
					text: `Retrying ${agentName} (${attempt + 1}/${maxAttempts})...`,
				},
			],
			details: {
				...makeDetails([
					{
						agent: agentName,
						agentSource: "unknown",
						task: originalTask,
						exitCode: -1,
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
						step,
					},
				]),
				progress: buildProgressPayload({
					runId,
					phase: "retrying",
					agent: agentName,
					attempt,
					maxAttempts,
					startTime: runStartTime,
					step,
					activity: `Retrying ${agentName} (${attempt + 1}/${maxAttempts})...`,
				}),
			},
		});
	};

	let result = await runSingleAgent(
		defaultCwd,
		agents,
		agentName,
		task,
		cwd,
		runtimeOverride,
		step,
		signal,
		onUpdate,
		makeDetails,
		timeoutMs,
		0,
		maxAttempts,
		runId,
		spawnImpl,
		budget,
	);
	let attempt = 0;
	while (
		isFailedResult(result) &&
		attempt < retries &&
		result.agentSource !== "unknown" && // unknown agent is deterministic — don't retry
		result.stopReason !== "aborted" &&
		result.stopReason !== "budget" &&
		!budget?.exceeded &&
		!signal?.aborted
	) {
		attempt++;
		emitRetryProgress(attempt);
		result = await runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			task,
			cwd,
			runtimeOverride,
			step,
			signal,
			onUpdate,
			makeDetails,
			timeoutMs,
			attempt,
			maxAttempts,
			runId,
			spawnImpl,
			budget,
		);
	}
	if (schema && !isFailedResult(result)) {
		result = await enforceOutputContract(result, schema, originalTask, (t) =>
			runSingleAgent(
				defaultCwd,
				agents,
				agentName,
				t,
				cwd,
				runtimeOverride,
				step,
				signal,
				onUpdate,
				makeDetails,
				timeoutMs,
				0,
				1,
				runId,
				spawnImpl,
				budget,
			),
		);
	}
	// Show the task as the caller wrote it, not with the contract appended.
	result.task = originalTask;
	return result;
}

/**
 * Validate a finished run against its output contract. On mismatch, run the
 * agent once more with the errors and its previous answer (a cheap reformat,
 * not a redo); if that still fails, mark the result `invalid_output`.
 */
export async function enforceOutputContract(
	result: SingleResult,
	schema: JsonSchema,
	originalTask: string,
	runRepair: (task: string) => Promise<SingleResult>,
): Promise<SingleResult> {
	const answer = getFinalOutput(result.messages);
	const first = checkContract(schema, answer);
	if (first.ok) return { ...result, structured: first.value };

	const invalid = (base: SingleResult, errors: string[]): SingleResult => ({
		...base,
		stopReason: "invalid_output",
		errorMessage: `Output did not match the schema after one repair attempt:\n${errors.map((e) => `- ${e}`).join("\n")}`,
	});

	// An abort during repair throws, like any other run.
	const repair = await runRepair(repairTask(originalTask, schema, answer, first.errors));
	const merged: SingleResult = {
		...result,
		messages: [...result.messages, ...repair.messages],
		stderr: [result.stderr, repair.stderr].filter(Boolean).join("\n"),
		usage: {
			input: result.usage.input + repair.usage.input,
			output: result.usage.output + repair.usage.output,
			cacheRead: result.usage.cacheRead + repair.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite + repair.usage.cacheWrite,
			cost: result.usage.cost + repair.usage.cost,
			contextTokens: repair.usage.contextTokens,
			turns: result.usage.turns + repair.usage.turns,
		},
	};
	if (isFailedResult(repair)) {
		return invalid({ ...merged, exitCode: repair.exitCode }, [
			...first.errors,
			`repair run failed: ${repair.errorMessage || repair.stopReason || `exit ${repair.exitCode}`}`,
		]);
	}
	const second = checkContract(schema, getFinalOutput(repair.messages));
	return second.ok ? { ...merged, structured: second.value } : invalid(merged, second.errors);
}

const TaskItem = Type.Object({
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

const PipelineStage = Type.Object({
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

const ChainItem = Type.Object({
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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
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

type SubagentCallParams = Static<typeof SubagentParams>;
/** Tool results also carry the `isError` flag the tool has always returned. */
type SubagentToolResult = AgentToolResult<SubagentDetails> & {
	isError?: boolean;
};

function textResult(text: string, details: SubagentDetails): SubagentToolResult {
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

function withPrefix(
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
async function runSubagentCall(
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task); parallel (tasks array, all at once); chain (sequential, {previous} placeholder);",
			"pipeline (items array + stages array — each item flows through all stages independently, no barrier between stages, finishing in slowest-single-chain time rather than sum-of-stages; stage tasks use {item} and {previous}).",
			"Resilience: retries (0-3, retry transient subagent failures) and onError ('stop' default | 'continue') for chain/pipeline.",
			"Output contracts: pass output (a JSON Schema) or give the agent frontmatter output; the final answer is validated (one repair attempt) and chains/pipelines receive it as JSON with {previous.field} access.",
			"Budgets: maxCost (USD) and maxTokens cap total spend across the whole call; on breach, work stops and partial results return.",
			"History: every call is recorded; a failed call reports its run id, and rerun: '<id>' redoes just the failed work.",
			"Isolation: isolation 'worktree' (single/parallel) gives each writer agent its own git worktree and returns a branch per task instead of editing the working tree.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeWithHistory(params, signal, onUpdate, ctx);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.items && args.items.length > 0 && args.stages && args.stages.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg(
						"accent",
						`pipeline (${args.items.length} items × ${args.stages.length} stages)`,
					) +
					theme.fg("muted", ` [${scope}]`);
				for (const s of args.stages.slice(0, 3)) {
					const clean = s.task.replace(/\{item\}|\{previous\}/g, "").trim();
					const preview = clean.length > 36 ? `${clean.slice(0, 36)}...` : clean;
					text += `\n  ${theme.fg("accent", s.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.stages.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.stages.length - 3} more stages`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const budgetText = details.budget ? formatBudget(details.budget) : "";
			const withBudget = (usage: string) => [usage, budgetText].filter(Boolean).join(" · ");

			const worktreeLine = (r: SingleResult): string => {
				const w = r.worktree;
				if (!w) return "";
				if (w.error) return theme.fg("error", `⎇ worktree kept at ${w.path}: ${w.error}`);
				if (!w.branch) return theme.fg("muted", "⎇ no changes");
				return (
					theme.fg("muted", "⎇ ") + theme.fg("accent", w.branch) + theme.fg("dim", ` ${w.diffStat}`)
				);
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = withBudget(formatUsageStats(r.usage, r.model));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					if (r.worktree) container.addChild(new Text(worktreeLine(r), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = withBudget(formatUsageStats(r.usage, r.model));
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				if (r.worktree) text += `\n${worktreeLine(r)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = withBudget(formatUsageStats(aggregateUsage(details.results)));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = withBudget(formatUsageStats(aggregateUsage(details.results)));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel" || details.mode === "pipeline") {
				const modeLabel = details.mode === "pipeline" ? "pipeline " : "parallel ";
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						if (r.worktree) container.addChild(new Text(worktreeLine(r), 0, 0));
					}

					const usageStr = withBudget(formatUsageStats(aggregateUsage(details.results)));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					if (r.worktree) text += `\n${worktreeLine(r)}`;
				}
				if (!isRunning) {
					const usageStr = withBudget(formatUsageStats(aggregateUsage(details.results)));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Codebase tool ──────────────────────────────────────────────────────────

	interface CodebaseDetails {
		operation: string;
		rootDir: string;
		rescanned: boolean;
		indexSummary: ReturnType<typeof indexSummary>;
		results: Array<{
			relativePath: string;
			name: string;
			symbols: string[];
			exports: string[];
			imports?: string[];
			dependencies?: string[];
			reverseDependencies?: string[];
			impact?: string[];
		}>;
		resultCount: number;
		error?: string;
	}

	type Ctx = { cwd: string; hasUI: boolean };

	function getIndex(
		ctx: Ctx,
		force: boolean,
	): { index: IndexData; rescanned: boolean; reason?: string } {
		const result = scanIndex({ rootDir: ctx.cwd, force });
		return {
			index: result.index,
			rescanned: result.rescanned,
			reason: result.reason,
		};
	}

	pi.registerTool({
		name: "codebase",
		label: "Codebase",
		description:
			"Scan, query, and analyze the codebase dependency graph. Operations: scan (refresh index), query (find files by pattern), map (show dependencies + reverse deps for a file), impact (transitive reverse dependency closure). Cached to .pi/codebase-index.json.",
		parameters: CodebaseParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const op = params.operation ?? "query";
			const force = (params.force ?? false) || op === "scan";

			const { index, rescanned, reason } = getIndex(ctx, force);
			const summary = indexSummary(index);

			const details: CodebaseDetails = {
				operation: op,
				rootDir: index.rootDir,
				rescanned,
				indexSummary: summary,
				results: [],
				resultCount: 0,
			};

			const buildLine = (): string => {
				if (rescanned && reason) {
					return `(re-scanned: ${reason})`;
				}
				return `(cached · ${summary.fileCount} files · ${new Date(summary.scannedAt).toISOString().replace("T", " ").slice(0, 19)})`;
			};

			switch (op) {
				case "scan": {
					details.results = allFiles(index).map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					details.resultCount = details.results.length;
					return {
						content: [
							{
								type: "text" as const,
								text: `Indexed ${summary.fileCount} files. ${buildLine()}`,
							},
						],
						details,
					};
				}

				case "query": {
					const pattern = params.pattern?.trim();
					if (!pattern) {
						details.resultCount = -1;
						details.error = "No pattern provided for query operation.";
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const matches = queryFiles(index, pattern);
					details.resultCount = matches.length;
					details.results = matches.map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					if (matches.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No files matching "${pattern}" in ${summary.fileCount} indexed files. ${buildLine()}`,
								},
							],
							details,
						};
					}
					const lines = matches.map(
						(f) =>
							`${f.relativePath}${f.symbols.length ? ` [${f.symbols.map((s) => s.name).join(", ")}]` : ""}`,
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `${matches.length} files matching "${pattern}":\n${lines.join("\n")}`,
							},
						],
						details,
					};
				}

				case "map": {
					const file = params.file?.trim();
					if (!file) {
						details.error = "No file path provided for map operation.";
						details.resultCount = -1;
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const map = depMap(index, file);
					if (!map.file) {
						return {
							content: [
								{
									type: "text" as const,
									text: `File "${file}" not found in index. ${buildLine()}`,
								},
							],
							details,
						};
					}
					const result: CodebaseDetails["results"][0] = {
						relativePath: map.file.relativePath,
						name: map.file.name,
						symbols: map.file.symbols.map((s) => s.name),
						exports: map.file.exports.map((e) => e.name),
						imports: map.file.imports.map((i) => i.source),
						dependencies: map.dependencies.map((d) => d.relativePath),
						reverseDependencies: map.reverseDependencies.map((d) => d.relativePath),
					};
					details.results = [result];
					details.resultCount = 1;
					const deps =
						map.dependencies.length > 0
							? `\nDependencies (${map.dependencies.length}):\n${map.dependencies.map((d) => `  ${d.relativePath}`).join("\n")}`
							: "\nDependencies: none";
					const rev =
						map.reverseDependencies.length > 0
							? `\nReverse dependencies (${map.reverseDependencies.length}):\n${map.reverseDependencies.map((d) => `  ${d.relativePath}`).join("\n")}`
							: "\nReverse dependencies: none";
					return {
						content: [
							{
								type: "text" as const,
								text: `${map.file.relativePath}${deps}${rev}\n${buildLine()}`,
							},
						],
						details,
					};
				}

				case "impact": {
					const file = params.file?.trim();
					if (!file) {
						details.error = "No file path provided for impact operation.";
						details.resultCount = -1;
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const impact = getImpact(index, file);
					details.resultCount = impact.length;
					details.results = impact.map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					if (impact.length === 0) {
						// Check if the file itself exists
						const exists = index.files[file];
						if (!exists) {
							return {
								content: [
									{
										type: "text" as const,
										text: `File "${file}" not found in index. ${buildLine()}`,
									},
								],
								details,
							};
						}
						return {
							content: [
								{
									type: "text" as const,
									text: `No files depend on "${file}". ${buildLine()}`,
								},
							],
							details,
						};
					}
					const lines = impact.map((f) => f.relativePath);
					return {
						content: [
							{
								type: "text" as const,
								text: `${impact.length} file${impact.length > 1 ? "s" : ""} impacted by "${file}":\n${lines.join("\n")}\n${buildLine()}`,
							},
						],
						details,
					};
				}

				default:
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown operation: ${op}`,
							},
						],
						details,
					};
			}
		},

		renderCall(args, theme, _context) {
			const op = args.operation ?? "query";
			const force = args.force ?? false;
			let sub = "";
			if (op === "query" && args.pattern) {
				sub = theme.fg("dim", ` "${args.pattern}"`);
			} else if ((op === "map" || op === "impact") && args.file) {
				sub = theme.fg("dim", ` ${args.file}`);
			}
			let text = theme.fg("toolTitle", theme.bold("codebase ")) + theme.fg("accent", op) + sub;
			if (force) text += theme.fg("warning", " --force");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as CodebaseDetails | undefined;

			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const summary = details.indexSummary;
			const cacheLine = ` (${summary.fileCount} files · ${new Date(summary.scannedAt).toISOString().replace("T", " ").slice(0, 19)})`;

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (!expanded) {
				const icon = theme.fg("success", "✓");
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("codebase "))}${theme.fg("accent", details.operation)}`;
				text += ` ${theme.fg("dim", `${details.resultCount} result${details.resultCount !== 1 ? "s" : ""}`)}`;
				text += `\n${theme.fg("muted", cacheLine)}`;
				if (details.results.length > 0) {
					const show = details.results.slice(0, 5);
					for (const r of show) {
						const syms =
							r.symbols.length > 0
								? ` [${r.symbols.slice(0, 3).join(", ")}${r.symbols.length > 3 ? ", …" : ""}]`
								: "";
						text += `\n  ${theme.fg("accent", r.relativePath)}${theme.fg("muted", syms)}`;
					}
					if (details.results.length > 5) {
						text += `\n  ${theme.fg("muted", `… +${details.results.length - 5} more`)}`;
					}
				}
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Expanded view
			const container = new Container();
			let header =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("codebase ")) +
				theme.fg("accent", details.operation);
			if (details.rescanned) {
				header += theme.fg("warning", " (re-scanned)");
			}
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("dim", `Root: ${details.rootDir}`), 0, 0));
			container.addChild(new Text(theme.fg("muted", cacheLine), 0, 0));
			container.addChild(new Spacer(1));

			if (details.operation === "scan") {
				const top = details.results.slice(0, 20);
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							`─── Indexed ${details.resultCount} files${details.resultCount > 20 ? ` (showing first 20)` : ""} ───`,
						),
						0,
						0,
					),
				);
				for (const r of top) {
					container.addChild(new Text(`  ${r.relativePath}`, 0, 0));
				}
				return container;
			}

			for (const r of details.results) {
				container.addChild(
					new Text(theme.fg("muted", "─── ") + theme.fg("accent", r.relativePath), 0, 0),
				);
				if (r.symbols.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "symbols:")} ${r.symbols.join(", ")}`, 0, 0),
					);
				}
				if (r.exports.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "exports:")} ${r.exports.join(", ")}`, 0, 0),
					);
				}
				if (r.imports && r.imports.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "imports:")} ${r.imports.join(", ")}`, 0, 0),
					);
				}
				if (r.dependencies && r.dependencies.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", `  Dependencies (${r.dependencies.length}):`), 0, 0),
					);
					for (const d of r.dependencies.slice(0, 10)) {
						container.addChild(new Text(`    ${d}`, 0, 0));
					}
					if (r.dependencies.length > 10) {
						container.addChild(
							new Text(theme.fg("muted", `    … +${r.dependencies.length - 10} more`), 0, 0),
						);
					}
				}
				if (r.reverseDependencies && r.reverseDependencies.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", `  Reverse deps (${r.reverseDependencies.length}):`), 0, 0),
					);
					for (const d of r.reverseDependencies.slice(0, 10)) {
						container.addChild(new Text(`    ${d}`, 0, 0));
					}
					if (r.reverseDependencies.length > 10) {
						container.addChild(
							new Text(theme.fg("muted", `    … +${r.reverseDependencies.length - 10} more`), 0, 0),
						);
					}
				}
				container.addChild(new Spacer(1));
			}

			return container;
		},
	});

	// Show how each agent's tier resolves to a concrete model/thinking level.
	pi.registerCommand("subagent", {
		description:
			"Show subagent model routing. Subcommands: runs (recent history), show <id>, rerun <id> [all]",
		handler: async (args, ctx) => {
			const [sub, id, scopeArg] = (args ?? "").trim().split(/\s+/);
			if (sub === "runs") {
				ctx.ui.notify(formatRunList(listRuns(ctx.cwd)), "info");
				return;
			}
			if (sub === "show" || sub === "rerun") {
				if (!id) {
					ctx.ui.notify(`Usage: /subagent ${sub} <run id>`, "warning");
					return;
				}
				try {
					const record = loadRun(ctx.cwd, id);
					if (sub === "show") {
						ctx.ui.notify(formatRunDetail(record), "info");
						return;
					}
					const scope = scopeArg === "all" ? "all" : "failed";
					const plan = planRerun(record, scope);
					if ("error" in plan) {
						ctx.ui.notify(plan.error, "warning");
						return;
					}
					const call = JSON.stringify({
						rerun: record.id,
						...(scope === "all" ? { rerunScope: "all" } : {}),
					});
					pi.sendUserMessage(
						`Re-run ${plan.summary} by calling the subagent tool with ${call}, then report the results.`,
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			const cfg = readSubagentSettings();
			const models = cfg.models ?? {};
			const thinking = cfg.thinking ?? {};
			const lines: string[] = ['Tier routing (settings.json → "subagent"):'];
			const tiers = new Set([...Object.keys(models), ...Object.keys(thinking)]);
			if (tiers.size === 0) {
				lines.push(
					"  (none configured — agents use their explicit model/thinking, or pi defaults)",
				);
			} else {
				for (const t of tiers) {
					lines.push(
						`  ${t}: ${models[t] ?? "(pi default model)"}${thinking[t] ? ` · think:${thinking[t]}` : ""}`,
					);
				}
			}
			const questModels = loadQuestAgentModels(ctx.cwd);
			if (Object.keys(questModels).length > 0) {
				lines.push("", "pi-quest role models (project memory, win over tiers):");
				for (const [role, c] of Object.entries(questModels)) {
					lines.push(`  ${role} → ${c.model}${c.provider ? ` · ${c.provider}` : ""}`);
				}
			}
			lines.push("", "Agents → resolved:");
			const { agents } = discoverAgents(ctx.cwd, "both");
			for (const a of [...agents].sort((x, y) => x.name.localeCompare(y.name))) {
				const r = resolveAgentRuntime(a, ctx.cwd);
				// Label must mirror resolveAgentRuntime precedence:
				// explicit > quest > tier > default.
				const via = a.model
					? "[explicit]"
					: questModels[a.name]?.model
						? "[quest]"
						: a.tier
							? `[${a.tier}]`
							: "[default]";
				lines.push(
					`  ${a.name} ${via} → ${r.model ?? "(pi default)"}${r.thinking ? ` · think:${r.thinking}` : ""}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
