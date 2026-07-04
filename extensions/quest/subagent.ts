/**
 * quest/subagent.ts — the live sub-agent spawn (Path B runtime).
 *
 * This is the ONLY quest module that imports the SDK as a value
 * (`createAgentSession`, `SessionManager`). It is therefore kept out of every
 * test path — importing the SDK runtime fails under the test runner — and holds
 * no logic that needs testing beyond what ./delegate.ts already covers.
 *
 * Why this is safe to run from inside an extension:
 *   - `createAgentSession` does NOT load extensions, so the sub-agent does not
 *     recursively re-load pi-quest.
 *   - An in-memory `SessionManager` avoids polluting the session tree on disk.
 *   - Reusing `ctx.modelRegistry` shares the user's configured auth/models.
 */
import {
	createAgentSession,
	SessionManager,
	createReadToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { toolsForRole, extractFinalText, awaitFinalTurn } from "./delegate";
import {
	isSandboxActive,
	sandboxToolPlan,
	GUARDED_SANDBOX_TOOLS,
	createWorktree,
	removeWorktree,
} from "./sandbox";
import { execSync } from "node:child_process";
import type { SandboxProfile, SandboxCallRecord, SandboxArtifacts } from "./sandbox";
import { evaluateToolCall } from "./sandbox-guard";

/** Extended result that carries sandbox artifacts when a sandbox was active. */
export interface SubAgentResult {
	ok: boolean;
	output: string;
	error?: string;
	/** Sandbox artifacts collected during delegation; absent when sandbox is off. */
	sandboxArtifacts?: SandboxArtifacts;
}

export interface SubAgentRequest {
	/** Sub-agent role (scout, worker, …) — drives the tool scope when `tools` is not set. */
	role: string;
	/** The resolved model the sub-agent runs with. */
	model: Model<any>;
	/** Fully-formed instruction sent to the sub-agent (persona + step + context). */
	prompt: string;
	/**
	 * Pre-computed tool allowlist for the non-sandbox path. Ignored when
	 * `sandboxProfile` is active — there the sub-agent runs with guarded tool
	 * definitions (see {@link buildGuardedTools}) instead of named built-ins.
	 */
	tools?: string[];
	/**
	 * Active sandbox profile. When set and sandbox-active, the sub-agent's
	 * built-in tools are disabled and replaced with guarded definitions that
	 * enforce path/command policy per call (real enforcement, not just prompt
	 * guidance), since the spawned session loads no extensions and pi's
	 * `tool_call` hook therefore never fires inside it.
	 */
	sandboxProfile?: SandboxProfile;
}

/** Tool name → built-in tool-definition factory (all take just the cwd). */
const TOOL_DEFINITION_FACTORIES: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
	read: createReadToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
};

const GUARDED = new Set<string>(GUARDED_SANDBOX_TOOLS);

/** Wrap a tool definition's `execute` so a policy-violating call is blocked before it runs
 * and every call (allowed or blocked) is recorded in the supplied log array. */
