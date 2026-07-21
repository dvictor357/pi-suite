/**
 * quest/parallel.ts — opt-in bounded parallel dispatch for isolated steps.
 *
 * When a quest has `parallel.enabled`, dependency-ready non-overlapping steps
 * are dispatched as a batch. Each step runs in its own git worktree (isolated
 * mode), the orchestrator is steered to delegate them all, and results are
 * integrated deterministically by dependency order. Sequential remains default.
 *
 * Pure helpers are exported for testing; the live dispatch path lives in
 * register-events.ts (which owns the orchestrator steering).
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwdHash } from "../../core";
import type { ParallelConfig, Quest, QuestStep } from "./types";
import { normalizeClaims, type WriteClaimRegistry } from "./write-claim";
import type { DispatchGuard } from "./phase-loop";
import { DEFAULT_STEP_TIMEOUT_MS, checkTimeout, resolvePhase } from "./phase-loop";
import { loadAgentModels, loadModelLadder } from "./storage";
import { rungModel } from "./ladder";
import { isSandboxActive, resolveSandboxProfile } from "./sandbox";

// ── Config ──────────────────────────────────────────────────────────────────

export type { ParallelConfig } from "./types";

/** Parallel branches must start from the complete project state represented by HEAD. */
export function isWorkingTreeClean(cwd: string): boolean {
	try {
		return !execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	} catch {
		return false;
	}
}

export const DEFAULT_PARALLEL_CONFIG: ParallelConfig = {
	enabled: false,
	maxConcurrent: 3,
	stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
};

/**
 * Whether multi-task pi-minions parallel batches are allowed for this quest.
 *
 * Parallel batches always steer via `subagent({ tasks })` with **no** Quest
 * sandbox-guard. Combining parallel with restricted/isolated sandbox is a
 * policy hole (#21). Policy: force sequential `quest_delegate` when:
 * 1. Quest-level sandbox mode is restricted or isolated, OR
 * 2. Any currently dispatchable step has an active sandbox profile.
 *
 * Sequential sandboxed path via quest_delegate is unaffected.
 */
export function parallelAllowedForQuest(quest: Quest): boolean {
	// Quest-level restricted/isolated → never fire multi-task minion batches.
	if (isSandboxActive(resolveSandboxProfile(quest.sandbox))) {
		return false;
	}
	// Step-level sandbox on any ready step → force sequential for the batch.
	for (const step of quest.steps) {
		if (
			isDispatchable(step, quest.steps) &&
			isSandboxActive(resolveSandboxProfile(quest.sandbox, step.sandbox))
		) {
			return false;
		}
	}
	return true;
}

// ── Worktree naming ─────────────────────────────────────────────────────────

/**
 * Generate a dedicated worktree path for a step. Stable across restarts so
 * stale worktrees can be found and cleaned up.
 */
export function stepWorktreePath(cwd: string, questName: string, stepIndex: number): string {
	const slug = questName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
	let root = cwd;
	try {
		root = realpathSync(cwd);
	} catch {
		/* lexical fallback for a not-yet-created cwd */
	}
	return join(dirname(root), ".pi-worktrees", cwdHash(root), slug, `step-${stepIndex}`);
}

/**
 * Create a detached git worktree at `worktreePath` based on the current HEAD.
 * Returns the absolute path on success, null on failure.
 */
export function createStepWorktree(
	worktreePath: string,
	cwd: string,
	branch?: string,
): string | null {
	try {
		const args = branch
			? ["worktree", "add", "-b", branch, worktreePath, "HEAD"]
			: ["worktree", "add", "--detach", worktreePath, "HEAD"];
		execFileSync("git", args, { cwd, timeout: 30_000, stdio: "pipe" });
		return worktreePath;
	} catch {
		return null;
	}
}

