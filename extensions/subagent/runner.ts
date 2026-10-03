import {
	loadAgentModels as loadQuestAgentModels,
	THINKING_LEVELS as THINKING_LEVEL_VALUES,
} from "../../core";
import {
	childPeerId,
	messagingEnabled,
	noMessagingEnvironment,
	peerEnvironment,
	PeerInbox,
	PROJECT_CWD_ENV,
} from "./messaging";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type AgentConfig } from "./agents.js";
import { checkContract, contractInstructions, type JsonSchema, repairTask } from "./contract.js";
import { RunBudget } from "./budget.js";
import { HEARTBEAT_MS, KILL_GRACE_MS } from "./constants.js";
import {
	emptyUsage,
	type SingleResult,
	type SubagentDetails,
	type SubagentPhase,
	buildProgressPayload,
	buildToolActivity,
	formatDuration,
	getFinalOutput,
	isFailedResult,
} from "./render.js";
import { failedResult } from "./isolation.js";

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

export async function writePromptToTempFile(
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type AbortKillProcess = {
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

export const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

export interface SubagentSettings {
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
export function readSubagentSettings(): SubagentSettings {
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
			usage: emptyUsage(),
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
	const messaging = messagingEnabled(agent.name);
	const args = buildChildArgs(agent, runtime, messaging);

	const peerInbox = messaging
		? new PeerInbox(process.env[PROJECT_CWD_ENV] || defaultCwd, childPeerId(runId))
		: undefined;
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		peerId: peerInbox?.peerId,
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
		if (peerInbox) {
			try {
				peerInbox.prune();
			} catch {
				/* Pruning is housekeeping; never block a run on it. */
			}
			peerInbox.register(agentName, "running", task);
		}
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
				env: peerInbox ? peerEnvironment(defaultCwd, runId) : noMessagingEnvironment(),
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
						applyAssistantTurn(currentResult, msg);
						const usage = msg.usage;
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
		try {
			peerInbox?.register(agentName, "finished", task);
		} catch {
			/* Preserve the execution result if messaging storage is unavailable. */
		}
		removeTempPrompt(tmpPromptDir, tmpPromptPath);
	}
}

/** CLI args for a child `pi` run (task and system-prompt file appended later). */
function buildChildArgs(
	agent: AgentConfig,
	runtime: { model?: string; thinking?: string },
	messaging: boolean,
): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (runtime.model) args.push("--model", runtime.model);
	if (runtime.thinking) args.push("--thinking", runtime.thinking);
	if (agent.tools && agent.tools.length > 0) {
		const tools = messaging ? [...agent.tools, "subagent_message"] : agent.tools;
		args.push("--tools", [...new Set(tools)].join(","));
	}
	return args;
}

/** Fold one finished assistant turn's usage and stop metadata into the result. */
function applyAssistantTurn(result: SingleResult, msg: Extract<Message, { role: "assistant" }>) {
	result.usage.turns++;
	const usage = msg.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && msg.model) result.model = msg.model;
	if (msg.stopReason) result.stopReason = msg.stopReason;
	if (msg.errorMessage) result.errorMessage = msg.errorMessage;
}

function removeTempPrompt(dir: string | null, filePath: string | null): void {
	if (filePath)
		try {
			fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	if (dir)
		try {
			fs.rmdirSync(dir);
		} catch {
			/* ignore */
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
						usage: emptyUsage(),
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
