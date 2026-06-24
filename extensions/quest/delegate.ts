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
 *   1. a model already assigned to the task,
 *   2. the project's remembered model for this role (asked once per role),
 *   3. otherwise the orchestrator must propose one and the user must approve.
 *
 * Returns the resolved model id, or `needsPrompt: true` when neither source has
 * a model yet.
 */
export function resolveTaskModel(opts: { taskModel?: string; rememberedModel?: string }): {
	model?: string;
	needsPrompt: boolean;
} {
	const fromTask = opts.taskModel?.trim();
	if (fromTask) return { model: fromTask, needsPrompt: false };
	const fromMemory = opts.rememberedModel?.trim();
	if (fromMemory) return { model: fromMemory, needsPrompt: false };
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

export interface SubAgentResult {
	ok: boolean;
	output: string;
	error?: string;
}

/**
 * Build the focused instruction sent to a sub-agent. The orchestrator already
 * wrote the task's `context` and resolved the role's `persona` markdown; this
 * leads with that persona, then frames the role, the task, any upstream results
 * it can build on, and the project's format directive into one concise prompt.
 * Pure so it can be unit-tested.
 */
export function buildSubAgentPrompt(opts: {
	role: string;
	content: string;
	context?: string;
	persona?: string;
	dependencyResults?: ReadonlyArray<{ content: string; result: string | null }>;
	formatDirective?: string;
}): string {
	const lines: string[] = [];
	if (opts.persona?.trim()) {
		lines.push(opts.persona.trim(), ``, `---`, ``);
	}
	lines.push(
		`You are a "${opts.role}" sub-agent. Complete exactly this task — nothing more — and report back concisely.`,
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
	if (opts.formatDirective?.trim()) lines.push(``, opts.formatDirective.trim());

	lines.push(
		``,
		`When done, reply with a short summary of what you changed or found. Do not ask for confirmation.`,
	);
	return lines.join("\n");
}
