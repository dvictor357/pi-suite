import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { type AgentScope } from "./agents.js";
import { formatStructured } from "./contract.js";
import { type BudgetSnapshot } from "./budget.js";
import { type WorktreeOutcome } from "./worktree.js";
import { PER_TASK_OUTPUT_CAP } from "./constants.js";

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const rem = sec % 60;
	return `${min}m${rem}s`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
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

export function formatToolCall(
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

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
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
	/** Address for project-scoped peer messaging, stable across retries. */
	peerId?: string;
	/** Present when the task ran in an isolated git worktree. */
	worktree?: WorktreeOutcome;
	/** Validated JSON answer when the run had an output contract. */
	structured?: unknown;
}

export type SubagentPhase =
	| "queued"
	| "starting"
	| "running"
	| "tool_call"
	| "retrying"
	| "completed"
	| "failed"
	| "aborted";

export interface SubagentProgress {
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

export function getFinalOutput(messages: Message[]): string {
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

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "budget" ||
		result.stopReason === "invalid_output"
	);
}

/** A result's answer as text: canonical JSON when it had a contract. */
export function getAnswerText(result: SingleResult): string {
	return result.structured !== undefined
		? formatStructured(result.structured)
		: getFinalOutput(result.messages);
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getAnswerText(result) || "(no output)";
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

export function safePath(p: unknown): string | undefined {
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
