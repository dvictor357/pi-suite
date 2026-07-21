/**
 * quest/tool-call-guard.ts — pure helpers for the orchestrator `tool_call` hook.
 *
 * R2: resolve which quest step(s) a `subagent` call targets so write-claim
 *     enforcement works for multi-task batches, not only `lastFiredStepIndex`.
 * R8: effective sandbox profile = most restrictive among quest.sandbox and every
 *     currently running/dispatching (and verifying/checking) step's sandbox.
 *
 * Pure and SDK-free so unit tests can cover both without the pi harness.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import type { SandboxProfile } from "./sandbox";
import { resolveSandboxProfile } from "./sandbox";
import type { Quest, QuestStep, SandboxMode, SandboxPolicy } from "./types";
import { resolvePhase } from "./phase-loop";

// ── Active-step predicate ────────────────────────────────────────────────────

/**
 * Phases where a step's sandbox and write claims still bind the orchestrator.
 * Includes dispatching (parallel batch mid-fire) and verifying/checking so
 * constraints stay in force through completion handoff.
 */
const ACTIVE_GUARD_PHASES = new Set(["dispatching", "running", "checking", "verifying"]);

/** True when a step should contribute to effective sandbox / claim matching. */
export function isGuardActiveStep(step: QuestStep): boolean {
	const phase = resolvePhase(step);
	if (ACTIVE_GUARD_PHASES.has(phase)) return true;
	// Legacy status without phase still counts while work is in flight.
	return step.status === "running" || step.status === "verifying";
}

// ── R8: effective sandbox ────────────────────────────────────────────────────

/** Sandbox modes ordered least → most restrictive. */
const MODE_RANK: Record<SandboxMode, number> = { none: 0, restricted: 1, isolated: 2 };

/**
 * Combine two resolved profiles into the most restrictive of the two.
 *
 * - Mode: higher rank wins.
 * - Allowed paths/commands: empty under an active mode means deny-all; empty under
 *   mode "none" means full access. Full access yields to the other side; otherwise
 *   lists intersect. Deny-all on either side yields deny-all.
 * - Denied paths/commands: union.
 * - Boolean flags: AND (only tighten true → false).
 * - Worktree: keep any non-null config (isolated isolation wins).
 */
