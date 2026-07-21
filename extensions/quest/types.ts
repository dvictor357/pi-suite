import type { FailureBrief } from "./ladder";
import type { StepEvidence } from "./evidence";

export type QuestStatus = "planning" | "active" | "paused" | "done" | "idle";
/** Backward-compatible summary consumed by todo/kanban and older pi-suite releases. */
export type StepStatus = "pending" | "running" | "verifying" | "done" | "failed" | "skipped";
/** Persisted execution phase. `status` remains the coarse compatibility projection. */
export type StepPhase =
	| "queued"
	| "dispatching"
	| "running"
	| "checking"
	| "verifying"
	| "retrying"
	| "blocked"
	| "done"
	| "failed"
	| "skipped";

export interface ParallelConfig {
	enabled: boolean;
	maxConcurrent?: number;
	stepTimeoutMs?: number;
}

/** Bounded completion data passed only to steps that directly depend on this step. */
export interface StepHandoff {
	version: 1;
	summary: string;
	filesChanged: string[];
	verification: string[];
	notes?: string;
}

export interface QuestStep {
	content: string;
	status: StepStatus;
	/** Durable fine-grained phase; absent legacy steps are derived from `status`. */
	phase?: StepPhase;
	phaseChangedAt?: number;
	/** Stable per-attempt token used for duplicate-dispatch protection and restart evidence. */
	dispatchId?: string;
	agent: string;
	/**
	 * Model the orchestrator assigned to this step's sub-agent, once the user has
	 * approved it via `quest_assign_model`. Empty/undefined means "use the harness
	 * default for this agent role". Stored as the registry/harness model id.
	 */
	model?: string;
	context: string;
	dependencies: number[];
	result: string | null;
	/** Structured, bounded completion summary for dependency handoff. */
	handoff?: StepHandoff;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	/**
	 * How many inconclusive verifier replies this step has consumed while
	 * verifying. After one re-prompt (count reaches 1), the gate auto-fails
	 * with MODEL_QUALITY. Optional for legacy steps.
	 */
	verifyInconclusives?: number;
	commitHash: string | null;
	branchName: string | null;
	/**
	 * Current model-ladder rung index (see ladder.ts). Undefined means the ladder
	 * does not govern this step — legacy steps, explicit model assignments, or
	 * projects with no approved ladder.
	 */
	rung?: number;
	/** How many rung escalations this step has consumed. */
	escalations?: number;
	/**
	 * Distilled verified-failure records, newest last; rendered into retry
	 * prompts instead of appending evidence onto {@link context} unboundedly.
	 */
	failureBriefs?: FailureBrief[];
	/**
	 * Model id the last delegation actually ran with, whichever source resolved
	 * it (explicit, ladder, remembered, or harness default). Stamped so eval
	 * entries always know the model — {@link model} is only the explicit override.
	 */
	lastModel?: string;
	/**
	 * Per-step sandbox overrides. When present, these tighten (but never loosen)
	 * the quest-level {@link SandboxPolicy}. Absent/undefined means "inherit
	 * quest policy as-is".
	 */
	sandbox?: SandboxOverrides;
	/**
	 * Per-step sandbox/tool-call artifacts populated during isolated-mode
	 * delegation. Records every guarded tool call (allowed/blocked), touched
	 * paths, changed files from git diff, the commit hash, and the worktree
	 * path. Absent when the step hasn't been delegated yet or the sandbox is
	 * off.
	 */
	sandboxArtifacts?: SandboxArtifacts;
	/**
	 * Repo HEAD SHA captured when this step fired (runtime.ts fireStep). The
	 * deterministic verification gate diffs against it so a step's changed files
	 * are attributable even across intermediate commits. Absent for steps that
	 * fired before evidence capture existed, or outside a git repo.
	 */
	baselineSha?: string;
	/**
	 * Objective evidence gathered by the verification gate — changed files, diff
	 * stat, and deterministic check outcomes (see evidence.ts). Populated when the
	 * step enters verification; absent before then.
	 */
	evidence?: StepEvidence;
	/**
	 * Paths this step declares it will write to. The orchestrator uses these to
	 * prevent overlapping concurrent writes.
	 * Paths are relative to cwd. Absent/empty = no write claims (backward-compatible).
	 */
	writeClaim?: string[];
	/**
	 * Paths this step declares it needs to read. Paths are validated within cwd.
	 */
	readClaim?: string[];
}

