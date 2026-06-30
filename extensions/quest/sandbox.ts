/**
 * quest/sandbox.ts — pure sandbox policy resolution.
 *
 * Quest-level policy + per-step overrides → a resolved runtime profile used at
 * sub-agent spawn time. All functions are pure and SDK-free so they can be
 * unit-tested (like delegate.ts).
 */
import type { SandboxMode, SandboxPolicy, SandboxOverrides, WorktreeConfig } from "./types";

/**
 * Resolved runtime sandbox profile computed from quest-level policy and
 * per-step overrides. This is the shape consumed by the sub-agent spawn path
 * (subagent.ts) when deciding tool scope, path filtering, and isolation.
 */
export interface SandboxProfile {
	/** Resolved sandbox mode (at least as restrictive as quest-level). */
	mode: SandboxMode;
	/** Resolved allowed path globs. Empty = no paths allowed. */
	allowedPaths: string[];
	/** Resolved denied path globs. */
	deniedPaths: string[];
	/** Resolved allowed commands. Empty = no commands allowed. */
	allowCommands: string[];
	/** Resolved denied commands. */
	denyCommands: string[];
	/** Whether network access is permitted. */
	allowNetwork: boolean;
	/** Whether package-install commands are permitted. */
	allowPackageInstall: boolean;
	/** Worktree config when mode is "isolated"; null otherwise. */
	worktree: WorktreeConfig | null;
}

/** Default sandbox policy when none is configured (mode "none", full access). */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
	mode: "none",
	allowedPaths: [],
	deniedPaths: [],
	allowCommands: [],
	denyCommands: [],
	allowNetwork: true,
	allowPackageInstall: true,
	worktree: null,
};

/** Sandbox modes ordered from least to most restrictive. */
const MODE_ORDER: Record<SandboxMode, number> = { none: 0, restricted: 1, isolated: 2 };

/**
 * Resolve a runtime {@link SandboxProfile} from quest-level policy and optional
 * per-step overrides.
 *
 * Rules:
 * 1. If `policy` is undefined, use {@link DEFAULT_SANDBOX_POLICY}.
 * 2. Step overrides can only tighten — never loosen — the quest-level policy.
 * 3. Mode escalation: a step can go from "none" → "restricted", "none" → "isolated",
 *    or "restricted" → "isolated", but never the reverse.
 * 4. Path/command lists: task-level allowed paths intersect with quest-level;
 *    task-level denied paths are unioned.
 * 5. Boolean flags (allowNetwork, allowPackageInstall): step override takes effect
 *    only when it's more restrictive (true → false).
 * 6. Worktree: uses quest-level config; step overrides don't carry worktree metadata.
 */