/** Remove only a clean worktree. Dirty work is evidence and is never destroyed. */
export function removeStepWorktree(worktreePath: string, cwd: string): boolean {
	try {
		const dirty = execFileSync("git", ["status", "--porcelain"], {
			cwd: worktreePath,
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
		if (dirty) return false;
		execFileSync("git", ["worktree", "remove", worktreePath], {
			cwd,
			timeout: 30_000,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * List all git worktrees and return their paths. Best-effort.
 */
export function listWorktrees(cwd: string): string[] {
	try {
		const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd,
			timeout: 10_000,
			stdio: "pipe",
			encoding: "utf8",
		});
		const paths: string[] = [];
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ")) {
				const raw = line.slice("worktree ".length).trim();
				// Normalise through realpath so /var→/private/var on macOS
				try {
					paths.push(realpathSync(raw));
				} catch {
					paths.push(raw);
				}
			}
		}
		return paths;
	} catch {
		return [];
	}
}

// ── Cleanup stale worktrees on restart ─────────────────────────────────────

/**
 * Remove stale step worktrees only when their HEAD is already integrated into
 * the main checkout. Unmerged worktrees are retained as recovery evidence.
 */
export function cleanStaleWorktrees(cwd: string, questName: string): number {
	const slug = questName.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
	const realCwd = (() => {
		try {
			return realpathSync(cwd);
		} catch {
			return cwd;
		}
	})();
	const root = join(dirname(realCwd), ".pi-worktrees", cwdHash(realCwd), slug);
	const all = listWorktrees(cwd);
	let cleaned = 0;
	for (const wt of all) {
		if (wt === realCwd || !wt.startsWith(`${root}/`)) continue;
		try {
			const head = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: wt,
				encoding: "utf8",
				stdio: "pipe",
			}).trim();
			execFileSync("git", ["merge-base", "--is-ancestor", head, "HEAD"], {
				cwd,
				stdio: "pipe",
			});
			if (removeStepWorktree(wt, cwd)) cleaned++;
		} catch {
			// Unmerged or unreadable worktrees are evidence, not garbage.
		}
	}
	// Also prune git metadata for removed worktrees
	try {
		execFileSync("git", ["worktree", "prune"], { cwd, timeout: 10_000, stdio: "pipe" });
	} catch {
		/* best-effort */
	}
	return cleaned;
}

// ── Dependency-ready step detection ─────────────────────────────────────────

/**
 * A step is dispatchable when:
 * 1. Its canonical status is `pending`.
 * 2. All its dependency steps are `done` or `skipped`.
 * 3. It is not currently blocked (one of its deps is blocked/failed).
 */
export function isDispatchable(step: QuestStep, allSteps: QuestStep[]): boolean {
	if (step.status !== "pending" || resolvePhase(step) !== "queued") return false;
	for (const depIdx of step.dependencies) {
		const dep = allSteps[depIdx];
		if (!dep) return false;
		if (dep.status !== "done" && dep.status !== "skipped") return false;
	}
	return true;
}

// ── Parallel batch selection ────────────────────────────────────────────────

export interface DispatchSelection {
	/** Step indices to dispatch. Deterministic: dependency order, then index. */
	indices: number[];
	/** Step indices that were ready but blocked by write-claim overlap. */
	conflicts: Array<{ index: number; blockedBy: number }>;
	/** Steps that timed out (still in flight past timeout). */
	timedOut: number[];
}

/**
 * Select which steps to dispatch in parallel.
 *
 * Algorithm:
 * 1. Collect all dispatchable (dependency-ready, pending) steps.
 * 2. Sort by dependency order then index (deterministic).
 * 3. Check write-claim overlaps — only steps with disjoint write claims from
 *    already-in-flight steps are selected.
 * 4. Check for timed-out in-flight steps.
 * 5. Limit to {@link ParallelConfig.maxConcurrent} total in-flight steps.
 */
