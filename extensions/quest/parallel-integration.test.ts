/**
 * Integration tests for the bounded Quest phase loop and parallel dispatch.
 *
 * Exercises the full lifecycle:
 *   1. Transition-table validation gating quest_update status changes
 *   2. Parallel dispatch batch selection with write-claim conflict detection
 *   3. Stale-run recovery on session restart (transient phases → pending)
 *   4. Duplicate-dispatch protection via DispatchGuard
 *   5. Timeout recovery for steps exceeding the phase deadline
 *   6. Race/contention scenarios: overlapping write claims reject the second step
 *   7. Git worktree integration: create → commit → integrate → cleanup
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateTransition, recoverStaleRuns, DispatchGuard, checkTimeout } from "./phase-loop";
import {
	selectDispatchBatch,
	integrateBatch,
	buildBatchSteering,
	stepWorktreePath,
	createStepWorktree,
	cleanStaleWorktrees,
	isWorkingTreeClean,
	type ParallelConfig,
} from "./parallel";
import { WriteClaimRegistry } from "./write-claim";
import type { Quest, QuestStep } from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStep(
	overrides: Partial<QuestStep> & { status?: QuestStep["status"] } = {},
): QuestStep {
	return {
		content: "Test step",
		status: "pending",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 0,
		startedAt: null,
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
		...overrides,
	};
}

function makeQuest(overrides: Partial<Quest> = {}): Quest {
	return {
		version: 1,
		name: "test-quest",
		goal: "test integration",
		status: "active",
		steps: [],
		stepsSincePause: 0,
		lastFiredStepIndex: -1,
		sameStepCount: 0,
		pauseReason: null,
		conventions: [],
		planningMode: "auto",
		planApproved: true,
		verifyOnComplete: false,
		commits: [],
		createdAt: Date.now(),
		completedAt: null,
		updatedAt: Date.now(),
		...overrides,
	};
}

// ── Transition-table integration ────────────────────────────────────────────

describe("Transition-table integration", () => {
	test("quest_update flow: running → done (no verification)", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 5000 });
		const t1 = validateTransition(step, "done");
		assert.equal(t1.ok, true);
		assert.equal(step.status, "done");
	});

	test("quest_update flow: running → verifying → done (with verification)", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 5000 });
		// Enter verification.
		const t1 = validateTransition(step, "verifying");
		assert.equal(t1.ok, true);
		assert.equal(step.status, "verifying");
		// Mark done.
		const t2 = validateTransition(step, "done");
		assert.equal(t2.ok, true);
		assert.equal(step.status, "done");
	});

	test("quest_update flow: running → verifying → failed", () => {
		const step = makeStep({ status: "running" });
		const t1 = validateTransition(step, "verifying");
		assert.equal(t1.ok, true);
		const t2 = validateTransition(step, "failed");
		assert.equal(t2.ok, true);
		assert.equal(step.status, "failed");
	});

	test("quest_update flow: running → verifying → retry → pending", () => {
		const step = makeStep({ status: "verifying" });
		// Simulate a verification FAIL that triggers a retry.
		const t1 = validateTransition(step, "retrying");
		assert.equal(t1.ok, true);
		assert.equal(step.status, "pending"); // retrying maps to pending
	});

	test("quest_update rejects done → anything", () => {
		const step = makeStep({ status: "done" });
		assert.equal(validateTransition(step, "pending").ok, false);
		assert.equal(validateTransition(step, "running").ok, false);
		assert.equal(validateTransition(step, "verifying").ok, false);
		assert.equal(validateTransition(step, "failed").ok, false);
	});

	test("quest_update rejects skipped → anything", () => {
		const step = makeStep({ status: "skipped" });
		assert.equal(validateTransition(step, "done").ok, false);
		assert.equal(validateTransition(step, "pending").ok, false);
	});

	test("quest_update allows running → skipped (user skip)", () => {
		const step = makeStep({ status: "running" });
		const t = validateTransition(step, "skipped");
		assert.equal(t.ok, true);
		assert.equal(step.status, "skipped");
	});

	test("quest_update rejects random pending → done (no work done)", () => {
		const step = makeStep({ status: "pending" });
		assert.equal(validateTransition(step, "done").ok, false);
	});

	test("verify FAIL escalation: verifying → retrying (pending on disk)", () => {
		const step = makeStep({ status: "verifying", verifyRetries: 2 });
		const t = validateTransition(step, "retrying");
		assert.equal(t.ok, true);
		assert.equal(step.status, "pending");
	});

	test("pending → blocked → queued chain", () => {
		const step = makeStep({ status: "pending" });
		const t1 = validateTransition(step, "blocked");
		assert.equal(t1.ok, true);
		assert.equal(step.status, "pending"); // blocked maps to pending

		const t2 = validateTransition(step, "queued");
		assert.equal(t2.ok, true);
		assert.equal(step.status, "pending"); // queued maps to pending
	});

	test("queued → dispatching → running chain persists each phase", () => {
		const step = makeStep({ status: "pending" });
		assert.equal(validateTransition(step, "dispatching").ok, true);
		assert.equal(step.phase, "dispatching");
		assert.equal(validateTransition(step, "running").ok, true);
		assert.equal(step.phase, "running");
	});
});

// ── Race / abort / restart integration ─────────────────────────────────────

describe("Race / abort / restart", () => {
	test("parallel batch: overlapping write claims block second step", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", writeClaim: ["src/auth.ts"] }),
				makeStep({ status: "pending", writeClaim: ["src/auth.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.deepEqual(batch.indices, [0]); // only first acquired
		assert.equal(batch.conflicts.length, 1);
		assert.equal(batch.conflicts[0].index, 1);
		assert.equal(batch.conflicts[0].blockedBy, 0);
	});

	test("parallel batch: steps with disjoint claims all selected", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", writeClaim: ["src/auth.ts"] }),
				makeStep({ status: "pending", writeClaim: ["src/login.ts"] }),
				makeStep({ status: "pending", writeClaim: ["tests/auth.test.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 10 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 3);
		assert.deepEqual(batch.conflicts, []);
	});

	test("abort: clearing guard releases all slots", () => {
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		guard.acquire("/project", 1);
		guard.acquire("/project", 2);
		assert.equal(guard.inFlightCount("/project"), 3);
		guard.clear("/project");
		assert.equal(guard.inFlightCount("/project"), 0);
		// Can re-acquire after clear.
		assert.equal(guard.acquire("/project", 0), true);
	});

	test("abort: clearing claims releases all write claims", () => {
		const claims = new WriteClaimRegistry();
		claims.register("/project", 0, "S0", ["/project/src/a.ts"]);
		claims.register("/project", 1, "S1", ["/project/src/b.ts"]);
		assert.equal(claims.active("/project").length, 2);
		claims.clear("/project");
		assert.equal(claims.active("/project").length, 0);
	});

	test("restart: session reset clears both guard and claims", () => {
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		guard.acquire("/p1", 0);
		claims.register("/p1", 0, "S0", ["/p1/a.ts"]);
		guard.acquire("/p2", 1);
		claims.register("/p2", 1, "S1", ["/p2/b.ts"]);

		guard.reset();
		claims.reset();

		assert.equal(guard.inFlightCount("/p1"), 0);
		assert.equal(guard.inFlightCount("/p2"), 0);
		assert.equal(claims.active("/p1").length, 0);
		assert.equal(claims.active("/p2").length, 0);
	});

	test("stale-run recovery: transient phases → pending", () => {
		const steps = [
			makeStep({ status: "running", startedAt: Date.now() - 3600_000, attempts: 1 }),
			makeStep({ status: "verifying", startedAt: Date.now() - 1800_000, attempts: 2 }),
			makeStep({ status: "pending" }),
		];
		const { recovered, skipped } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [0, 1]);
		assert.deepEqual(skipped, []);
		assert.equal(steps[0].status, "pending");
		assert.equal(steps[0].attempts, 1);
		assert.equal(steps[1].status, "pending");
		assert.equal(steps[1].attempts, 2);
	});

	test("stale-run recovery: terminal steps left untouched", () => {
		const steps = [
			makeStep({ status: "done" }),
			makeStep({ status: "failed" }),
			makeStep({ status: "skipped" }),
			makeStep({ status: "running", attempts: 1 }),
		];
		const { recovered, skipped } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [3]);
		assert.deepEqual(skipped, [0, 1, 2]);
		assert.equal(steps[0].status, "done");
		assert.equal(steps[1].status, "failed");
		assert.equal(steps[2].status, "skipped");
	});

	test("duplicate-dispatch protection: second acquire fails", () => {
		const guard = new DispatchGuard();
		assert.equal(guard.acquire("/project", 0), true);
		assert.equal(guard.acquire("/project", 0), false);
		assert.equal(guard.isInFlight("/project", 0), true);
	});

	test("duplicate-dispatch protection: different cwds independent", () => {
		const guard = new DispatchGuard();
		assert.equal(guard.acquire("/p1", 0), true);
		assert.equal(guard.acquire("/p2", 0), true);
		assert.equal(guard.acquire("/p1", 0), false); // duplicate in /p1
		assert.equal(guard.acquire("/p2", 0), false); // duplicate in /p2
	});

	test("timeout recovery: step running beyond deadline detected", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 120_000 });
		const elapsed = checkTimeout(step, 60_000);
		assert.ok(elapsed > 0);
		assert.ok(elapsed >= 120_000);
	});

	test("timeout recovery: step within window returns 0", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 5_000 });
		assert.equal(checkTimeout(step, 30_000), 0);
	});

	test("timeout recovery: done steps never flagged", () => {
		const step = makeStep({ status: "done", startedAt: Date.now() - 999_999 });
		assert.equal(checkTimeout(step, 1_000), 0);
	});
});

// ── Git worktree integration ────────────────────────────────────────────────

describe("Git worktree integration", () => {
	let tmpDir: string;
	let repoDir: string;

	function setupGitRepo() {
		tmpDir = join(tmpdir(), `pi-quest-parallel-int-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		repoDir = join(tmpDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		execSync("git init", { cwd: repoDir });
		execSync("git config user.email test@test", { cwd: repoDir });
		execSync("git config user.name test", { cwd: repoDir });
		writeFileSync(join(repoDir, "README.md"), "# Test\n");
		execSync("git add README.md", { cwd: repoDir });
		execSync("git commit -m init", { cwd: repoDir });
	}

	function teardownGitRepo() {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}

	test("clean-main preflight rejects uncommitted state", () => {
		setupGitRepo();
		try {
			assert.equal(isWorkingTreeClean(repoDir), true);
			writeFileSync(join(repoDir, "uncommitted.txt"), "local state");
			assert.equal(isWorkingTreeClean(repoDir), false);
		} finally {
			teardownGitRepo();
		}
	});

	test("full parallel lifecycle: create worktrees → commit changes → integrate", () => {
		setupGitRepo();
		try {
			const quest = makeQuest({
				name: "lifecycle-test",
				steps: [
					makeStep({ status: "done", content: "Add feature A" }),
					makeStep({ status: "done", content: "Add feature B" }),
				],
			});

			// Create worktrees for both steps.
			const wt0 = stepWorktreePath(repoDir, quest.name, 0);
			const wt1 = stepWorktreePath(repoDir, quest.name, 1);
			assert.ok(createStepWorktree(wt0, repoDir));
			assert.ok(createStepWorktree(wt1, repoDir));

			// Commit changes in each worktree.
			writeFileSync(join(wt0, "feature-a.txt"), "Feature A");
			execSync("git add feature-a.txt", { cwd: wt0 });
			execSync("git commit -m 'step 0: add feature A'", { cwd: wt0 });

			writeFileSync(join(wt1, "feature-b.txt"), "Feature B");
			execSync("git add feature-b.txt", { cwd: wt1 });
			execSync("git commit -m 'step 1: add feature B'", { cwd: wt1 });

			// Integrate both. Step 0 first then step 1 (dependency order).
			let result = integrateBatch(quest, [0], repoDir);
			assert.deepEqual(result.integrated, [0]);
			assert.ok(existsSync(join(repoDir, "feature-a.txt")));

			result = integrateBatch(quest, [1], repoDir);
			assert.deepEqual(result.integrated, [1]);
			assert.ok(existsSync(join(repoDir, "feature-b.txt")));

			// Worktrees cleaned up.
			assert.equal(existsSync(wt0), false);
			assert.equal(existsSync(wt1), false);
		} finally {
			teardownGitRepo();
		}
	});

	test("stale worktree cleanup: removed on restart", () => {
		setupGitRepo();
		try {
			const wtPath = stepWorktreePath(repoDir, "cleanup-test", 0);
			createStepWorktree(wtPath, repoDir);
			assert.ok(existsSync(wtPath));

			const cleaned = cleanStaleWorktrees(repoDir, "cleanup-test");
			assert.ok(cleaned >= 1, `Expected cleaned >= 1, got ${cleaned}`);
			assert.equal(existsSync(wtPath), false);
		} finally {
			teardownGitRepo();
		}
	});

	test("integration skips steps with no worktree (in-cwd execution)", () => {
		setupGitRepo();
		try {
			const quest = makeQuest({
				name: "skip-wt-test",
				steps: [makeStep({ status: "done", content: "No worktree" })],
			});
			const result = integrateBatch(quest, [0], repoDir);
			assert.deepEqual(result.integrated, []);
			assert.deepEqual(result.skipped, [0]);
		} finally {
			teardownGitRepo();
		}
	});

	test("integration skips non-done steps", () => {
		setupGitRepo();
		try {
			const quest = makeQuest({
				name: "skip-running",
				steps: [makeStep({ status: "running", content: "Still running" })],
			});
			const result = integrateBatch(quest, [0], repoDir);
			assert.deepEqual(result.integrated, []);
			assert.deepEqual(result.skipped, [0]);
		} finally {
			teardownGitRepo();
		}
	});
});

// ── Batch steering message ──────────────────────────────────────────────────

describe("Batch steering message", () => {
	test("single step batch", () => {
		const quest = makeQuest({
			steps: [makeStep({ content: "Add login", agent: "worker", context: "Implement" })],
		});
		const msg = buildBatchSteering(quest, [0], "/project");
		assert.match(msg, /1 step/);
		assert.match(msg, /Step #1/);
		assert.match(msg, /Add login/);
		assert.match(msg, /quest_update/);
	});

	test("uses the complete prompt supplied by the runtime", () => {
		const quest = makeQuest({ steps: [makeStep({ content: "Add login", agent: "worker" })] });
		const msg = buildBatchSteering(quest, [0], "/project", () =>
			["## Task", "complete payload", "## Prior results you can build on"].join("\n"),
		);
		assert.match(msg, /complete payload/);
		assert.match(msg, /Prior results you can build on/);
	});

	test("multi-step batch includes all indices", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ content: "Auth module", agent: "worker" }),
				makeStep({ content: "Tests", agent: "verifier" }),
			],
		});
		const msg = buildBatchSteering(quest, [0, 1], "/project");
		assert.match(msg, /2 step/);
		assert.match(msg, /Step #1/);
		assert.match(msg, /Step #2/);
	});

	test("batch steering explicitly uses pi-minions instead of quest_delegate", () => {
		const quest = makeQuest({
			sandbox: {
				mode: "restricted",
				allowedPaths: [],
				deniedPaths: [],
				allowCommands: [],
				denyCommands: [],
				allowNetwork: true,
				allowPackageInstall: true,
				worktree: null,
			},
			steps: [makeStep({ content: "Sandboxed task", agent: "worker" })],
		});
		const msg = buildBatchSteering(quest, [0], "/project");
		assert.match(msg, /not quest_delegate/);
	});
});

// ── Deterministic ordering ──────────────────────────────────────────────────

describe("Batch selection ordering", () => {
	test("shallowest deps first, then index (tie-break)", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "pending",
					content: "S0",
					dependencies: [1],
					writeClaim: ["src/a.ts"],
				}), // depth 1
				makeStep({ status: "done", content: "S1", writeClaim: ["src/b.ts"] }), // depth 0, done
				makeStep({ status: "pending", content: "S2", writeClaim: ["src/c.ts"] }), // depth 0
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		// S0 depth 1, S2 depth 0. Shallowest first: S2 (idx 2) then S0 (idx 0).
		assert.deepEqual(batch.indices, [2, 0]);
	});

	test("respects maxConcurrent cap", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0", writeClaim: ["src/a.ts"] }),
				makeStep({ status: "pending", content: "S1", writeClaim: ["src/b.ts"] }),
				makeStep({ status: "pending", content: "S2", writeClaim: ["src/c.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 2 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 2);
	});

	test("already-in-flight steps not re-selected", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0", writeClaim: ["src/a.ts"] }),
				makeStep({ status: "pending", content: "S1", writeClaim: ["src/b.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		guard.acquire("/project", 0); // S0 already in flight
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.deepEqual(batch.indices, [1]);
	});
});