export function resolveSandboxProfile(
	policy?: SandboxPolicy,
	overrides?: SandboxOverrides,
): SandboxProfile {
	const base = policy ?? DEFAULT_SANDBOX_POLICY;

	// ── Mode ──────────────────────────────────────────────────────────────
	let mode = base.mode;
	if (overrides?.mode) {
		const baseRank = MODE_ORDER[base.mode];
		const overrideRank = MODE_ORDER[overrides.mode];
		if (overrideRank > baseRank) mode = overrides.mode;
		// overrideRank <= baseRank → attempted de-escalation; silently keep base
	}

	// ── Allowed paths (intersect) ─────────────────────────────────────────
	const questAllowed = base.allowedPaths ?? [];
	const taskAllowed = overrides?.allowedPaths;
	let allowedPaths: string[];
	if (questAllowed.length === 0 && mode !== "none") {
		// Quest-level deny-all in restricted/isolated mode. Step overrides CANNOT
		// add back what the quest denies — the intersection stays empty.
		allowedPaths = [];
	} else if (taskAllowed && taskAllowed.length > 0) {
		if (questAllowed.length === 0) {
			// mode is "none": empty quest allow-list is full access, so task-level
			// overrides can introduce restrictions.
			allowedPaths = taskAllowed;
		} else {
			allowedPaths = intersectGlobs(questAllowed, taskAllowed);
		}
	} else {
		allowedPaths = [...questAllowed];
	}

	// ── Denied paths (union) + mandatory sensitive denies ────────────
	const deniedPaths = unionGlobs(
		SENSITIVE_DENIED_GLOBS,
		unionGlobs(base.deniedPaths ?? [], overrides?.deniedPaths ?? []),
	);

	// ── Allowed commands (intersect) ──────────────────────────────────────
	const questCmds = base.allowCommands ?? [];
	const taskCmds = overrides?.allowCommands;
	let allowCommands: string[];
	if (questCmds.length === 0 && mode !== "none") {
		// Quest-level deny-all in restricted/isolated mode.
		allowCommands = [];
	} else if (taskCmds && taskCmds.length > 0) {
		if (questCmds.length === 0) {
			// mode is "none": empty quest allow-list is full access.
			allowCommands = taskCmds;
		} else {
			allowCommands = intersectGlobs(questCmds, taskCmds);
		}
	} else {
		allowCommands = [...questCmds];
	}

	// ── Denied commands (union) ───────────────────────────────────────────
	const denyCommands = unionGlobs(base.denyCommands ?? [], overrides?.denyCommands ?? []);

	// ── Boolean flags (only tighten) ──────────────────────────────────────
	const allowNetwork = tightenBoolean(base.allowNetwork, overrides?.allowNetwork);
	const allowPackageInstall = tightenBoolean(
		base.allowPackageInstall,
		overrides?.allowPackageInstall,
	);

	// ── Worktree (quest-level only) ───────────────────────────────────────
	const worktree = mode === "isolated" ? (base.worktree ?? null) : null;

	return {
		mode,
		allowedPaths,
		deniedPaths,
		allowCommands,
		denyCommands,
		allowNetwork,
		allowPackageInstall,
		worktree,
	};
}

/**
 * Return true if `sandbox.mode` is active (anything other than "none").
 * Useful for gating sandbox runtime paths without checking multiple modes.
 */
export function isSandboxActive(profile: SandboxProfile): boolean {
	return profile.mode !== "none";
}

/**
 * Compute the effective tool scope for a sandboxed sub-agent.
 *
 * When sandbox is "none", sub-agents get their normal role-based tools. When
 * sandbox is "restricted" or "isolated", we remove write-capable tools ("edit",
 * "write") from the scope. If no commands are allowed, we also remove "bash"
 * so the tool scope matches the prompt-level shell policy.
 *
 * Returns null when `roleTools` is null (caller defers to its own defaults).
 */
export function sandboxedTools(
	profile: SandboxProfile,
	roleTools: string[] | null,
): string[] | null {
	if (!isSandboxActive(profile)) return roleTools; // no sandbox → no change
	return filterSandboxTools(profile, roleTools ?? []);
}

/** Intersection of two glob lists: entries that appear in both. */
function intersectGlobs(a: string[], b: string[]): string[] {
	const setB = new Set(b);
	return a.filter((g) => setB.has(g));
}

/** Union of two glob lists, deduplicated. */
function unionGlobs(a: string[], b: string[]): string[] {
	return [...new Set([...a, ...b])];
}

/**
 * Tighten a boolean: base is the quest-level value, override comes from the
 * task. The result is at least as restrictive as the base — override can only
 * flip true → false, never false → true.
 */
function tightenBoolean(base: boolean, override?: boolean): boolean {
	if (override === undefined) return base;
	return base && override;
}

// ── Role-based sandbox tool defaults ────────────────────────────────────────

/** Roles that explore/judge but must not mutate the working tree. */
const READ_ONLY_SANDBOX_ROLES = new Set(["planner", "scout", "reviewer", "verifier"]);

/** Read-only tool scope for sandboxed roles. */
const READ_ONLY_SANDBOX_TOOLS = ["read", "grep", "find", "ls"];

/** Write-capable tool scope for worker roles. */
const WRITE_CAPABLE_SANDBOX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Compute the effective tool scope for a sub-agent role, optionally bounded
 * by a sandbox profile.
 *
 * Role defaults encode the project's security posture:
 * - planner, scout, reviewer, verifier → read-only (read, grep, find, ls)
 * - worker (or any unrecognized role) → full-edit within allowed scope
 *
 * When sandbox is active (restricted or isolated), write-capable tools
 * (edit, write) are removed from the scope regardless of role. When no commands
 * are allowed, bash is removed too so shell access is actually denied.
 */