function guard(
	def: ToolDefinition<any, any, any>,
	profile: SandboxProfile,
	log: SandboxCallRecord[],
): ToolDefinition<any, any, any> {
	const run = def.execute.bind(def);
	return {
		...def,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const input = params as Record<string, unknown>;
			const decision = evaluateToolCall(profile, def.name, input);
			log.push({
				tool: def.name,
				input,
				blocked: decision.block,
				reason: decision.reason,
				timestamp: Date.now(),
			});
			if (decision.block) {
				return {
					content: [{ type: "text", text: decision.reason ?? "Sandbox: tool call blocked." }],
					isError: true,
					details: undefined,
				} as Awaited<ReturnType<typeof run>>;
			}
			return run(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/**
 * Build the guarded tool-definition set for a sandboxed sub-agent: read-only
 * tools pass through, {@link GUARDED_SANDBOX_TOOLS} (bash/edit/write) are wrapped
 * with the sandbox guard. Every guarded call is appended to `log`.
 */
function buildGuardedTools(
	cwd: string,
	role: string,
	profile: SandboxProfile,
	log: SandboxCallRecord[],
): ToolDefinition<any, any, any>[] {
	const out: ToolDefinition<any, any, any>[] = [];
	for (const name of sandboxToolPlan(role, profile)) {
		const factory = TOOL_DEFINITION_FACTORIES[name];
		if (!factory) continue;
		const def = factory(cwd);
		out.push(GUARDED.has(name) ? guard(def, profile, log) : def);
	}
	return out;
}

/**
 * Spawn an isolated sub-agent, run the prompt to completion, and return its
 * final text. Blocks until the sub-agent's turn ends (the orchestrator awaits
 * this as a normal tool call). Honors `signal` by tearing the session down.
 */
export async function runSubAgent(
	ctx: ExtensionContext,
	req: SubAgentRequest,
	signal: AbortSignal | undefined,
): Promise<SubAgentResult> {
	if (signal?.aborted) return { ok: false, output: "", error: "Aborted before start." };

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let cleanup: (() => void) | undefined;
	// Worktree path for isolated mode — cleaned up in `finally`.
	let worktreePath: string | null = null;
	try {
		const sandboxed = req.sandboxProfile && isSandboxActive(req.sandboxProfile);
		const callLog: SandboxCallRecord[] = [];

		// Isolated mode: create a real git worktree and run the sub-agent inside it.
		let sessionCwd = ctx.cwd;
		if (sandboxed && req.sandboxProfile!.worktree) {
			worktreePath = createWorktree(req.sandboxProfile!.worktree, ctx.cwd);
			if (!worktreePath) {
				return {
					ok: false,
					output: "",
					error:
						"Sandbox: isolated mode could not create a git worktree; refusing to run in the main cwd.",
				};
			}
			sessionCwd = worktreePath;
		}

		const created = await createAgentSession({
			cwd: sessionCwd,
			model: req.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager: SessionManager.inMemory(),
			// Sandboxed: disable built-in tools and supply guarded definitions so
			// path/command policy is enforced per call. Otherwise: named tool scope.
			...(sandboxed
				? {
						noTools: "builtin" as const,
						customTools: buildGuardedTools(sessionCwd, req.role, req.sandboxProfile!, callLog),
					}
				: { tools: req.tools ?? toolsForRole(req.role) }),
		});
		session = created.session;

		// awaitFinalTurn (delegate.ts) owns the resolve-on-final-turn / reject-on-abort
		// wiring; it is unit-tested there with a fake session.
		const { promise, cleanup: detach } = awaitFinalTurn(session, signal);
		cleanup = detach;

		await session.prompt(req.prompt);
		const messages = await promise;

		// ── Collect sandbox artifacts ─────────────────────────────────────
		let sandboxArtifacts: SandboxArtifacts | undefined;
		if (sandboxed && callLog.length > 0) {
			const touched = collectTouchedPaths(callLog);
			sandboxArtifacts = {
				calls: callLog,
				touchedPaths: touched,
				worktreePath: worktreePath ?? undefined,
			};
			// Gather git diff when the sub-agent touched files.
			if (touched.length > 0) {
				const changed = gitChangedFiles(sessionCwd);
				if (changed) sandboxArtifacts.changedFiles = changed;
			}
		}

		return { ok: true, output: extractFinalText(messages), sandboxArtifacts };
	} catch (err) {
		return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
	} finally {
		cleanup?.();
		session?.dispose();
		// Clean up the worktree when configured to do so.
		if (worktreePath && req.sandboxProfile?.worktree?.autoCleanup) {
			removeWorktree(worktreePath, ctx.cwd);
		}
	}
}

/** Extract write-tool paths (deduplicated) from a call log. */
function collectTouchedPaths(log: SandboxCallRecord[]): string[] {
	const seen = new Set<string>();
	for (const rec of log) {
		if (rec.blocked) continue;
		if (rec.tool !== "edit" && rec.tool !== "write") continue;
		const path =
			typeof rec.input.path === "string"
				? rec.input.path
				: typeof rec.input.file_path === "string"
					? rec.input.file_path
					: typeof rec.input.file === "string"
						? rec.input.file
						: undefined;
		if (path) seen.add(path);
	}
	return [...seen];
}

/** Return `git diff --name-only` output as an array, or null on failure. */
function gitChangedFiles(cwd: string): string[] | null {
	try {
		const out = execSync("git diff --name-only", { cwd, timeout: 10_000, stdio: "pipe" });
		return out.toString().trim().split("\n").filter(Boolean);
	} catch {
		return null;
	}
}