/** One guarded-tool-call log entry (the core artifact record). */
export interface SandboxCallRecord {
	/** Tool name that was invoked (e.g. "bash", "edit"). */
	tool: string;
	/** The tool-call arguments at invocation time. */
	input: Record<string, unknown>;
	/** Whether the call was blocked by sandbox policy. */
	blocked: boolean;
	/** Policy reason when blocked; absent for allowed calls. */
	reason?: string;
	/** Epoch-ms timestamp. */
	timestamp: number;
}

/** Sandbox telemetry collected during a single step delegation. */
export interface SandboxArtifacts {
	/** Every guarded tool call made by the sub-agent (allowed + blocked). */
	calls: SandboxCallRecord[];
	/** Write-tool paths touched across all calls (deduplicated). */
	touchedPaths: string[];
	/** Files changed according to git diff --name-only at step end. */
	changedFiles?: string[];
	/** Commit hash when the sub-agent committed its work. */
	commitHash?: string;
	/** Absolute worktree path used during isolated-mode delegation. */
	worktreePath?: string;
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
	steps: QuestStep[];
	/**
	 * Legacy mirror for downgrade compatibility. New code treats {@link steps} as
	 * canonical, but persists this field during the transition so older releases
	 * can still read active/archive quest files.
	 *
	 * @deprecated Use steps.
	 */
	tasks?: QuestStep[];
	stepsSincePause: number;
	lastFiredStepIndex: number;
	sameStepCount: number;
	/** @deprecated Use stepsSincePause. */
	tasksSincePause?: number;
	/** @deprecated Use lastFiredStepIndex. */
	lastFiredTaskIndex?: number;
	/** @deprecated Use sameStepCount. */
	sameTaskCount?: number;
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
	/**
	 * Opt-in parallel dispatch config. When enabled, dependency-ready non-overlapping
	 * steps are dispatched in batches instead of one-at-a-time. Sequential remains
	 * the default. Absent/undefined means parallel is off.
	 */
	parallel?: ParallelConfig;
	commits: {
		stepIndex: number;
		/** @deprecated Use stepIndex. */
		taskIndex?: number;
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
	/**
	 * Optional ordered cheap→frontier model ladder the team recommends for its
	 * execution roles. Advisory only, exactly like {@link modelHints}: it seeds
	 * the orchestrator's `quest_assign_ladder` proposal but activates nothing
	 * until the user approves — teams load from user-writable JSON and must not
	 * silently choose models.
	 */
	modelLadder?: string[];
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

/**
 * Sandbox mode controlling sub-agent isolation level.
 *
 * - `"none"` (default) — full tool access, no path/cmd restrictions.
 * - `"restricted"` — policy is enforced at the tool-call boundary: the
 *   orchestrator's tool calls are blocked via pi's `tool_call` hook and the
 *   sub-agent runs with guarded tool definitions (see sandbox-guard.ts), plus
 *   read-only role scoping. Prompt constraints and verifier checks are advisory
 *   on top. Not OS-level isolation.
 * - `"isolated"` — restricted mode plus real git worktree isolation: a worktree
 *   is created per delegation, the sub-agent runs inside it, and the worktree is
 *   cleaned up after the step completes. Worktree metadata and sandbox artifacts
 *   are recorded on the step.
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
	 * otherwise. Null means worktree isolation is not configured.
	 */
	worktree: WorktreeConfig | null;
}

/**
 * Per-step sandbox overrides stored on {@link QuestStep.sandbox}.
 *
 * A step may tighten (restrict further) the quest-level policy but never loosen
 * it. Absent/undefined means "inherit quest policy as-is". When present, the
 * resolved profile is the intersection of quest policy and step overrides —
 * always at least as restrictive as the quest-level policy.
 */
export interface SandboxOverrides {
	/**
	 * Override the sandbox mode. Can only escalate: "none" → "restricted" →
	 * "isolated". A step can never de-escalate the quest-level mode.
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