export function sandboxToolsForRole(role: string, profile?: SandboxProfile): string[] {
	const normalizedRole = role.trim().toLowerCase();
	const isReadOnly = READ_ONLY_SANDBOX_ROLES.has(normalizedRole);
	const baseTools = isReadOnly ? [...READ_ONLY_SANDBOX_TOOLS] : [...WRITE_CAPABLE_SANDBOX_TOOLS];

	if (profile && isSandboxActive(profile)) {
		return filterSandboxTools(profile, baseTools);
	}

	return baseTools;
}

function filterSandboxTools(profile: SandboxProfile, tools: string[]): string[] {
	return tools.filter((tool) => {
		if (tool === "edit" || tool === "write") return false;
		if (tool === "bash" && profile.allowCommands.length === 0) return false;
		return true;
	});
}

/** Tools that carry a sandbox guard when handed to a sub-agent (write/shell). */
export const GUARDED_SANDBOX_TOOLS = ["bash", "edit", "write"] as const;

/**
 * Plan the concrete tool set a sandboxed sub-agent should receive.
 *
 * Unlike {@link sandboxToolsForRole} (which bluntly strips write/edit so a
 * sandboxed worker cannot write at all), this returns the tools the sub-agent
 * keeps when the spawn path wraps {@link GUARDED_SANDBOX_TOOLS} with the
 * tool-call guard (see sandbox-guard.ts). Granular path/command enforcement then
 * happens per call rather than denying file work outright:
 *
 * - read-only roles (planner/scout/reviewer/verifier) → read-only tools only;
 * - write-capable roles → read-only tools + guarded edit + write, plus guarded
 *   bash only when the policy lists allowed commands (shell stays gated by the
 *   allow-list, matching {@link filterSandboxTools}).
 *
 * Pure — the caller turns these names into (guarded) tool definitions.
 */
export function sandboxToolPlan(role: string, profile: SandboxProfile): string[] {
	const normalizedRole = role.trim().toLowerCase();
	if (READ_ONLY_SANDBOX_ROLES.has(normalizedRole)) return [...READ_ONLY_SANDBOX_TOOLS];
	const names = [...READ_ONLY_SANDBOX_TOOLS, "edit", "write"];
	if (profile.allowCommands.length > 0) names.push("bash");
	return names;
}

// ── Sensitive file deny list ────────────────────────────────────────────────

/**
 * Glob patterns that should always be denied regardless of the allowed-paths
 * list. These protect credentials, keys, secrets, and other high-risk files
 * from accidental exposure or modification by sub-agents.
 */
export const SENSITIVE_DENIED_GLOBS: string[] = [
	"**/.env*",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/*.crt",
	"**/*.cer",
	"**/id_rsa*",
	"**/id_ed25519*",
	"**/id_ecdsa*",
	"**/id_dsa*",
	"**/authorized_keys",
	"**/known_hosts",
	"**/secrets.*",
	"**/credentials*",
	"**/.token",
	"**/.secret",
	"**/.passwd*",
	"**/master.key",
	"**/credentials.yml",
	"**/service-account*.json",
	"**/.gc*",
];

/**
 * Returns a fresh copy of {@link SENSITIVE_DENIED_GLOBS} for callers that
 * need to compose or extend it without mutating the constant.
 */
export function getSensitiveDeniedPaths(): string[] {
	return [...SENSITIVE_DENIED_GLOBS];
}

// ── Command classification ──────────────────────────────────────────────────

/** Classification label for a shell command. */
export type CommandClass =
	| "package-install"
	| "destructive"
	| "network"
	| "build"
	| "test"
	| "shell";

