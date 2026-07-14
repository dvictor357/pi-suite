import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	isDispatchable,
	selectDispatchBatch,
	buildBatchSteering,
	stepWorktreePath,
	createStepWorktree,
	removeStepWorktree,
	cleanStaleWorktrees,
	listWorktrees,
	integrateBatch,
} from "./parallel";
import type { ParallelConfig } from "./parallel";
import { DispatchGuard } from "./phase-loop";
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
		goal: "test parallel dispatch",
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

// ── isDispatchable ──────────────────────────────────────────────────────────

describe("isDispatchable", () => {
	test("returns true for pending step with no deps", () => {
		const step = makeStep({ status: "pending", dependencies: [] });
		assert.equal(isDispatchable(step, []), true);
	});

	test("returns false for non-pending step", () => {
		const step = makeStep({ status: "running" });
		assert.equal(isDispatchable(step, []), false);
	});

	test("returns true when all deps are done", () => {
		const steps = [
			makeStep({ status: "done" }),
			makeStep({ status: "pending", dependencies: [0] }),
		];
		assert.equal(isDispatchable(steps[1], steps), true);
	});

	test("returns false when a dep is still pending", () => {
		const steps = [
			makeStep({ status: "pending" }),
			makeStep({ status: "pending", dependencies: [0] }),
		];
		assert.equal(isDispatchable(steps[1], steps), false);
	});

	test("returns false when a dep is failed", () => {
		const steps = [
			makeStep({ status: "failed" }),
			makeStep({ status: "pending", dependencies: [0] }),
		];
		assert.equal(isDispatchable(steps[1], steps), false);
	});

	test("returns true when a dep is skipped (skipped = dependency met)", () => {
		const steps = [
			makeStep({ status: "skipped" }),
			makeStep({ status: "pending", dependencies: [0] }),
		];
		assert.equal(isDispatchable(steps[1], steps), true);
	});

	test("returns false for out-of-range dependency", () => {
		const step = makeStep({ status: "pending", dependencies: [99] });
		assert.equal(isDispatchable(step, []), false);
	});
});

// ── selectDispatchBatch ─────────────────────────────────────────────────────

describe("selectDispatchBatch", () => {
	test("selects all dependency-ready non-conflicting steps", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "Step 0" }),
				makeStep({ status: "pending", content: "Step 1" }),
				makeStep({ status: "pending", content: "Step 2", dependencies: [0] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		// Step 2 depends on Step 0, so only Steps 0 and 1 are ready.
		// They are sorted by depth then index → [0, 1].
		assert.deepEqual(batch.indices, [0, 1]);
		assert.deepEqual(batch.conflicts, []);
		assert.deepEqual(batch.timedOut, []);
	});

	test("respects maxConcurrent limit", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0" }),
				makeStep({ status: "pending", content: "S1" }),
				makeStep({ status: "pending", content: "S2" }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 2 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 2);
	});

	test("blocks conflicting write claims", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0", writeClaim: ["src/foo.ts"] }),
				makeStep({ status: "pending", content: "S1", writeClaim: ["src/foo.ts"] }),
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

	test("does not double-dispatch steps already in flight", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0" }),
				makeStep({ status: "pending", content: "S1" }),
			],
		});
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.deepEqual(batch.indices, [1]); // step 0 already in flight
	});

	test("detects timed-out in-flight steps", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "running",
					content: "S0",
					startedAt: Date.now() - 999_999,
					writeClaim: ["src/a.ts"],
				}),
				makeStep({ status: "pending", content: "S1" }),
			],
		});
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		const claims = new WriteClaimRegistry();
		claims.register("/project", 0, "S0", ["/project/src/a.ts"]);

		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5, stepTimeoutMs: 1000 };
		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.deepEqual(batch.timedOut, [0]);
	});

	test("empty batch when all steps have unmet deps", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0", dependencies: [1] }),
				makeStep({ status: "pending", content: "S1" }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		// S1 has no deps → dispatchable. S0 depends on S1 which is pending → not dispatchable.
		assert.deepEqual(batch.indices, [1]);
	});

	test("deterministic ordering: shallowest deps first", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", content: "S0", dependencies: [1] }),
				makeStep({ status: "done", content: "S1" }),
				makeStep({ status: "pending", content: "S2" }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 5 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		// S0 has depth 1 (dep→S1), S2 has depth 0.
		// Sorted ascending: S2 (depth 0, idx 2), S0 (depth 1, idx 0).
		assert.deepEqual(batch.indices, [2, 0]);
	});
});

