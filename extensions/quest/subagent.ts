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
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { toolsForRole, extractFinalText, type SubAgentResult } from "./delegate";

export interface SubAgentRequest {
	/** Sub-agent role (scout, worker, …) — drives the tool scope when `tools` is not set. */
	role: string;
	/** The resolved model the sub-agent runs with. */
	model: Model<any>;
	/** Fully-formed instruction sent to the sub-agent (persona + task + context). */
	prompt: string;
	/**
	 * Pre-computed tool allowlist. When provided, this overrides the role-based
	 * default (`toolsForRole`). Callers with sandbox policy should pass
	 * `sandboxToolsForRole(role, profile)` here so write tools are stripped when
	 * sandbox is active.
	 */
	tools?: string[];
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
		const created = await createAgentSession({
			cwd: ctx.cwd,
			model: req.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager: SessionManager.inMemory(),
			tools: req.tools ?? toolsForRole(req.role),
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