/** Patterns matching known package-manager install/add commands. */
const PACKAGE_INSTALL_PATTERNS: RegExp[] = [
	/^(?:npm|yarn|pnpm|bun)\s+(?:install|add|i)\b/,
	/^(?:pip|pip3)\s+install\b/,
	/^(?:gem)\s+install\b/,
	/^(?:cargo)\s+(?:install|add)\b/,
	/^(?:composer)\s+(?:install|require)\b/,
	/^(?:go)\s+(?:get|install)\b/,
	/^(?:brew)\s+install\b/,
	/^(?:apt|apt-get|dnf|yum|pacman|zypper)\s+install\b/,
	/^(?:nix)\s+(?:profile|env)\s+install\b/,
	/^(?:nuget)\s+(?:install|restore)\b/,
];

/** Patterns matching destructive commands (force-delete, wipe, partition). */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/^(?:rm|sudo\s+rm)\b/,
	/^(?:sudo)\s+mv\b/,
	/^(?:dd|mkfs|fdisk|parted)\b/,
	/^(?:>|\|)\s*(?:\/dev\/)/,
	/^(?:chown|chmod)\s(?:-R\s)?[^,]+(?:\s|$)/,
	/^(?:git)\s+push\s+(?:--force|--delete)\b/,
	/^(?:git)\s+reset\s+--hard\b/,
	/^(?:git)\s+clean\s+-[df]+\b/,
	/^(?:docker|podman)\s+(?:rm|prune|system\s+prune)\b/,
	/^(?:kubectl|kubectx)\s+delete\b/,
	/^(?:heroku|fly|railway|vercel)\s+(?:destroy|delete)\b/,
];

/** Patterns matching network-access commands (curl, ssh, git fetch, etc.). */
const NETWORK_PATTERNS: RegExp[] = [
	/^(?:curl|wget|httpie|ncat|nc)\b/,
	/^(?:ssh|scp|sftp|rsync)\b/,
	/^(?:git)\s+(?:clone|fetch|pull|push)\b/,
	/^(?:aws|gcloud|az|doctl)\b/,
	/^(?:docker|podman)\s+(?:pull|push|login)\b/,
];

/** Patterns matching build/compile commands. */
const BUILD_PATTERNS: RegExp[] = [
	/^(?:npm|yarn|pnpm|bun)\s+run\s+build\b/,
	/^(?:npm|yarn|pnpm|bun)\s+(?:rebuild|run-script)\b/,
	/^(?:make|cmake|ninja|gcc|clang|rustc|javac|tsc)\b/,
	/^(?:cargo)\s+build\b/,
	/^(?:gradle|mvn|sbt)\b/,
	/^(?:docker|podman)\s+(?:build|compose)\b/,
	/^(?:go)\s+build\b/,
	/^(?:dotnet)\s+build\b/,
];

/** Patterns matching test-runner commands. */
const TEST_PATTERNS: RegExp[] = [
	/^(?:npm|yarn|pnpm|bun)\s+(?:test|run\s+test)\b/,
	/^(?:npm|yarn|pnpm|bun)\s+run\s+\S+test\b/,
	/^(?:cargo)\s+test\b/,
	/^(?:pytest|vitest|jest|mocha|ava|tap)\b/,
	/^(?:npx)\s+(?:vitest|jest|mocha|ava)\b/,
	/^(?:go)\s+test\b/,
	/^(?:dotnet)\s+test\b/,
	/^(?:rspec|minitest|phpunit)\b/,
	/^(?:gradle|mvn|sbt)\s+test\b/,
];

/**
 * Classify a shell command string into one of the known {@link CommandClass}
 * categories. Returns the most specific match first: package-install is
 * checked before destructive to avoid ambiguity. Falls back to "shell" when
 * no pattern matches.
 */
export function classifyCommand(cmd: string): CommandClass | null {
	const trimmed = cmd.trim();
	if (!trimmed) return null;

	for (const pattern of PACKAGE_INSTALL_PATTERNS) {
		if (pattern.test(trimmed)) return "package-install";
	}
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(trimmed)) return "destructive";
	}
	for (const pattern of NETWORK_PATTERNS) {
		if (pattern.test(trimmed)) return "network";
	}
	for (const pattern of BUILD_PATTERNS) {
		if (pattern.test(trimmed)) return "build";
	}
	for (const pattern of TEST_PATTERNS) {
		if (pattern.test(trimmed)) return "test";
	}

	return "shell";
}

