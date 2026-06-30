import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createQuestRuntime } from "./runtime";
import { emptyQuest, saveQuest } from "./storage";
import type { Quest, QuestTask } from "./types";

/** A QuestTask with all required fields defaulted; override what a test cares about. */
function makeTask(partial: Partial<QuestTask>): QuestTask {
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
	tasks: QuestTask[],
): Quest {
	const quest = emptyQuest("Demo", "demo goal");
	quest.status = "active";
	quest.planApproved = true;
	quest.tasks = tasks;
	saveQuest(quest, cwd);
	rt.setQuest(quest);
	return quest;
}

describe("fireNextTask", () => {
	test("fires the first eligible pending task and steers exactly once", () => {
		const h = fakeRuntime();
		try {
			const quest = seedActive(h.rt, h.cwd, [makeTask({ content: "first" })]);

			const fired = h.rt.fireNextTask(h.ctx);

			assert.equal(fired, true);
			assert.equal(quest.tasks[0].status, "running");
			assert.equal(quest.tasks[0].attempts, 1);
			assert.equal(quest.lastFiredTaskIndex, 0);
			assert.equal(quest.tasksSincePause, 1);
			assert.equal(h.steers.length, 1);
			assert.match(h.steers[0], /first/);
		} finally {
			h.cleanup();
		}
	});

	test("is a no-op once the task is running — no double fire", () => {
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