export function selectDispatchBatch(
	quest: Quest,
	guard: DispatchGuard,
	claims: WriteClaimRegistry,
	cwd: string,
	config: ParallelConfig,
): DispatchSelection {
	const indices: number[] = [];
	const conflicts: DispatchSelection["conflicts"] = [];
	const timedOut: number[] = [];
	const timeoutMs = config.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const maxConcurrent = config.maxConcurrent ?? 3;

	// Check for timed-out in-flight steps.
	const activeClaims = claims.active(cwd);
	const activeIndices = new Set(activeClaims.map((c) => c.stepIndex));
	for (const idx of activeIndices) {
		const step = quest.steps[idx];
		if (step && checkTimeout(step, timeoutMs) > 0) {
			timedOut.push(idx);
		}
	}

	// How many slots remain.
	const inFlight = guard.inFlightCount(cwd);
	const slots = Math.max(0, maxConcurrent - inFlight);
	if (slots === 0) return { indices: [], conflicts, timedOut };

	// Collect dispatchable steps, sorted by dependency depth then index.
	const dispatchable: Array<{ index: number; depth: number }> = [];
	for (let i = 0; i < quest.steps.length; i++) {
		if (isDispatchable(quest.steps[i], quest.steps)) {
			dispatchable.push({ index: i, depth: dependencyDepth(quest, i) });
		}
	}
	// Sort: shallowest deps first, then index (deterministic).
	dispatchable.sort((a, b) => a.depth - b.depth || a.index - b.index);

	// Select up to `slots` non-conflicting steps.
	const selectedWriteClaims: Array<{ index: number; paths: string[] }> = [];
	for (const { index } of dispatchable) {
		if (indices.length >= slots) break;
		const step = quest.steps[index];
		if (guard.isInFlight(cwd, index)) continue;

		// Legacy steps without claims remain safe because each writer has an isolated
		// worktree; declared claims avoid predictable merge conflicts earlier.
		let stepPaths: string[];
		try {
			stepPaths = normalizeClaims(step.writeClaim, cwd);
		} catch {
			conflicts.push({ index, blockedBy: -1 });
			continue;
		}
		// Check against already-selected steps in this batch.
		let blocked = false;
		for (const existing of selectedWriteClaims) {
			if (writeClaimsConflict(stepPaths, existing.paths)) {
				conflicts.push({ index, blockedBy: existing.index });
				blocked = true;
				break;
			}
		}
		if (blocked) continue;

		// Check against the global claim registry (already-in-flight steps).
		const conflict = claims.register(cwd, index, step.content, stepPaths);
		if (conflict) {
			conflicts.push({ index, blockedBy: conflict.stepIndex });
			continue;
		}

		// Acquire dispatch guard slot and select.
		if (!guard.acquire(cwd, index)) continue;
		selectedWriteClaims.push({ index, paths: stepPaths });
		indices.push(index);
	}

	return { indices, conflicts, timedOut };
}

/** Compute dependency depth of a step (0 = no deps). */
function dependencyDepth(quest: Quest, index: number): number {
	let max = 0;
	for (const depIdx of quest.steps[index].dependencies) {
		const depDepth = 1 + dependencyDepth(quest, depIdx);
		if (depDepth > max) max = depDepth;
	}
	return max;
}

/** True when two path lists share an ancestor/descendant relationship. */
function writeClaimsConflict(pathsA: string[], pathsB: string[]): boolean {
	if (pathsA.length === 0 || pathsB.length === 0) return false;
	for (const a of pathsA) {
		for (const b of pathsB) {
			if (a === b) return true;
			if (a.startsWith(b.endsWith("/") ? b : b + "/")) return true;
			if (b.startsWith(a.endsWith("/") ? a : a + "/")) return true;
		}
	}
	return false;
}

// ── Batch steering message ──────────────────────────────────────────────────

/**
 * Build a steering message for a batch of steps. Tells the orchestrator to
 * delegate each one (in dependency order), then call quest_update for each.
 */
export function buildBatchSteering(
	quest: Quest,
	indices: number[],
	cwd: string,
	buildPrompt?: (step: QuestStep, index: number, model?: string) => string,
): string {
	const remembered = loadAgentModels(cwd);
	const ladder = loadModelLadder(cwd);
	const tasks = indices.map((index) => {
		const step = quest.steps[index];
		const worktree =
			step.sandboxArtifacts?.worktreePath ?? stepWorktreePath(cwd, quest.name, index);
		const model =
			step.model?.trim() ||
			(step.rung !== undefined && ladder ? rungModel(ladder, step.rung) : undefined) ||
			remembered[step.agent]?.model;
		return {
			agent: step.agent,
			cwd: worktree,
			...(model ? { model } : {}),
			...(remembered[step.agent]?.thinkingLevel
				? { thinking: remembered[step.agent].thinkingLevel }
				: {}),
			...(step.readClaim?.length ? { readClaim: step.readClaim } : {}),
			...(step.writeClaim?.length ? { writeClaim: step.writeClaim } : {}),
			task:
				(buildPrompt?.(step, index, model) ??
					[`Quest: ${quest.name}`, `Step #${index + 1}: ${step.content}`, step.context]
						.filter(Boolean)
						.join("\n")) +
				`\n\nWrite only within the owned worktree ${worktree}.\nCommit all changes on branch ${step.branchName}.`,
		};
	});
	const missingModels = tasks.filter((task) => !("model" in task)).map((task) => task.agent);
	return [
		`## Parallel Dispatch — ${quest.name}`,
		missingModels.length > 0
			? `Before dispatch, assign an explicit model for: ${[...new Set(missingModels)].join(", ")}. Add each approved model to its task below.`
			: "",
		`${indices.length} step(s) are ready. Run exactly one bounded parallel call (not quest_delegate):`,
		`subagent(${JSON.stringify({ tasks, onError: "continue" })})`,
		`Then call quest_update once for each step, in ascending step-index order.`,
		`Do not run these tasks in the main working tree.`,
	]
		.filter(Boolean)
		.join("\n\n");
}