/** True when the command is a package-manager install/add invocation. */
export function isPackageInstallCommand(cmd: string): boolean {
	return classifyCommand(cmd) === "package-install";
}

/** True when the command is destructive (force-delete, wipe, partition, etc.). */
export function isDestructiveCommand(cmd: string): boolean {
	return classifyCommand(cmd) === "destructive";
}

// ── Branch & worktree naming ────────────────────────────────────────────────

/** Characters not valid or safe to use in a git branch name. */
const BRANCH_UNSAFE = /[^a-zA-Z0-9._\/-]/g;

/** Collapse runs of repeated separators into one. */
const BRANCH_COLLAPSE = /[-_.\/]{2,}/g;

/** Strip leading/trailing separators (git rejects refs starting or ending with .). */
const BRANCH_EDGE = /^[-_.\/]|[-_.\/]$/g;

/** Maximum length git allows for a ref name. */
const BRANCH_MAX_LENGTH = 240;

/**
 * Sanitize an arbitrary string into a git-safe branch name component.
 * Lowercases, replaces unsafe chars with hyphens, collapses repeated
 * separators, and truncates to the git ref-name limit.
 */
export function sanitizeBranchName(name: string): string {
	let sanitized = name
		.trim()
		.toLowerCase()
		.replace(BRANCH_UNSAFE, "-")
		.replace(BRANCH_COLLAPSE, "-")
		.replace(BRANCH_EDGE, "")
		.slice(0, BRANCH_MAX_LENGTH);

	return sanitized || "task";
}

/**
 * Build a deterministic branch name for a quest (and optionally a step within
 * that quest). Format: `quest/<quest-name>` or `quest/<quest-name>/task-<index>`.
 * Names are sanitized via {@link sanitizeBranchName}.
 */
export function questBranchName(questName: string, taskIndex?: number): string {
	const base = sanitizeBranchName(questName);
	if (taskIndex !== undefined) {
		return `quest/${base}/task-${taskIndex}`;
	}
	return `quest/${base}`;
}

/**
 * Build a deterministic worktree path for a quest. Format: `.pi/worktrees/<quest-name>`.
 * The quest name is sanitized via {@link sanitizeBranchName}.
 */
export function worktreePath(questName: string): string {
	const safe = sanitizeBranchName(questName);
	return `.pi/worktrees/${safe}`;
}

// ── Worktree lifecycle helpers ──────────────────────────────────────────────

/**
 * The resolved plan for a worktree — branch, path, base, and cleanup policy.
 * Pure metadata; no shell execution lives here.
 */
export interface WorktreePlan {
	/** The git branch name for this worktree. */
	branchName: string;
	/** Path on disk where the worktree should be created (relative to project root). */
	worktreePath: string;
	/** The parent branch to base the worktree on. */
	baseBranch: string;
	/** Whether the worktree should be cleaned up after quest completion. */
	autoCleanup: boolean;
}

/**
 * Rollback snapshot captured at worktree creation time.
 * Stored alongside the quest so rollback knows exactly what to undo.
 */
export interface WorktreeSnapshot {
	/** Quest name this snapshot belongs to. */
	questName: string;
	/** The branch name that was checked out. */
	branchName: string;
	/** Full relative path to the worktree on disk. */
	worktreePath: string;
	/** The base branch the worktree was forked from. */
	baseBranch: string;
	/** Epoch ms when the worktree was created. */
	createdAt: number;
}

/**
 * A conservative cleanup instruction. Describes *what* to clean up but never
 * executes shell commands — the caller must wire these to an explicit tool or
 * command pathway.
 */
export interface CleanupAction {
	/** Whether cleanup should be performed. */
	shouldCleanup: boolean;
	/** Human-readable reason for cleanup (or skip). */
	reason: string;
	/** Relative path to the worktree on disk. */
	worktreePath: string;
	/** The branch name to delete after pruning. */
	branchName: string;
	/**
	 * Shell command to prune the worktree (display-only; NOT executed by this module).
	 * Caller must gate this behind an explicit user action or tool call.
	 */
	pruneCommand: string;
	/**
	 * Shell command to delete the branch (display-only; NOT executed by this module).
	 * Caller must gate this behind an explicit user action or tool call.
	 */
	deleteBranchCommand: string;
}

