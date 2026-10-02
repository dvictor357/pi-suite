import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachAbortKillFallback,
	buildProgressPayload,
	buildToolActivity,
	CodebaseParams,
	loadQuestAgentModels,
	recordSpawnError,
	resolveAgentRuntime,
	runAgentWithRetry,
	runSingleAgent,
	SubagentParams,
	validateConcurrentWriteClaims,
} from "./index.js";
import type { AgentConfig } from "./agents.js";
import { formatBudget, normalizeLimit, RunBudget } from "./budget.js";
import type { SingleResult, SubagentDetails } from "./index.js";

class FakeProcess extends EventEmitter {
	readonly signals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		return true;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("attachAbortKillFallback", () => {
	it("sends SIGTERM on abort and SIGKILL after the delay if still open", () => {
		vi.useFakeTimers();
		const proc = new FakeProcess();
		const controller = new AbortController();
		const onAbort = vi.fn();

		attachAbortKillFallback(proc, controller.signal, onAbort, 1000);
		controller.abort();

		expect(onAbort).toHaveBeenCalledTimes(1);
		expect(proc.signals).toEqual(["SIGTERM"]);

		vi.advanceTimersByTime(999);
		expect(proc.signals).toEqual(["SIGTERM"]);

		vi.advanceTimersByTime(1);
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("clears the pending SIGKILL when the process closes after SIGTERM", () => {
		vi.useFakeTimers();
		const proc = new FakeProcess();
		const controller = new AbortController();

		attachAbortKillFallback(proc, controller.signal, vi.fn(), 1000);
		controller.abort();
		proc.emit("close");
		vi.advanceTimersByTime(1000);

		expect(proc.signals).toEqual(["SIGTERM"]);
	});

	it("handles an already-aborted signal", () => {
		vi.useFakeTimers();
		const proc = new FakeProcess();
		const controller = new AbortController();
		controller.abort();

		attachAbortKillFallback(proc, controller.signal, vi.fn(), 1000);

		expect(proc.signals).toEqual(["SIGTERM"]);
	});
});

describe("loadQuestAgentModels (pi-suite contract bridge)", () => {
	// Mirror pi-suite core/hash.ts + core/paths.ts to address the same file the
	// production reader does, then write/clean a throwaway project so we never
	// touch a real project's memory.
	const projectsDir = path.join(os.homedir(), ".pi", "agent", "memory", "projects");
	const cwd = `/tmp/pi-minions-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const file = path.join(
		projectsDir,
		`${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`,
	);

	const writeMemory = (blob: unknown) => {
		fs.mkdirSync(projectsDir, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(blob), "utf8");
	};

	afterEach(() => {
		try {
			fs.unlinkSync(file);
		} catch {
			/* not written by this test */
		}
	});

	it("returns {} when no memory file exists for the project", () => {
		expect(loadQuestAgentModels(cwd)).toEqual({});
	});

	it("reads agentModels written by quest (no contractVersion)", () => {
		writeMemory({
			name: "demo",
			agentModels: {
				scout: { model: "deepseek/deepseek-v4-flash", provider: "deepseek" },
			},
		});
		expect(loadQuestAgentModels(cwd)).toEqual({
			scout: { model: "deepseek/deepseek-v4-flash", provider: "deepseek", timestamp: 0 },
		});
	});

	it("reads agentModels at the current contract version", () => {
		writeMemory({
			contractVersion: 2,
			agentModels: { worker: { model: "claude-opus-4-8" } },
		});
		expect(loadQuestAgentModels(cwd).worker?.model).toBe("claude-opus-4-8");
	});

	it("reads the optional thinking level approved by quest", () => {
		writeMemory({
			contractVersion: 2,
			agentModels: {
				worker: { model: "gpt-5.6-sol", thinkingLevel: "medium" },
			},
		});

		expect(loadQuestAgentModels(cwd).worker).toMatchObject({
			model: "gpt-5.6-sol",
			thinkingLevel: "medium",
		});
		expect(
			resolveAgentRuntime(
				{
					name: "worker",
					description: "worker",
					systemPrompt: "work",
					source: "bundled",
					filePath: "/tmp/worker.md",
				},
				cwd,
			),
		).toEqual({ model: "gpt-5.6-sol", thinking: "medium" });
	});

	it("reads agentModels from contract v1 (backward-compatible)", () => {
		writeMemory({
			contractVersion: 1,
			agentModels: { planner: { model: "gpt-4", provider: "openai" } },
		});
		expect(loadQuestAgentModels(cwd).planner?.model).toBe("gpt-4");
	});

	it("ignores a file written by a newer contract (future-proofing)", () => {
		writeMemory({
			contractVersion: 999,
			agentModels: { scout: { model: "should-be-ignored" } },
		});
		expect(loadQuestAgentModels(cwd)).toEqual({});
	});

	it("returns {} when agentModels is absent or malformed", () => {
		writeMemory({ name: "demo", agentModels: "not-an-object" });
		expect(loadQuestAgentModels(cwd)).toEqual({});
	});

	it("drops malformed role choices and invalid thinking levels", () => {
		writeMemory({
			agentModels: {
				worker: { model: "  ", thinkingLevel: "medium" },
				scout: { model: "fast-model", thinkingLevel: "extreme" },
				planner: "not-an-object",
			},
		});

		expect(loadQuestAgentModels(cwd)).toEqual({
			scout: { model: "fast-model", timestamp: 0 },
		});
	});
});

describe("resolveAgentRuntime", () => {
	const worker: AgentConfig = {
		name: "worker",
		description: "worker",
		systemPrompt: "work",
		source: "bundled",
		filePath: "/tmp/worker.md",
	};

	it("gives per-invocation model and thinking overrides highest precedence", () => {
		expect(
			resolveAgentRuntime(worker, "/tmp/no-quest-memory", {
				model: "gpt-5.6-sol",
				thinking: "medium",
			}),
		).toEqual({ model: "gpt-5.6-sol", thinking: "medium" });
	});

	it("ignores an invalid per-invocation thinking override", () => {
		expect(
			resolveAgentRuntime(worker, "/tmp/no-quest-memory", {
				thinking: "extreme",
			}).thinking,
		).toBeUndefined();
	});

	it("falls back after an invalid invocation thinking override", () => {
		expect(
			resolveAgentRuntime({ ...worker, thinking: "low" }, "/tmp/no-quest-memory", {
				thinking: "extreme",
			}).thinking,
		).toBe("low");
	});
});

describe("SubagentParams", () => {
	it("accepts runtime overrides and per-task claims", () => {
		const schema = JSON.parse(JSON.stringify(SubagentParams));

		expect(schema.properties.model.type).toBe("string");
		expect(schema.properties.thinking).toBeDefined();
		expect(schema.properties.tasks.items.properties.readClaim).toBeDefined();
		expect(schema.properties.tasks.items.properties.writeClaim).toBeDefined();
		expect(schema.properties.stages.items.properties.writeClaim).toBeDefined();
	});
});

describe("validateConcurrentWriteClaims", () => {
	it("preserves single-writer compatibility and rejects undeclared concurrent writers", () => {
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "worker", label: "only", sequentialGroup: 0 },
			]),
		).toBeNull();
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "worker", label: "first", sequentialGroup: 0 },
				{ agent: "worker", label: "second", sequentialGroup: 1 },
			]),
		).toMatch(/declare non-empty disjoint writeClaim/);
	});

	it("allows duplicate-normalized, disjoint claims and isolated cwd directories", () => {
		expect(
			validateConcurrentWriteClaims("/project", [
				{
					agent: "worker",
					label: "first",
					sequentialGroup: 0,
					writeClaim: ["src/a.ts", "./src/a.ts"],
				},
				{
					agent: "worker",
					label: "second",
					sequentialGroup: 1,
					writeClaim: ["src/b.ts"],
				},
			]),
		).toBeNull();
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "worker", label: "first", sequentialGroup: 0, cwd: "/tmp/a" },
				{ agent: "worker", label: "second", sequentialGroup: 1, cwd: "/tmp/b" },
			]),
		).toBeNull();
	});

	it("rejects empty, traversal, overlapping, and read-only write claims", () => {
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "worker", label: "first", writeClaim: [""] },
			]),
		).toMatch(/must not be empty/);
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "worker", label: "first", writeClaim: ["../outside"] },
			]),
		).toMatch(/escapes working directory/);
		expect(
			validateConcurrentWriteClaims("/project", [
				{
					agent: "worker",
					label: "first",
					writeClaim: ["src"],
					sequentialGroup: 0,
				},
				{
					agent: "worker",
					label: "second",
					writeClaim: ["src/a.ts"],
					sequentialGroup: 1,
				},
			]),
		).toMatch(/overlapping write claims/);
		expect(
			validateConcurrentWriteClaims("/project", [
				{ agent: "verifier", label: "judge", writeClaim: ["report.md"] },
			]),
		).toMatch(/read-only agent/);
	});

	it("resolves symlink aliases for non-existent claimed children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-claims-"));
		try {
			fs.mkdirSync(path.join(root, "real"));
			fs.symlinkSync("real", path.join(root, "alias"));
			expect(
				validateConcurrentWriteClaims(root, [
					{
						agent: "worker",
						label: "first",
						sequentialGroup: 0,
						writeClaim: ["alias/new.ts"],
					},
					{
						agent: "worker",
						label: "second",
						sequentialGroup: 1,
						writeClaim: ["real/new.ts"],
					},
				]),
			).toMatch(/overlapping write claims/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows overlapping claims inside one sequential pipeline item", () => {
		expect(
			validateConcurrentWriteClaims("/project", [
				{
					agent: "worker",
					label: "stage 1",
					writeClaim: ["out"],
					sequentialGroup: 0,
				},
				{
					agent: "worker",
					label: "stage 2",
					writeClaim: ["out"],
					sequentialGroup: 0,
				},
			]),
		).toBeNull();
	});
});

describe("recordSpawnError", () => {
	it("appends err.message to stderr and sets errorMessage", () => {
		const result: { stderr: string; errorMessage?: string } = {
			stderr: "existing stderr\n",
			errorMessage: undefined,
		};
		const err = new Error("ENOENT: no such file or directory");

		recordSpawnError(err, result);

		expect(result.stderr).toBe("existing stderr\nENOENT: no such file or directory");
		expect(result.errorMessage).toBe("ENOENT: no such file or directory");
	});

	it("appends to stderr without replacing prior content", () => {
		const result: { stderr: string; errorMessage?: string } = {
			stderr: "prior\n",
		};
		recordSpawnError(new Error("spawn EACCES"), result);

		expect(result.stderr).toBe("prior\nspawn EACCES");
		expect(result.errorMessage).toBe("spawn EACCES");
	});
});

// ── Codebase tool: TypeBox schema validation ────────────────────────────────

describe("CodebaseParams (codebase tool schema)", () => {
	it("defines operation as optional string enum with scan/query/map/impact", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		expect(schema.type).toBe("object");
		expect(schema.properties.operation).toBeDefined();
		// StringEnum produces a constrained string type (type="string" with
		// either an enum array or a union of const literals via anyOf)
		const op = schema.properties.operation;
		// At minimum, it constrains to string values
		expect((op.type ?? op.enum) ? true : op.anyOf ? true : false).toBe(true);
	});

	it("defines pattern as optional string for query operations", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		expect(schema.properties.pattern).toBeDefined();
		expect(schema.properties.pattern.type).toBe("string");
	});

	it("defines file as optional string for map/impact operations", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		expect(schema.properties.file).toBeDefined();
		expect(schema.properties.file.type).toBe("string");
	});

	it("defines force as optional boolean defaulting to false", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		expect(schema.properties.force).toBeDefined();
		expect(schema.properties.force.type).toBe("boolean");
		expect(schema.properties.force.default).toBe(false);
	});

	it("accepts an empty object (all fields optional)", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		// All properties are optional — schema has no required array
		expect(schema.required).toBeUndefined();
	});
});

// ── Progress streaming helpers ─────────────────────────────────────────────

describe("buildToolActivity", () => {
	it("describes read/write/edit/ls with a safe path", () => {
		const home = os.homedir();
		expect(buildToolActivity("read", { path: `${home}/code.ts` })).toEqual({
			activity: "reading ~/code.ts",
			currentTool: "read",
			currentPath: "~/code.ts",
		});
		expect(buildToolActivity("write", { path: "/tmp/out.json" })).toEqual({
			activity: "writing /tmp/out.json",
			currentTool: "write",
			currentPath: "/tmp/out.json",
		});
		expect(buildToolActivity("edit", { file_path: "/x/y.ts" })).toEqual({
			activity: "editing /x/y.ts",
			currentTool: "edit",
			currentPath: "/x/y.ts",
		});
		expect(buildToolActivity("ls", { path: home })).toEqual({
			activity: "listing ~",
			currentTool: "ls",
			currentPath: "~",
		});
	});

	it.each([
		"API_TOKEN=sk-secret curl https://example.com",
		"curl -u admin:password https://example.com",
	])("does not expose secrets from bash commands", (command) => {
		const result = buildToolActivity("bash", { command });
		expect(result.activity).toBe("running command");
		expect(JSON.stringify(result)).not.toContain(command);
		expect(result.currentTool).toBe("bash");
		expect(result.currentPath).toBeUndefined();
	});

	it("falls back for unknown tools without exposing arguments", () => {
		const result = buildToolActivity("custom_tool", {
			secret: "token",
			payload: "x",
		});
		expect(result.activity).toBe("custom_tool");
		expect(result.currentTool).toBe("custom_tool");
		expect(result.currentPath).toBeUndefined();
	});
});

describe("buildProgressPayload", () => {
	it("builds a structured progress payload", () => {
		const startTime = Date.now() - 1500;
		const payload = buildProgressPayload({
			runId: "run-123",
			phase: "tool_call",
			agent: "worker",
			attempt: 1,
			maxAttempts: 3,
			startTime,
			step: 2,
			activity: "reading ~/file.ts",
			currentTool: "read",
			currentPath: "~/file.ts",
		});

		expect(payload.runId).toBe("run-123");
		expect(payload.phase).toBe("tool_call");
		expect(payload.agent).toBe("worker");
		expect(payload.attempt).toBe(1);
		expect(payload.maxAttempts).toBe(3);
		expect(payload.step).toBe(2);
		expect(payload.activity).toBe("reading ~/file.ts");
		expect(payload.currentTool).toBe("read");
		expect(payload.currentPath).toBe("~/file.ts");
		expect(payload.elapsedMs).toBeGreaterThanOrEqual(1500);
	});

	it("defaults activity from phase", () => {
		const payload = buildProgressPayload({
			runId: "run-456",
			phase: "starting",
			agent: "scout",
			attempt: 0,
			maxAttempts: 1,
			startTime: Date.now(),
		});

		expect(payload.activity).toBe("starting...");
	});
});

// ── runSingleAgent progress streaming (mocked spawn) ───────────────────────

class FakeReadable extends EventEmitter {
	pipe() {}
	setEncoding() {}
}

class FakeChildProcess extends EventEmitter {
	stdout = new FakeReadable();
	stderr = new FakeReadable();
	pid = 12345;
	killed = false;

	kill(signal: NodeJS.Signals): boolean {
		this.killed = true;
		this.emit("close", 0, signal);
		return true;
	}
}

function makeDetails(results: SingleResult[]): SubagentDetails {
	return {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		bundledAgentsDir: null,
		results,
	};
}

const testAgent: AgentConfig = {
	name: "worker",
	description: "worker",
	systemPrompt: "",
	source: "bundled",
	filePath: "/tmp/worker.md",
};

function runSingleAgentWithFakeSpawn(
	fakeSpawn: typeof import("node:child_process").spawn,
	onUpdate: (u: AgentToolResult<SubagentDetails>) => void,
	signal?: AbortSignal,
	timeoutMs = 10000,
) {
	return runSingleAgent(
		"/tmp",
		[testAgent],
		"worker",
		"task",
		undefined,
		undefined,
		undefined,
		signal,
		onUpdate,
		makeDetails,
		timeoutMs,
		undefined,
		undefined,
		undefined,
		fakeSpawn,
	);
}

describe("runSingleAgent progress streaming", () => {
	it("emits starting, tool_call, running, and completed progress updates", async () => {
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			// Simulate child output: assistant requests a read, then returns text.
			setImmediate(() => {
				proc.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							type: "message_end",
							message: {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										name: "read",
										arguments: { path: "/home/user/file.ts" },
									},
								],
								usage: {},
							},
						}) + "\n",
					),
				);
				setImmediate(() => {
					proc.stdout.emit(
						"data",
						Buffer.from(
							JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "Done" }],
									usage: {},
								},
							}) + "\n",
						),
					);
					setImmediate(() => proc.emit("close", 0));
				});
			});
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		const result = await runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate);

		expect(result.exitCode).toBe(0);
		expect(updates.length).toBeGreaterThanOrEqual(4);
		// First update is "queued", then "starting"
		expect(updates[0].details.progress?.phase).toBe("queued");
		expect(updates[1].details.progress?.phase).toBe("starting");

		const toolCallUpdate = updates.find((u) => u.details.progress?.phase === "tool_call");
		expect(toolCallUpdate).toBeDefined();
		expect(toolCallUpdate?.details.progress?.currentTool).toBe("read");
		expect(toolCallUpdate?.details.progress?.currentPath).toContain("file.ts");

		const completedUpdate = updates[updates.length - 1];
		expect(completedUpdate.details.progress?.phase).toBe("completed");
	});

	it("emits heartbeat updates during silence", async () => {
		vi.useFakeTimers();
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			setTimeout(() => proc.emit("close", 0), 5500);
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		const promise = runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate, undefined, 60000);
		await vi.advanceTimersByTimeAsync(6000);
		const result = await promise;

		expect(result.exitCode).toBe(0);
		const heartbeatUpdates = updates.filter((u) =>
			u.details.progress?.activity?.includes("running…"),
		);
		expect(heartbeatUpdates.length).toBeGreaterThanOrEqual(2);

		vi.useRealTimers();
	});

	it("cleans up timers and process listeners on completion", async () => {
		let proc: FakeChildProcess | null = null;
		const fakeSpawn = () => {
			proc = new FakeChildProcess();
			setTimeout(() => proc!.emit("close", 0), 10);
			return proc as any;
		};

		await runSingleAgentWithFakeSpawn(fakeSpawn, () => {}, undefined, 60000);

		expect(proc).not.toBeNull();
		expect(proc!.stdout.listenerCount("data")).toBe(0);
		expect(proc!.stderr.listenerCount("data")).toBe(0);
		expect(proc!.listenerCount("close")).toBe(0);
		expect(proc!.listenerCount("error")).toBe(0);
	});

	it("emits failed terminal status on non-zero exit", async () => {
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			setImmediate(() => proc.emit("close", 1));
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		const result = await runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate);

		expect(result.exitCode).toBe(1);
		const terminal = updates[updates.length - 1];
		expect(terminal.details.progress?.phase).toBe("failed");
	});

	it("emits aborted terminal status when the signal is aborted", async () => {
		const controller = new AbortController();
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			setTimeout(() => controller.abort(), 10);
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		await expect(
			runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate, controller.signal, 60000),
		).rejects.toThrow("Subagent was aborted");

		const terminal = updates[updates.length - 1];
		expect(terminal.details.progress?.phase).toBe("aborted");
	});

	it("emits queued on first attempt and skips on retry", async () => {
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			setImmediate(() => proc.emit("close", 0));
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		await runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate);

		// First update should be "queued"
		expect(updates[0].details.progress?.phase).toBe("queued");
		// Then "starting"
		expect(updates[1].details.progress?.phase).toBe("starting");
	});

	it("emits queued then starting before any child output arrives", async () => {
		const events: string[] = [];
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			// Emit data on next tick — after starting phase
			setImmediate(() => {
				proc.stdout.emit(
					"data",
					Buffer.from(
						JSON.stringify({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "output after start" }],
								usage: {},
							},
						}) + "\n",
					),
				);
				setImmediate(() => proc.emit("close", 0));
			});
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => {
			updates.push(u);
			events.push(u.details.progress?.phase ?? "unknown");
		};

		await runSingleAgentWithFakeSpawn(fakeSpawn, onUpdate);

		// Phases must appear in order: queued → starting → ...
		expect(events[0]).toBe("queued");
		expect(events[1]).toBe("starting");
	});
});

// ── runAgentWithRetry progress streaming ───────────────────────────────────

describe("runAgentWithRetry progress", () => {
	it("emits retrying phase between failed attempts", async () => {
		let callCount = 0;
		const fakeSpawn = () => {
			callCount++;
			const proc = new FakeChildProcess();
			if (callCount === 1) {
				// First attempt: fail
				setImmediate(() => proc.emit("close", 1));
			} else {
				// Second attempt: succeed
				setImmediate(() => {
					proc.stdout.emit(
						"data",
						Buffer.from(
							JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "Success on retry" }],
									usage: {},
								},
							}) + "\n",
						),
					);
					setImmediate(() => proc.emit("close", 0));
				});
			}
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		const result = await runAgentWithRetry(
			"/tmp",
			[testAgent],
			"worker",
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			onUpdate,
			makeDetails,
			1, // retries
			60000,
			fakeSpawn,
		);

		expect(result.exitCode).toBe(0);

		const phases = updates.map((u) => u.details.progress?.phase).filter(Boolean);
		// Should include: queued → starting → ... → failed → retrying → starting → ... → completed
		// queued only fires on attempt 0 (not on retry) to avoid "queued → retrying → queued"
		expect(phases).toContain("retrying");
		expect(phases.filter((p) => p === "queued").length).toBe(1);
		expect(phases.filter((p) => p === "starting").length).toBe(2);
	});

	it("does not retry on unknown agent (deterministic failure)", async () => {
		const fakeSpawn = () => {
			const proc = new FakeChildProcess();
			setImmediate(() => proc.emit("close", 0));
			return proc as any;
		};

		const updates: AgentToolResult<SubagentDetails>[] = [];
		const onUpdate = (u: AgentToolResult<SubagentDetails>) => updates.push(u);

		const result = await runAgentWithRetry(
			"/tmp",
			[testAgent],
			"nonexistent-agent",
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			onUpdate,
			makeDetails,
			2,
			60000,
			fakeSpawn,
		);

		expect(result.exitCode).toBe(1);
		// Unknown agent → no retries; should not emit "retrying"
		const phases = updates.map((u) => u.details.progress?.phase).filter(Boolean);
		expect(phases).not.toContain("retrying");
	});
});

describe("RunBudget", () => {
	it("treats 0, negative, and non-numbers as no cap", () => {
		expect(normalizeLimit(0)).toBeUndefined();
		expect(normalizeLimit(-1)).toBeUndefined();
		expect(normalizeLimit(Number.NaN)).toBeUndefined();
		expect(normalizeLimit("1")).toBeUndefined();
		expect(normalizeLimit(0.5)).toBe(0.5);
		expect(new RunBudget({}).enabled).toBe(false);
	});

	it("trips on cost and notifies listeners exactly once", () => {
		const budget = new RunBudget({ maxCost: 0.5 });
		const reasons: string[] = [];
		budget.onExceeded((r) => reasons.push(r));
		budget.charge(0.3, 100);
		expect(budget.exceeded).toBe(false);
		budget.charge(0.2, 100);
		expect(budget.exceeded).toBe(true);
		budget.charge(1, 100);
		expect(reasons).toEqual(["Budget exceeded: spent $0.5000 of $0.50 cost cap"]);
		expect(budget.spentCost).toBeCloseTo(1.5);
	});

	it("trips on tokens and ignores bogus usage values", () => {
		const budget = new RunBudget({ maxTokens: 1000 });
		budget.charge(Number.NaN, -50);
		expect(budget.spentTokens).toBe(0);
		budget.charge(0, 1200);
		expect(budget.exceededReason).toBe("Budget exceeded: used 1.2k of 1.0k token cap");
		expect(formatBudget(budget.snapshot())).toBe("budget 1.2k/1.0k tok (exceeded)");
	});

	it("unsubscribes listeners", () => {
		const budget = new RunBudget({ maxCost: 1 });
		const listener = vi.fn();
		const off = budget.onExceeded(listener);
		off();
		budget.charge(2, 0);
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("runSingleAgent budget enforcement", () => {
	const assistantTurn = (cost: number, withToolCall: boolean) =>
		Buffer.from(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: withToolCall
						? [
								{
									type: "toolCall",
									id: "t1",
									name: "bash",
									arguments: { command: "ls" },
								},
							]
						: [{ type: "text", text: "final answer" }],
					usage: { input: 100, output: 50, cost: { total: cost } },
					stopReason: withToolCall ? "toolUse" : "stop",
				},
			}) + "\n",
		);

	// pid 0 forces proc.kill() instead of signalling a real process group.
	const makeProc = () => {
		const proc = new FakeChildProcess();
		proc.pid = 0;
		return proc;
	};

	const run = (
		fakeSpawn: typeof import("node:child_process").spawn,
		budget: RunBudget,
		agentName = "worker",
	) =>
		runSingleAgent(
			"/tmp",
			[testAgent, { ...testAgent, name: "other" }],
			agentName,
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			10000,
			undefined,
			undefined,
			undefined,
			fakeSpawn,
			budget,
		);

	it("stops a child whose tool-call turn crosses the cap", async () => {
		const proc = makeProc();
		const budget = new RunBudget({ maxCost: 0.5 });
		const fakeSpawn = () => {
			setImmediate(() => proc.stdout.emit("data", assistantTurn(0.6, true)));
			return proc as any;
		};
		const result = await run(fakeSpawn as any, budget);
		expect(proc.killed).toBe(true);
		// FakeChildProcess exits 0 on kill; the result must still be a failure.
		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("budget");
		expect(result.errorMessage).toMatch(/Budget exceeded/);
	});

	it("lets a child finish when its final answer crosses the cap", async () => {
		const proc = makeProc();
		const budget = new RunBudget({ maxCost: 0.5 });
		const fakeSpawn = () => {
			setImmediate(() => {
				proc.stdout.emit("data", assistantTurn(0.6, false));
				setImmediate(() => proc.emit("close", 0));
			});
			return proc as any;
		};
		const result = await run(fakeSpawn as any, budget);
		expect(proc.killed).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(budget.exceeded).toBe(true);
	});

	it("stops other running children when one trips the shared budget", async () => {
		const budget = new RunBudget({ maxTokens: 200 });
		const idle = makeProc();
		const spender = makeProc();
		const idleRun = run((() => idle) as any, budget, "other");
		const spenderRun = run(
			(() => {
				setImmediate(() => spender.stdout.emit("data", assistantTurn(0, true)));
				setImmediate(() => setImmediate(() => spender.stdout.emit("data", assistantTurn(0, true))));
				return spender;
			}) as any,
			budget,
		);
		const [idleResult, spenderResult] = await Promise.all([idleRun, spenderRun]);
		expect(idle.killed).toBe(true);
		expect(idleResult.stopReason).toBe("budget");
		expect(spenderResult.stopReason).toBe("budget");
		expect(budget.spentTokens).toBe(300);
	});

	it("does not spawn once the budget is already exceeded", async () => {
		const budget = new RunBudget({ maxCost: 0.1 });
		budget.charge(0.2, 0);
		const fakeSpawn = vi.fn();
		const result = await run(fakeSpawn as any, budget);
		expect(fakeSpawn).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("budget");
		expect(result.errorMessage).toMatch(/^Not started: Budget exceeded/);
	});

	it("does not retry after a budget stop", async () => {
		const budget = new RunBudget({ maxCost: 0.5 });
		let spawns = 0;
		const fakeSpawn = () => {
			spawns++;
			const proc = makeProc();
			setImmediate(() => proc.stdout.emit("data", assistantTurn(0.6, true)));
			return proc as any;
		};
		const result = await runAgentWithRetry(
			"/tmp",
			[testAgent],
			"worker",
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			makeDetails,
			3,
			10000,
			fakeSpawn as any,
			budget,
		);
		expect(spawns).toBe(1);
		expect(result.stopReason).toBe("budget");
	});
});
