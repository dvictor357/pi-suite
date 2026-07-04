/**
 * quest/delegate.ts — pure delegation logic (Path B).
 *
 * Quest owns delegation: it spawns a real, isolated sub-agent (see
 * ./subagent.ts) running the model the orchestrator assigned and the user
 * approved. This module holds only the model-INDEPENDENT decisions — role →
 * tool scope, model precedence, and output extraction — so they can be
 * unit-tested without loading the SDK runtime. The live spawn (which must import
 * SDK *values*) lives in ./subagent.ts and is kept out of any test path, because
 * importing the SDK as a value fails under the test runner.
 */

import type { SandboxProfile } from "./sandbox";

/**
 * Roles that explore/judge but must not mutate the working tree. They get a
 * read-only tool scope so a misbehaving sub-agent can't edit files.
 */
const READ_ONLY_ROLES = new Set(["scout", "verifier", "reviewer", "planner"]);

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** The tool allowlist a sub-agent of the given role should run with. */
export function toolsForRole(role: string): string[] {
	return READ_ONLY_ROLES.has(role.trim().toLowerCase()) ? [...READ_ONLY_TOOLS] : [...FULL_TOOLS];
}

/**
 * Decide which model id a task's sub-agent should use, in precedence order:
 *   1. a model already assigned to the task (most specific user intent),
 *   2. the current rung of the project's approved model ladder, when the
 *      ladder governs this role (approving the ladder approved every rung,
 *      so this never re-prompts),
 *   3. the project's remembered model for this role (asked once per role),
 *   4. otherwise the orchestrator must propose one and the user must approve.
 *
 * Returns the resolved model id and its source, or `needsPrompt: true` when no
 * source has a model yet.
 */
export function resolveTaskModel(opts: {
	taskModel?: string;
	ladderModel?: string;
	rememberedModel?: string;
}): {
	model?: string;
	needsPrompt: boolean;
	source?: "task" | "ladder" | "memory";
} {
	const fromTask = opts.taskModel?.trim();
	if (fromTask) return { model: fromTask, needsPrompt: false, source: "task" };
	const fromLadder = opts.ladderModel?.trim();
	if (fromLadder) return { model: fromLadder, needsPrompt: false, source: "ladder" };
	const fromMemory = opts.rememberedModel?.trim();
	if (fromMemory) return { model: fromMemory, needsPrompt: false, source: "memory" };
	return { needsPrompt: true };
}

/**
 * Extract the sub-agent's final text answer: the last assistant message's
 * concatenated text blocks. Typed structurally so it needs no SDK imports and
 * stays trivially testable.
 */
export function extractFinalText(
	messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const content = m.content;
		if (!Array.isArray(content)) {
			return typeof content === "string" ? content.trim() : "";
		}
		return content
			.filter(
				(c): c is { type: string; text: string } =>
					!!c &&
					typeof c === "object" &&
					(c as { type?: unknown }).type === "text" &&
					typeof (c as { text?: unknown }).text === "string",
			)
			.map((c) => c.text)
			.join("")
			.trim();
	}
	return "";
}

/**
 * Build a sandbox constraint block for injection into sub-agent prompts.
 *
 * When a sandbox profile is active (restricted or isolated), this returns a
 * human-readable block describing allowed/denied paths, command restrictions,
 * network status, package-install permission, and worktree metadata. Returns
 * an empty string when sandbox is off (mode "none").
 */
export function buildSandboxConstraintBlock(profile?: SandboxProfile): string {
	if (!profile || profile.mode === "none") return "";

	const lines: string[] = [`## Sandbox Constraints (${profile.mode} mode)`];

	if (profile.allowedPaths.length > 0) {
		lines.push(``, `**Allowed files:**`, ...profile.allowedPaths.map((g) => `- \`${g}\``));
	} else {
		lines.push(``, `**Allowed files:** (none — no file access permitted)`);
	}

	if (profile.deniedPaths.length > 0) {
		lines.push(
			``,
			`**Denied files:**`,
			...profile.deniedPaths.slice(0, 8).map((g) => `- \`${g}\``),
		);
		if (profile.deniedPaths.length > 8)
			lines.push(`- … and ${profile.deniedPaths.length - 8} more`);
	}

	if (profile.allowCommands.length > 0) {
		lines.push(``, `**Allowed commands:**`, ...profile.allowCommands.map((c) => `- \`${c}\``));
	} else {
		lines.push(``, `**Allowed commands:** (none — shell access is denied)`);
	}

	if (profile.denyCommands.length > 0) {
		lines.push(
			``,
			`**Denied commands:**`,
			...profile.denyCommands.slice(0, 5).map((c) => `- \`${c}\``),
		);
		if (profile.denyCommands.length > 5)
			lines.push(`- … and ${profile.denyCommands.length - 5} more`);
	}

	if (!profile.allowNetwork) {
		lines.push(``, `**Network access:** ❌ denied`);
	}
	if (!profile.allowPackageInstall) {
		lines.push(``, `**Package install:** ❌ denied`);
	}

	if (profile.worktree) {
		lines.push(
			``,
			`**Worktree isolation:** active`,
			`- Branch: \`${profile.worktree.enabled ? "yes" : "no"}\``,
			`- Base branch: \`${profile.worktree.baseBranch}\``,
			`- Path: \`${profile.worktree.path}\``,
		);
	}

	lines.push(
		``,
		`You MUST respect these constraints. Operating outside them is a policy violation.`,
	);

	return lines.join("\n");
}