export function maxRestrictiveProfile(a: SandboxProfile, b: SandboxProfile): SandboxProfile {
	const mode: SandboxMode = MODE_RANK[a.mode] >= MODE_RANK[b.mode] ? a.mode : b.mode;

	const allowedPaths = intersectAllowLists(a, b, "allowedPaths");
	const allowCommands = intersectAllowLists(a, b, "allowCommands");
	const deniedPaths = unionUnique(a.deniedPaths, b.deniedPaths);
	const denyCommands = unionUnique(a.denyCommands, b.denyCommands);
	const allowNetwork = a.allowNetwork && b.allowNetwork;
	const allowPackageInstall = a.allowPackageInstall && b.allowPackageInstall;
	const worktree = a.worktree ?? b.worktree ?? null;

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
 * Effective sandbox for orchestrator tool_call enforcement: most restrictive
 * among the quest-level policy and every guard-active step's resolved profile.
 *
 * Even when `quest.sandbox` is absent (mode none), a running step with a tighter
 * override raises the effective profile — so quest-none + step-restricted blocks.
 */
export function effectiveSandboxProfile(quest: Quest): SandboxProfile {
	let effective = resolveSandboxProfile(quest.sandbox);
	for (const step of quest.steps) {
		if (!isGuardActiveStep(step)) continue;
		const stepProfile = resolveSandboxProfile(quest.sandbox, step.sandbox);
		effective = maxRestrictiveProfile(effective, stepProfile);
	}
	return effective;
}

// ── R2: subagent claim targets ───────────────────────────────────────────────

/** One step bound to a subagent spawn for write-claim enforcement. */
export interface SubagentClaimTarget {
	/** 0-based step index on the quest. */
	stepIndex: number;
	/** Agent role used for the spawn (from input or step). */
	agent: string;
	/** Write paths declared on the step (source of truth). */
	writeClaim?: string[];
	/** Read paths declared on the step. */
	readClaim?: string[];
}

/** Parsed entry from a single-agent or multi-task `subagent` tool input. */
export interface SubagentTaskEntry {
	agent: string;
	/** Worktree / cwd from the parallel batch payload, when present. */
	cwd?: string;
	/** Optional step index if the caller encoded it. */
	stepIndex?: number;
	writeClaim?: string[];
	readClaim?: string[];
}

/**
 * Parse `subagent` tool input into task entries.
 *
 * Supports:
 * - single-agent form: `{ agent, task?, model?, ... }`
 * - multi-task form: `{ tasks: [{ agent, cwd?, writeClaim?, ... }, ...], onError? }`
 */
export function parseSubagentTaskEntries(input: Record<string, unknown>): SubagentTaskEntry[] {
	const tasksRaw = input.tasks;
	if (Array.isArray(tasksRaw) && tasksRaw.length > 0) {
		const out: SubagentTaskEntry[] = [];
		for (const raw of tasksRaw) {
			if (!raw || typeof raw !== "object") continue;
			const entry = entryFromRecord(raw as Record<string, unknown>);
			if (entry) out.push(entry);
		}
		return out;
	}

	const single = entryFromRecord(input);
	return single ? [single] : [];
}

/**
 * Resolve which quest steps a `subagent` call targets for write-claim checks.
 *
 * Matching priority per task entry:
 * 1. Explicit `stepIndex` when it points at a guard-active step (and agent matches when set).
 * 2. Worktree / cwd match against `step.sandboxArtifacts.worktreePath`.
 * 3. Unique guard-active step with the same agent.
 * 4. Sequential fallback: `quest.lastFiredStepIndex` when it matches agent + active.
 *
 * Unmatched entries are omitted (no claim enforcement for unknown spawns).
 * Each step is bound at most once per call.
 */
export function resolveSubagentClaimTargets(
	quest: Quest,
	input: Record<string, unknown>,
): SubagentClaimTarget[] {
	const entries = parseSubagentTaskEntries(input);
	if (entries.length === 0) return [];

	const used = new Set<number>();
	const targets: SubagentClaimTarget[] = [];

	for (const entry of entries) {
		const stepIndex = matchStepIndex(quest, entry, used);
		if (stepIndex === null) continue;
		used.add(stepIndex);
		const step = quest.steps[stepIndex];
		targets.push({
			stepIndex,
			agent: entry.agent || step.agent,
			writeClaim: step.writeClaim,
			readClaim: step.readClaim,
		});
	}

	return targets;
}

// ── Internals ────────────────────────────────────────────────────────────────

function entryFromRecord(raw: Record<string, unknown>): SubagentTaskEntry | null {
	const agent = typeof raw.agent === "string" ? raw.agent.trim() : "";
	if (!agent) return null;

	const cwd =
		typeof raw.cwd === "string" && raw.cwd.trim()
			? raw.cwd.trim()
			: typeof raw.worktreePath === "string" && raw.worktreePath.trim()
				? raw.worktreePath.trim()
				: undefined;

	const stepIndex =
		typeof raw.stepIndex === "number" && Number.isInteger(raw.stepIndex) && raw.stepIndex >= 0
			? raw.stepIndex
			: typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0
				? raw.index
				: undefined;

	const writeClaim = stringArray(raw.writeClaim);
	const readClaim = stringArray(raw.readClaim);

	return {
		agent,
		...(cwd ? { cwd } : {}),
		...(stepIndex !== undefined ? { stepIndex } : {}),
		...(writeClaim ? { writeClaim } : {}),
		...(readClaim ? { readClaim } : {}),
	};
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	return out.length > 0 ? out : undefined;
}

function matchStepIndex(quest: Quest, entry: SubagentTaskEntry, used: Set<number>): number | null {
	const n = quest.steps.length;

	// 1. Explicit step index from the payload.
	if (entry.stepIndex !== undefined && entry.stepIndex < n && !used.has(entry.stepIndex)) {
		const step = quest.steps[entry.stepIndex];
		if (isGuardActiveStep(step) && agentsMatch(step.agent, entry.agent)) {
			return entry.stepIndex;
		}
	}

	// 2. Worktree / cwd match (parallel batch payload).
	if (entry.cwd) {
		const normCwd = normalizePathKey(entry.cwd);
		for (let i = 0; i < n; i++) {
			if (used.has(i)) continue;
			const step = quest.steps[i];
			if (!isGuardActiveStep(step)) continue;
			if (!agentsMatch(step.agent, entry.agent)) continue;
			const wt = step.sandboxArtifacts?.worktreePath;
			if (wt && normalizePathKey(wt) === normCwd) return i;
		}
		// Cwd may be a worktree path even when agent names collide — match path alone.
		for (let i = 0; i < n; i++) {
			if (used.has(i)) continue;
			const step = quest.steps[i];
			if (!isGuardActiveStep(step)) continue;
			const wt = step.sandboxArtifacts?.worktreePath;
			if (wt && normalizePathKey(wt) === normCwd) return i;
		}
	}

	// 3. Unique active step with this agent.
	const agentMatches: number[] = [];
	for (let i = 0; i < n; i++) {
		if (used.has(i)) continue;
		const step = quest.steps[i];
		if (!isGuardActiveStep(step)) continue;
		if (agentsMatch(step.agent, entry.agent)) agentMatches.push(i);
	}
	if (agentMatches.length === 1) return agentMatches[0];

	// 4. Prefer lastFiredStepIndex among multi-matches (sequential / last batch member).
	const fired = quest.lastFiredStepIndex;
	if (fired >= 0 && fired < n && !used.has(fired) && agentMatches.includes(fired)) {
		return fired;
	}

	// 5. Disambiguate multi-agent matches via writeClaim overlap with the entry.
	if (agentMatches.length > 1 && entry.writeClaim && entry.writeClaim.length > 0) {
		const claimKey = new Set(entry.writeClaim.map((p) => p.replace(/\\/g, "/")));
		const claimHits = agentMatches.filter((i) => {
			const wc = quest.steps[i].writeClaim;
			if (!wc || wc.length === 0) return false;
			return wc.some((p) => claimKey.has(p.replace(/\\/g, "/")));
		});
		if (claimHits.length === 1) return claimHits[0];
	}

	return null;
}

function agentsMatch(stepAgent: string, entryAgent: string): boolean {
	return stepAgent.trim().toLowerCase() === entryAgent.trim().toLowerCase();
}

function normalizePathKey(p: string): string {
	const resolved = isAbsolute(p) ? resolve(p) : resolve(p);
	return normalize(resolved).replace(/\\/g, "/");
}

function unionUnique(a: string[], b: string[]): string[] {
	return [...new Set([...a, ...b])];
}

/**
 * Intersect allow-lists with "full access" semantics for mode none + empty list.
 */
function intersectAllowLists(
	a: SandboxProfile,
	b: SandboxProfile,
	key: "allowedPaths" | "allowCommands",
): string[] {
	const aFull = isFullAccessList(a, key);
	const bFull = isFullAccessList(b, key);
	if (aFull && bFull) return [];
	if (aFull) return [...b[key]];
	if (bFull) return [...a[key]];
	// Either side empty under an active sandbox = deny-all.
	if (a[key].length === 0 || b[key].length === 0) return [];
	const setB = new Set(b[key]);
	return a[key].filter((g) => setB.has(g));
}

function isFullAccessList(profile: SandboxProfile, key: "allowedPaths" | "allowCommands"): boolean {
	// mode "none" with empty allow-list means unrestricted (DEFAULT_SANDBOX_POLICY).
	return profile.mode === "none" && profile[key].length === 0;
}

/** Re-export policy type for callers that build fixtures. */
export type { SandboxPolicy };
