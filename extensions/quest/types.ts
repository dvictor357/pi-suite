export type QuestStatus = "planning" | "active" | "paused" | "done" | "idle";
export type TaskStatus = "pending" | "running" | "verifying" | "done" | "failed" | "skipped";

export interface QuestTask {
	content: string;
	status: TaskStatus;
	agent: string;
	/**
	 * Model the orchestrator assigned to this task's sub-agent, once the user has
	 * approved it via `quest_assign_model`. Empty/undefined means "use the harness
	 * default for this agent role". Stored as the registry/harness model id.
	 */
	model?: string;
	context: string;
	dependencies: number[];
	result: string | null;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	commitHash: string | null;
	branchName: string | null;
	/**
	 * Per-task sandbox overrides. When present, these tighten (but never loosen)
	 * the quest-level {@link SandboxPolicy}. Absent/undefined means "inherit
	 * quest policy as-is".
	 */
	sandbox?: SandboxOverrides;
}

export interface GitIntegration {
	autoCommit: boolean;
	autoBranch: boolean;
	autoPR: boolean;
	branchPrefix: string;
}

export interface Quest {
	version: 1;
	name: string;
	goal: string;
	status: QuestStatus;
	tasks: QuestTask[];
	tasksSincePause: number;
	lastFiredTaskIndex: number;
	sameTaskCount: number;
	pauseReason: string | null;
	conventions: string[];
	team?: string;
	planningMode: "auto" | "approve";
	planApproved: boolean;
	verifyOnComplete: boolean;
	gitIntegration?: GitIntegration;
	/**
	 * Per-quest sandbox policy. Controls what sub-agents may do (paths, commands,
	 * network, package install). Absent/undefined means sandbox is off (mode =
	 * "none", full access) — backwards-compatible with quests created before
	 * sandbox support.
	 */
	sandbox?: SandboxPolicy;
	commits: {
		taskIndex: number;
		hash: string;
		message: string;
		branch?: string;
		timestamp: number;
	}[];
	researchFindings?: { key: string; value: string; category?: string; timestamp: number }[];
	createdAt: number;
	completedAt: number | null;
	updatedAt: number;
}

export interface TeamConfig {
	name: string;
	description: string;
	lead: string;
	members: { role: string; agent: string }[];
	defaultAgent: string;
	verification: boolean;
	agents?: { name: string; description: string; markdown: string }[];
	/**
	 * Optional per-agent-role model suggestions (agent role → model id) the team
	 * recommends, e.g. a fast/cheap model for "scout" and a strong model for
	 * "worker". Advisory only: the orchestrator may override, and the user always
	 * gets the final say via `quest_assign_model`.
	 */
	modelHints?: Record<string, string>;
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

/**
 * Sandbox mode controlling sub-agent isolation level.
 *
 * - `"none"` (default) — full tool access, no path/cmd restrictions.
 * - `"restricted"` — prompt/tool-scope sandbox: policy constraints are injected
 *   into sub-agent prompts and checked by verifiers; write/shell tools are
 *   reduced where possible.
 * - `"isolated"` — restricted mode plus worktree metadata for task isolation;
 *   the current MVP plans/records worktrees but does not execute OS isolation.
 */
export type SandboxMode = "none" | "restricted" | "isolated";

/**
 * Per-quest sandbox policy stored on {@link Quest.sandbox}.
 *
 * Controls what this quest's sub-agents are instructed and tool-scoped to do.
 * When absent, the quest has no sandbox (mode = "none", full access) —
 * backwards-compatible. Current MVP enforcement is prompt/tool-scope based, not
 * an OS-level path or network sandbox.
 */
export interface SandboxPolicy {
	/** Sandbox mode. Defaults to "none" when absent. */
	mode: SandboxMode;
	/**
	 * Allowed path globs (relative to cwd). In restricted/isolated mode, these are
	 * injected into prompts and checked by verifiers. An empty array means the
	 * policy says "no paths allowed".
	 */
	allowedPaths: string[];
	/**
	 * Denied path globs. Even paths matching an allowed glob are policy violations
	 * if they also match a denied glob. Empty means "no denials beyond the
	 * allow-list".
	 */
	deniedPaths: string[];
	/**
	 * Allowed command prefixes or patterns. In restricted/isolated mode, these are
	 * injected into prompts and used to decide whether bash is exposed. An empty
	 * array means the policy says "no commands allowed".
	 */
	allowCommands: string[];
	/**
	 * Denied command patterns. Even commands matching an allowed pattern are policy
	 * violations if they also match a denied pattern. Empty means "no denials
	 * beyond the allow-list".
	 */
	denyCommands: string[];
	/** Whether network access is permitted. Default true for "none" mode. */
	allowNetwork: boolean;
	/**
	 * Whether package-install commands (npm install, pip install, cargo add, …)
	 * are permitted by policy. Verifiers check this; command classifiers are pure
	 * helpers for future runtime hooks.
	 */
	allowPackageInstall: boolean;
	/**
	 * Worktree isolation metadata. Meaningful when mode is "isolated"; ignored
	 * otherwise. Null means worktree isolation is not configured. Current MVP only
	 * records/plans worktrees; it does not automatically create or remove them.
	 */
	worktree: WorktreeConfig | null;
}

/**
 * Per-task sandbox overrides stored on {@link QuestTask.sandbox}.
 *
 * A task may tighten (restrict further) the quest-level policy but never loosen
 * it. Absent/undefined means "inherit quest policy as-is". When present, the
 * resolved profile is the intersection of quest policy and task overrides —
 * always at least as restrictive as the quest-level policy.
 */
export interface SandboxOverrides {
	/**
	 * Override the sandbox mode. Can only escalate: "none" → "restricted" →
	 * "isolated". A task can never de-escalate the quest-level mode.
	 */
	mode?: SandboxMode;
	/** Additional allowed path globs (intersect with quest-level). */
	allowedPaths?: string[];
	/** Additional denied path globs (union with quest-level). */
	deniedPaths?: string[];
	/** Additional allowed commands (intersect with quest-level). */
	allowCommands?: string[];
	/** Additional denied commands (union with quest-level). */
	denyCommands?: string[];
	/**
	 * Override network access. Can only go true → false. When the quest already
	 * denies network, setting this to true has no effect.
	 */
	allowNetwork?: boolean;
	/**
	 * Override package-install permission. Can only go true → false. When the
	 * quest already denies it, setting this to true has no effect.
	 */
	allowPackageInstall?: boolean;
}

/**
 * Worktree isolation configuration. Only meaningful when {@link SandboxPolicy.mode}
 * is "isolated".
 */
export interface WorktreeConfig {
	/** Whether worktree isolation is enabled. */
	enabled: boolean;
	/** Branch to base the worktree on (e.g. "main", "master"). */
	baseBranch: string;
	/** Worktree path relative to project root (e.g. ".pi/worktrees/<quest-name>"). */
	path: string;
	/** Whether to prune the worktree after quest completion. */
	autoCleanup: boolean;
}

// The todo-sync shapes are the cross-extension pi-todo contract — re-exported
// from core so quest and pi-todo can never drift apart.
export type {
	TodoStatus as SyncedTodoStatus,
	TodoItem as SyncedTodoItem,
	TodoList as SyncedTodoList,
} from "../../core";