/**
 * Compute the full worktree plan from quest-level sandbox config.
 *
 * Returns `null` when worktree isolation is not configured — the caller skips
 * the worktree spawn path entirely. Otherwise returns a deterministic plan
 * with branch name, path, base branch, and cleanup policy.
 */
export function computeWorktreePlan(opts: {
	questName: string;
	worktree: WorktreeConfig | null | undefined;
	sandboxMode: SandboxMode | undefined;
	taskIndex?: number;
}): WorktreePlan | null {
	const { questName, worktree, sandboxMode, taskIndex } = opts;
	if (sandboxMode !== "isolated") return null;
	if (!worktree?.enabled) return null;

	const branchName = questBranchName(questName, taskIndex);
	const wtPath = worktree.path?.trim() || worktreePath(questName);
	const baseBranch = worktree.baseBranch?.trim() || "main";
	const autoCleanup = worktree.autoCleanup !== false; // default true

	return { branchName, worktreePath: wtPath, baseBranch, autoCleanup };
}

/**
 * Build a rollback snapshot for a freshly created worktree.
 * Callers should persist this alongside the quest state so rollback can
 * reconstruct what needs to be undone even if the quest is abandoned.
 */
export function buildWorktreeSnapshot(questName: string, plan: WorktreePlan): WorktreeSnapshot {
	return {
		questName,
		branchName: plan.branchName,
		worktreePath: plan.worktreePath,
		baseBranch: plan.baseBranch,
		createdAt: Date.now(),
	};
}

/**
 * Determine the cleanup intent for a worktree given its plan and snapshot.
 *
 * Conservative guard: cleanup is only recommended when `plan.autoCleanup` is
 * true AND a snapshot exists confirming the worktree was actually created.
 *
 * **Destructive actions are never performed here.** This function returns
 * display-only shell commands — the caller must route them through an explicit
 * tool (e.g. `quest_worktree_cleanup`) or user command (`/quest worktree cleanup`).
 */
export function cleanupIntent(
	plan: WorktreePlan,
	snapshot: WorktreeSnapshot | null,
): CleanupAction | null {
	// Conservative guard: no snapshot means we don't know what to clean up.
	if (!snapshot) {
		return {
			shouldCleanup: false,
			reason: "No rollback snapshot found — cannot determine cleanup scope.",
			worktreePath: plan.worktreePath,
			branchName: plan.branchName,
			pruneCommand: "",
			deleteBranchCommand: "",
		};
	}

	if (!plan.autoCleanup) {
		return {
			shouldCleanup: false,
			reason: `autoCleanup is disabled for worktree "${plan.worktreePath}".`,
			worktreePath: plan.worktreePath,
			branchName: plan.branchName,
			pruneCommand: `git worktree remove "${plan.worktreePath}"`,
			deleteBranchCommand: `git branch -D "${plan.branchName}"`,
		};
	}

	return {
		shouldCleanup: true,
		reason: `Quest complete — worktree "${plan.worktreePath}" (branch "${plan.branchName}") is eligible for cleanup.`,
		worktreePath: plan.worktreePath,
		branchName: plan.branchName,
		pruneCommand: `git worktree remove "${plan.worktreePath}"`,
		deleteBranchCommand: `git branch -D "${plan.branchName}"`,
	};
}

/**
 * Validate a step name for use in a worktree branch. Names that sanitize to
 * nothing meaningful or contain only noise characters are rejected.
 *
 * Returns the sanitized branch-safe name when valid, or `null` when the name
 * is nonsensical (empty, whitespace-only, or reduces to empty after cleaning).
 */
export function validateTaskName(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) return null;
	const sanitized = sanitizeBranchName(trimmed);
	// Reject names that collapse to nothing or are too short to be meaningful.
	if (sanitized === "task" || sanitized.length < 2) return null;
	return sanitized;
}