// ── Integration ─────────────────────────────────────────────────────────────

export interface IntegrationResult {
	/** Step indices successfully integrated (merged worktree). */
	integrated: number[];
	/** Step indices with merge conflicts (blocked by integration). */
	conflicts: number[];
	/** Step indices where integration was skipped (no worktree). */
	skipped: number[];
}

/**
 * After batch dispatch completes, integrate results: for each step that ran
 * in a worktree, merge the worktree branch back to the main cwd.
 *
 * This runs deterministically in dependency order. Steps that conflict are
 * recorded with evidence; their dependents are blocked.
 *
 * Returns integration results per step.
 */
export function integrateBatch(quest: Quest, indices: number[], cwd: string): IntegrationResult {
	const result: IntegrationResult = { integrated: [], conflicts: [], skipped: [] };
	const ordered = [...indices].sort(
		(a, b) => dependencyDepth(quest, a) - dependencyDepth(quest, b) || a - b,
	);

	for (const idx of ordered) {
		const step = quest.steps[idx];
		if (step.phase !== "checking" && step.status !== "done") {
			result.skipped.push(idx);
			continue;
		}

		const wtPath = stepWorktreePath(cwd, quest.name, idx);
		// Normalise through realpath for symlink-resilient comparison.
		const realWtPath = (() => {
			try {
				return realpathSync(wtPath);
			} catch {
				return wtPath;
			}
		})();
		const worktrees = listWorktrees(cwd);

		if (!worktrees.includes(realWtPath) && !worktrees.includes(wtPath)) {
			// No worktree — step ran in the main cwd. Nothing to integrate.
			result.skipped.push(idx);
			continue;
		}

		// Uncommitted output cannot be integrated deterministically; retain it as evidence.
		let dirty = true;
		try {
			dirty = Boolean(
				execFileSync("git", ["status", "--porcelain"], {
					cwd: wtPath,
					encoding: "utf8",
					stdio: "pipe",
				}).trim(),
			);
		} catch {
			/* unreadable worktree is blocked below */
		}
		if (dirty) {
			result.conflicts.push(idx);
			continue;
		}

		// Never merge over user changes in the main checkout: git may otherwise
		// include staged work in the merge commit or overwrite overlapping files.
		if (!isCleanCheckout(cwd)) {
			result.conflicts.push(idx);
			continue;
		}

		// Merge the committed worktree changes into the main cwd.
		const merged = mergeWorktree(wtPath, cwd);
		if (merged) {
			result.integrated.push(idx);
			// Delete only after merge and clean-worktree removal both succeed.
			if (removeStepWorktree(wtPath, cwd) && step.branchName) {
				try {
					execFileSync("git", ["branch", "-d", step.branchName], {
						cwd,
						timeout: 10_000,
						stdio: "pipe",
					});
				} catch {
					/* merged commit is safe; stale branch cleanup is best-effort */
				}
			}
		} else {
			result.conflicts.push(idx);
			// Leave the worktree for manual resolution.
		}
	}

	return result;
}

/**
 * Merge a worktree's branch into the main working tree.
 * Strategy: fetch + merge --no-ff from the worktree's HEAD.
 * Returns true on success, false on conflict.
 */
function isCleanCheckout(cwd: string): boolean {
	try {
		return !execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	} catch {
		return false;
	}
}

function mergeWorktree(worktreePath: string, cwd: string): boolean {
	try {
		// Get the worktree's HEAD commit.
		const wtHead = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: worktreePath,
			timeout: 10_000,
			stdio: "pipe",
			encoding: "utf8",
		}).trim();

		if (!wtHead) return false;

		// Fetch the worktree's object into the main repo.
		execFileSync("git", ["fetch", worktreePath, wtHead], {
			cwd,
			timeout: 30_000,
			stdio: "pipe",
		});

		// Merge with --no-ff to preserve the worktree's history.
		execFileSync("git", ["merge", "--no-ff", "-m", `Merge step worktree ${worktreePath}`, wtHead], {
			cwd,
			timeout: 30_000,
			stdio: "pipe",
		});

		return true;
	} catch {
		// Merge conflict — abort the merge so the tree is clean.
		try {
			execFileSync("git", ["merge", "--abort"], { cwd, timeout: 10_000, stdio: "pipe" });
		} catch {
			/* best-effort */
		}
		return false;
	}
}
