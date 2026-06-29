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
import { toolsForRole, extractFinalText, type SubAgentResult } from "./delegate";
import { isSandboxActive, sandboxToolPlan, GUARDED_SANDBOX_TOOLS } from "./sandbox";
import type { SandboxProfile } from "./sandbox";
import { evaluateToolCall } from "./sandbox-guard";

export interface SubAgentRequest {
	/** Sub-agent role (scout, worker, …) — drives the tool scope when `tools` is not set. */
	role: string;
	/** The resolved model the sub-agent runs with. */
	model: Model<any>;
	/** Fully-formed instruction sent to the sub-agent (persona + task + context). */
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

/** Wrap a tool definition's `execute` so a policy-violating call is blocked before it runs. */
function guard(
	def: ToolDefinition<any, any, any>,
	profile: SandboxProfile,
): ToolDefinition<any, any, any> {
	const run = def.execute.bind(def);
	return {
		...def,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const decision = evaluateToolCall(profile, def.name, params as Record<string, unknown>);
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
 * with the sandbox guard.
 */
function buildGuardedTools(
	cwd: string,
	role: string,
	profile: SandboxProfile,
): ToolDefinition<any, any, any>[] {
	const out: ToolDefinition<any, any, any>[] = [];
	for (const name of sandboxToolPlan(role, profile)) {
		const factory = TOOL_DEFINITION_FACTORIES[name];
		if (!factory) continue;
		const def = factory(cwd);
		out.push(GUARDED.has(name) ? guard(def, profile) : def);
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
	let onAbort: (() => void) | undefined;
	try {
		const sandboxed = req.sandboxProfile && isSandboxActive(req.sandboxProfile);
		const created = await createAgentSession({
			cwd: ctx.cwd,
			model: req.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager: SessionManager.inMemory(),
			// Sandboxed: disable built-in tools and supply guarded definitions so
			// path/command policy is enforced per call. Otherwise: named tool scope.
			...(sandboxed
				? {
						noTools: "builtin" as const,
						customTools: buildGuardedTools(ctx.cwd, req.role, req.sandboxProfile!),
					}
				: { tools: req.tools ?? toolsForRole(req.role) }),
		});
		session = created.session;

		// Resolve on the sub-agent's final turn; reject on abort. Wiring the abort
		// into the same promise is what prevents a hang: disposing the session does
		// not necessarily emit `agent_end`, so without an abort-reject `await
		// finished` could block forever after the orchestrator aborts.
		const finished = new Promise<ReadonlyArray<{ role?: string; content?: unknown }>>(
			(resolve, reject) => {
				const unsubscribe = session!.subscribe((ev) => {
					if (ev.type === "agent_end" && !ev.willRetry) {
						unsubscribe();
						resolve(ev.messages as ReadonlyArray<{ role?: string; content?: unknown }>);
					}
				});
				if (signal) {
					onAbort = () => {
						unsubscribe();
						session?.dispose();
						reject(new Error("Aborted by user."));
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}
			},
		);

		await session.prompt(req.prompt);
		const messages = await finished;

		return { ok: true, output: extractFinalText(messages) };
	} catch (err) {
		return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		session?.dispose();
	}
}