/**
 * Build the focused instruction sent to a sub-agent. The orchestrator already
 * wrote the task's `context` and resolved the role's `persona` markdown; this
 * leads with that persona, then frames the role, the task, any upstream results
 * it can build on, sandbox constraints when active, and the project's format
 * directive into one concise prompt. Pure so it can be unit-tested.
 */
export function buildSubAgentPrompt(opts: {
	role: string;
	content: string;
	context?: string;
	persona?: string;
	dependencyResults?: ReadonlyArray<{ content: string; result: string | null }>;
	/** Rendered failure-brief block (see ladder.ts) — what earlier attempts got wrong. */
	failureBriefBlock?: string;
	formatDirective?: string;
	sandboxProfile?: SandboxProfile;
}): string {
	const lines: string[] = [];
	if (opts.persona?.trim()) {
		lines.push(opts.persona.trim(), ``, `---`, ``);
	}
	lines.push(
		`You are a "${opts.role}" sub-agent. Complete exactly this step — nothing more — and report back concisely.`,
		``,
		`## Task`,
		opts.content,
	);
	if (opts.context?.trim()) lines.push(``, `## Context`, opts.context.trim());

	const deps = (opts.dependencyResults ?? []).filter((d) => d.result?.trim());
	if (deps.length) {
		lines.push(``, `## Prior results you can build on`);
		for (const d of deps) lines.push(`- ${d.content}: ${d.result}`);
	}

	// A retry must lead with what failed before, ahead of generic constraints.
	if (opts.failureBriefBlock?.trim()) lines.push(``, opts.failureBriefBlock.trim());

	// Inject sandbox constraints when active
	const sandboxBlock = buildSandboxConstraintBlock(opts.sandboxProfile);
	if (sandboxBlock) lines.push(``, sandboxBlock);

	if (opts.formatDirective?.trim()) lines.push(``, opts.formatDirective.trim());

	lines.push(
		``,
		`When done, reply with a short summary of what you changed or found. Do not ask for confirmation.`,
	);
	return lines.join("\n");
}

/** Final-turn messages shape (structural — no SDK import). */
export type FinalTurnMessages = ReadonlyArray<{ role?: string; content?: unknown }>;

/** A session event as observed by {@link awaitFinalTurn} (structural subset). */
export interface AwaitableSessionEvent {
	type: string;
	willRetry?: boolean;
	messages?: unknown;
}

/** The minimal session surface {@link awaitFinalTurn} needs (structural). */
export interface AwaitableSession {
	subscribe(listener: (ev: AwaitableSessionEvent) => void): () => void;
	dispose(): void;
}

/**
 * Wait for a sub-agent session's final turn, with abort wired into the same
 * promise.
 *
 * This is the subtle bit of the spawn path, pulled out of subagent.ts so it can
 * be unit-tested without loading the SDK runtime. Two things matter:
 *
 * 1. Resolve only on a non-retry `agent_end` — an `agent_end` with
 *    `willRetry` is an interim turn and must be ignored.
 * 2. Reject on abort *in the same promise*, disposing the session. Disposing a
 *    session does not necessarily emit `agent_end`, so without the abort-reject
 *    an awaiter could block forever after the orchestrator aborts.
 *
 * Returns the promise plus a `cleanup` that detaches the abort listener; the
 * caller runs it in a `finally`.
 */
export function awaitFinalTurn(
	session: AwaitableSession,
	signal: AbortSignal | undefined,
): { promise: Promise<FinalTurnMessages>; cleanup: () => void } {
	let onAbort: (() => void) | undefined;

	const promise = new Promise<FinalTurnMessages>((resolve, reject) => {
		const unsubscribe = session.subscribe((ev) => {
			if (ev.type === "agent_end" && !ev.willRetry) {
				unsubscribe();
				resolve((ev.messages ?? []) as FinalTurnMessages);
			}
		});

		if (signal) {
			const abort = () => {
				unsubscribe();
				session.dispose();
				reject(new Error("Aborted by user."));
			};
			if (signal.aborted) {
				abort();
				return;
			}
			onAbort = abort;
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});

	const cleanup = () => {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	};

	return { promise, cleanup };
}
