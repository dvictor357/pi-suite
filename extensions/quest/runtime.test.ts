import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createQuestRuntime } from "./runtime";
import { emptyQuest, saveQuest } from "./storage";
import type { Quest, QuestStep } from "./types";

/** A QuestStep with all required fields defaulted; override what a test cares about. */
function makeTask(partial: Partial<QuestStep>): QuestStep {
	return {
		content: "do the thing",
		status: "pending",
		agent: "coder",
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
		...partial,
	};
}

/** Records steer deliveries so a test can assert what (if anything) was fired. */
function fakeRuntime() {
	const steers: string[] = [];
	const pi = {
		sendUserMessage: (text: string, _opts?: unknown) => {
			steers.push(text);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const cwd = mkdtempSync(join(tmpdir(), "quest-runtime-"));
	const ctx = {
		cwd,
		hasUI: false,
		ui: { setStatus: () => {}, notify: () => {} },
	} as unknown as ExtensionContext;
	const rt = createQuestRuntime(pi);
	return { rt, ctx, cwd, steers, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Seed an active quest both on disk and in the runtime cache. */
function seedActive(
	rt: ReturnType<typeof fakeRuntime>["rt"],
	cwd: string,
	steps: QuestStep[],
): Quest {
	const quest = emptyQuest("Demo", "demo goal");
	quest.status = "active";
	quest.planApproved = true;
	quest.steps = steps;
	saveQuest(quest, cwd);
	rt.setQuest(quest);
	return quest;
}

describe("retry lifecycle", () => {
	test("beginStepRetry releases dispatch and write ownership before requeue", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [
				makeTask({ status: "failed", phase: "failed", writeClaim: ["src/a.ts"] }),
			]);
			h.rt.dispatchGuard.acquire(h.cwd, 0);
			h.rt.claims.register(h.cwd, 0, "do the thing", [`${h.cwd}/src/a.ts`]);

			assert.equal(h.rt.beginStepRetry(h.ctx, quest, 0, "test retry"), true);
			assert.equal(quest.steps[0].phase, "retrying");
			assert.equal(h.rt.dispatchGuard.isInFlight(h.cwd, 0), false);
			assert.deepEqual(h.rt.claims.active(h.cwd), []);
			assert.equal(h.rt.transitionStep(h.ctx, quest, 0, "queued", "retry queued"), true);
		} finally {
			h.cleanup();
		}
	});

	test("beginStepRetry refuses a persisted worktree it does not own", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [
				makeTask({
					status: "failed",
					phase: "failed",
					sandboxArtifacts: {
						calls: [],
						touchedPaths: [],
						worktreePath: join(h.cwd, "someone-elses-worktree"),
					},
				}),
			]);

			assert.equal(h.rt.beginStepRetry(h.ctx, quest, 0, "test retry"), false);
			assert.equal(quest.steps[0].phase, "blocked");
			assert.match(quest.steps[0].result ?? "", /Refusing to clean unowned worktree/);
		} finally {
			h.cleanup();
		}
	});
});

describe("fireNextTask", () => {
	test("fires the first eligible pending step and steers exactly once", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [makeTask({ content: "first" })]);

			const fired = h.rt.fireNextTask(h.ctx);

			assert.equal(fired, true);
			assert.equal(quest.steps[0].status, "running");
			assert.equal(quest.steps[0].attempts, 1);
			assert.equal(quest.lastFiredStepIndex, 0);
			assert.equal(quest.stepsSincePause, 1);
			assert.equal(h.steers.length, 1);
			assert.match(h.steers[0], /first/);
		} finally {
			h.cleanup();
		}
	});

	test("falls back to guarded sequential dispatch when a ready step is sandboxed", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [
				makeTask({
					content: "sandboxed",
					sandbox: { mode: "restricted", allowedPaths: ["src/**"] },
				}),
			]);
			quest.parallel = { enabled: true, maxConcurrent: 2 };

			assert.equal(h.rt.fireNextTask(h.ctx), true);
			assert.equal(h.steers.length, 1);
			// Sequential quest_delegate path — never multi-task minion batch.
			assert.match(h.steers[0], /quest_delegate/);
			assert.doesNotMatch(h.steers[0], /Parallel Dispatch/);
			assert.doesNotMatch(h.steers[0], /"tasks":/);
		} finally {
			h.cleanup();
		}
	});

	test("falls back to sequential when quest-level sandbox is restricted with parallel enabled", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [
				makeTask({ content: "worker step" }),
				makeTask({ content: "another step" }),
			]);
			quest.parallel = { enabled: true, maxConcurrent: 2 };
			quest.sandbox = {
				mode: "restricted",
				allowedPaths: ["src/**"],
				deniedPaths: [],
				allowCommands: [],
				denyCommands: [],
				allowNetwork: false,
				allowPackageInstall: false,
				worktree: null,
			};

			assert.equal(h.rt.fireNextTask(h.ctx), true);
			assert.equal(h.steers.length, 1);
			assert.match(h.steers[0], /quest_delegate/);
			assert.doesNotMatch(h.steers[0], /Parallel Dispatch/);
		} finally {
			h.cleanup();
		}
	});

	test("fireParallelBatch is a no-op when sandbox forbids parallel", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [makeTask({ content: "step" })]);
			quest.parallel = { enabled: true, maxConcurrent: 2 };
			quest.sandbox = {
				mode: "isolated",
				allowedPaths: ["src/**"],
				deniedPaths: [],
				allowCommands: [],
				denyCommands: [],
				allowNetwork: false,
				allowPackageInstall: false,
				worktree: null,
			};

			assert.equal(h.rt.fireParallelBatch(h.ctx, quest), false);
			assert.equal(h.steers.length, 0);
			assert.equal(quest.steps[0].status, "pending");
		} finally {
			h.cleanup();
		}
	});

	test("is a no-op once the step is running — no double fire", () => {
		const h = fakeRuntime();
		try {
			// task1 depends on task0, so after task0 fires there is nothing eligible.
			seedActive(h.rt, h.cwd, [
				makeTask({ content: "first" }),
				makeTask({ content: "second", dependencies: [0] }),
			]);

			assert.equal(h.rt.fireNextTask(h.ctx), true);
			assert.equal(h.rt.fireNextTask(h.ctx), false);
			assert.equal(h.steers.length, 1);
		} finally {
			h.cleanup();
		}
	});

	test("does not fire when the quest is not active", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [makeTask({ content: "first" })]);
			quest.status = "paused";
			saveQuest(quest, h.cwd);
			h.rt.setQuest(quest);

			assert.equal(h.rt.fireNextTask(h.ctx), false);
			assert.equal(h.steers.length, 0);
		} finally {
			h.cleanup();
		}
	});

	test("returns false when there is no quest", () => {
		const h = fakeRuntime();
		try {
			assert.equal(h.rt.fireNextTask(h.ctx), false);
			assert.equal(h.steers.length, 0);
		} finally {
			h.cleanup();
		}
	});
});