// ── buildBatchSteering ──────────────────────────────────────────────────────

describe("buildBatchSteering", () => {
	test("includes all dispatched step indices", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ content: "Add auth", agent: "worker", context: "Implement OAuth" }),
				makeStep({ content: "Add tests", agent: "verifier", context: "" }),
			],
		});
		const msg = buildBatchSteering(quest, [0, 1], "/project");
		assert.match(msg, /Step #1/);
		assert.match(msg, /Step #2/);
		assert.match(msg, /Add auth/);
		assert.match(msg, /Add tests/);
		assert.match(msg, /quest_update/);
	});

	test("single step batch includes its approved model and claims", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					content: "Single",
					agent: "worker",
					model: "provider/worker-model",
					writeClaim: ["src/worker.ts"],
				}),
			],
		});
		const msg = buildBatchSteering(quest, [0], "/project");
		assert.match(msg, /1 step/);
		assert.match(msg, /Step #1/);
		assert.match(msg, /provider\/worker-model/);
		assert.match(msg, /writeClaim/);
	});
});

// ── Git worktree integration tests ──────────────────────────────────────────

describe("Git worktree integration", () => {
	let tmpDir: string;
	let repoDir: string;

	before(() => {
		tmpDir = join(tmpdir(), `pi-quest-parallel-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		repoDir = join(tmpDir, "repo");
		mkdirSync(repoDir, { recursive: true });

		// Initialize a git repo for testing.
		execSync("git init", { cwd: repoDir });
		execSync("git config user.email test@test", { cwd: repoDir });
		execSync("git config user.name test", { cwd: repoDir });
		writeFileSync(join(repoDir, "README.md"), "# Test\n");
		execSync("git add README.md", { cwd: repoDir });
		execSync("git commit -m init", { cwd: repoDir });
	});

	after(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	test("createStepWorktree creates a detached worktree", () => {
		const wtPath = join(tmpDir, "worktrees", "step-0");
		const result = createStepWorktree(wtPath, repoDir);
		assert.equal(result, wtPath);
		assert.ok(existsSync(wtPath));
		assert.ok(existsSync(join(wtPath, "README.md")));

		// Cleanup
		removeStepWorktree(wtPath, repoDir);
	});

	test("createStepWorktree owns the requested branch", () => {
		const wtPath = join(tmpDir, "worktrees", "owned-branch");
		assert.equal(createStepWorktree(wtPath, repoDir, "pi-quest/test/owned"), wtPath);
		assert.equal(
			execSync("git branch --show-current", { cwd: wtPath, encoding: "utf8" }).trim(),
			"pi-quest/test/owned",
		);
		removeStepWorktree(wtPath, repoDir);
	});

	test("removeStepWorktree retains dirty evidence", () => {
		const wtPath = join(tmpDir, "worktrees", "dirty");
		createStepWorktree(wtPath, repoDir);
		writeFileSync(join(wtPath, "uncommitted.txt"), "retain me");
		assert.equal(removeStepWorktree(wtPath, repoDir), false);
		assert.equal(existsSync(wtPath), true);
		execSync("git clean -fd", { cwd: wtPath });
		removeStepWorktree(wtPath, repoDir);
	});

	test("removeStepWorktree cleans up the worktree", () => {
		const wtPath = join(tmpDir, "worktrees", "step-1");
		createStepWorktree(wtPath, repoDir);
		assert.ok(existsSync(wtPath));

		removeStepWorktree(wtPath, repoDir);
		// git worktree remove --force removes the directory
		assert.equal(existsSync(wtPath), false);
	});

	test("listWorktrees includes created worktrees", () => {
		const wtPath = join(tmpDir, "worktrees", "step-2");
		createStepWorktree(wtPath, repoDir);

		const all = listWorktrees(repoDir);
		const realWtPath = (() => {
			try {
				return realpathSync(wtPath);
			} catch {
				return wtPath;
			}
		})();
		assert.ok(
			all.some((p) => p === realWtPath || p === wtPath),
			`Expected ${realWtPath} in ${all.join(", ")}`,
		);

		removeStepWorktree(wtPath, repoDir);
	});

	test("stepWorktreePath is deterministic", () => {
		const path1 = stepWorktreePath(repoDir, "my-quest", 0);
		const path2 = stepWorktreePath(repoDir, "my-quest", 0);
		assert.equal(path1, path2);
		assert.match(path1, /step-0$/);
	});

	test("cleanStaleWorktrees removes only integrated worktrees", () => {
		const integrated = stepWorktreePath(repoDir, "stale-quest", 0);
		createStepWorktree(integrated, repoDir);
		assert.equal(cleanStaleWorktrees(repoDir, "stale-quest"), 1);
		assert.equal(existsSync(integrated), false);

		const unmerged = stepWorktreePath(repoDir, "stale-quest", 1);
		createStepWorktree(unmerged, repoDir);
		writeFileSync(join(unmerged, "unmerged.txt"), "retain");
		execSync("git add unmerged.txt && git commit -m unmerged", { cwd: unmerged });
		assert.equal(cleanStaleWorktrees(repoDir, "stale-quest"), 0);
		assert.equal(existsSync(unmerged), true);
		removeStepWorktree(unmerged, repoDir);
	});

	test("integrateBatch: worktree committed changes merge back", () => {
		// Create a worktree, commit a change, mark step done, integrate.
		const quest = makeQuest({
			name: "integrate-test",
			steps: [makeStep({ status: "done", content: "Add feature" })],
		});

		const wtPath = stepWorktreePath(repoDir, quest.name, 0);
		const created = createStepWorktree(wtPath, repoDir);
		assert.ok(created);

		// Make a change in the worktree and commit it.
		writeFileSync(join(wtPath, "feature.txt"), "hello world");
		execSync("git add feature.txt", { cwd: wtPath });
		execSync("git commit -m 'step 0: add feature'", { cwd: wtPath });

		const result = integrateBatch(quest, [0], repoDir);
		assert.deepEqual(result.integrated, [0]);
		assert.deepEqual(result.conflicts, []);

		// Verify the change was merged.
		assert.ok(existsSync(join(repoDir, "feature.txt")));

		// Worktree should have been cleaned up.
		assert.equal(existsSync(wtPath), false);
	});

	test("integrateBatch blocks uncommitted output without deleting it", () => {
		const quest = makeQuest({
			name: "dirty-integration",
			steps: [makeStep({ status: "done" })],
		});
		const wtPath = stepWorktreePath(repoDir, quest.name, 0);
		createStepWorktree(wtPath, repoDir);
		writeFileSync(join(wtPath, "uncommitted-output.txt"), "retain");
		const result = integrateBatch(quest, [0], repoDir);
		assert.deepEqual(result.conflicts, [0]);
		assert.equal(existsSync(join(wtPath, "uncommitted-output.txt")), true);
		execSync("git clean -fd", { cwd: wtPath });
		removeStepWorktree(wtPath, repoDir);
	});

	test("integrateBatch blocks a dirty main checkout and retains both sides", () => {
		const quest = makeQuest({
			name: "dirty-main",
			steps: [makeStep({ status: "done" })],
		});
		const wtPath = stepWorktreePath(repoDir, quest.name, 0);
		createStepWorktree(wtPath, repoDir);
		writeFileSync(join(wtPath, "worker-output.txt"), "worker");
		execSync("git add worker-output.txt && git commit -m worker", { cwd: wtPath });
		writeFileSync(join(repoDir, "user-output.txt"), "user");

		const result = integrateBatch(quest, [0], repoDir);
		assert.deepEqual(result.conflicts, [0]);
		assert.equal(existsSync(wtPath), true);
		assert.equal(existsSync(join(repoDir, "user-output.txt")), true);
		assert.equal(existsSync(join(repoDir, "worker-output.txt")), false);

		rmSync(join(repoDir, "user-output.txt"));
		removeStepWorktree(wtPath, repoDir);
	});

	test("integrateBatch aborts conflicts and retains the owned worktree", () => {
		writeFileSync(join(repoDir, "conflict.txt"), "base\n");
		execSync("git add conflict.txt", { cwd: repoDir });
		execSync("git commit -m conflict-base", { cwd: repoDir });
		const quest = makeQuest({
			name: "conflict-test",
			steps: [makeStep({ status: "done" }), makeStep({ status: "done" })],
		});
		const first = stepWorktreePath(repoDir, quest.name, 0);
		const second = stepWorktreePath(repoDir, quest.name, 1);
		createStepWorktree(first, repoDir, "pi-quest/conflict/first");
		createStepWorktree(second, repoDir, "pi-quest/conflict/second");
		writeFileSync(join(first, "conflict.txt"), "first\n");
		execSync("git add conflict.txt", { cwd: first });
		execSync("git commit -m first", { cwd: first });
		writeFileSync(join(second, "conflict.txt"), "second\n");
		execSync("git add conflict.txt", { cwd: second });
		execSync("git commit -m second", { cwd: second });

		assert.deepEqual(integrateBatch(quest, [0], repoDir).integrated, [0]);
		const result = integrateBatch(quest, [1], repoDir);
		assert.deepEqual(result.conflicts, [1]);
		assert.equal(existsSync(second), true);
		assert.equal(execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" }), "");
		removeStepWorktree(second, repoDir);
	});

	test("integrateBatch: skips steps that are not done", () => {
		const quest = makeQuest({
			name: "skip-test",
			steps: [makeStep({ status: "running", content: "Not done" })],
		});
		const result = integrateBatch(quest, [0], repoDir);
		assert.deepEqual(result.integrated, []);
		assert.deepEqual(result.skipped, [0]);
	});

	test("integrateBatch: skips steps without worktrees", () => {
		const quest = makeQuest({
			name: "no-wt-test",
			steps: [makeStep({ status: "done", content: "No worktree" })],
		});
		const result = integrateBatch(quest, [0], repoDir);
		assert.deepEqual(result.integrated, []);
		assert.deepEqual(result.skipped, [0]);
	});
});

// ── Write claim conflict detection ─────────────────────────────────────────

describe("Write claim conflict in batch selection", () => {
	test("steps with no write claims never conflict", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending" }),
				makeStep({ status: "pending" }),
				makeStep({ status: "pending" }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 10 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 3);
		assert.deepEqual(batch.conflicts, []);
	});

	test("steps with disjoint write claims don't conflict", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", writeClaim: ["src/auth.ts"] }),
				makeStep({ status: "pending", writeClaim: ["tests/auth.test.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 10 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 2);
		assert.deepEqual(batch.conflicts, []);
	});

	test("ancestor path overlap blocks second step", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "pending", writeClaim: ["src/"] }),
				makeStep({ status: "pending", writeClaim: ["src/foo.ts"] }),
			],
		});
		const guard = new DispatchGuard();
		const claims = new WriteClaimRegistry();
		const cfg: ParallelConfig = { enabled: true, maxConcurrent: 10 };

		const batch = selectDispatchBatch(quest, guard, claims, "/project", cfg);
		assert.equal(batch.indices.length, 1);
		assert.equal(batch.conflicts.length, 1);
		assert.equal(batch.conflicts[0].blockedBy, 0);
	});
});
