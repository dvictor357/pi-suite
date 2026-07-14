import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ActivityTracker,
	buildActivityWidgetFn,
	buildActivityFooter,
	buildActivityStatus,
	buildActivityWorkingIndicator,
	type ActivityQuestState,
} from "./activity-panel";
import type { Quest, QuestStep } from "./types";
import type { QuestRuntime } from "./runtime";
import { clearActivityUI, pushActivityUI, registerEvents } from "./register-events";

// ── Helpers ──────────────────────────────────────────────────────────────

function step(overrides: Partial<QuestStep> = {}): QuestStep {
	return {
		content: "Default step",
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

function quest(overrides: Partial<Quest> = {}): Quest {
	return {
		version: 1,
		name: "Test Quest",
		goal: "Test goal",
		status: "active",
		steps: [
			step({ content: "First step", status: "done", agent: "scout" }),
			step({ content: "Second step", status: "running", agent: "worker" }),
			step({ content: "Third step", status: "pending", agent: "verifier" }),
		],
		stepsSincePause: 0,
		lastFiredStepIndex: -1,
		sameStepCount: 0,
		pauseReason: null,
		conventions: [],
		planningMode: "auto",
		planApproved: true,
		verifyOnComplete: true,
		commits: [],
		createdAt: Date.now(),
		completedAt: null,
		updatedAt: Date.now(),
		...overrides,
	};
}

// ── ActivityTracker ──────────────────────────────────────────────────────

test("ActivityTracker starts empty", () => {
	const t = new ActivityTracker();
	assert.equal(t.activeRuns.length, 0);
	assert.equal(t.recentRuns.length, 0);
	assert.equal(t.hasActivity, false);
});

test("ActivityTracker tracks a subagent start", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker", model: "claude-opus-4-5" }, q);

	assert.equal(t.activeRuns.length, 1);
	const run = t.activeRuns[0];
	assert.equal(run.toolCallId, "call-1");
	assert.equal(run.toolName, "subagent");
	assert.equal(run.agent, "worker");
	assert.equal(run.model, "claude-opus-4-5");
	assert.equal(run.phase, "starting");
	assert.equal(run.questName, "Test Quest");
	assert.equal(run.stepIndex, -1);
});

test("ActivityTracker tracks quest_delegate with index", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-2", "quest_delegate", { index: 1 }, q);

	assert.equal(t.activeRuns.length, 1);
	const run = t.activeRuns[0];
	assert.equal(run.toolName, "quest_delegate");
	assert.equal(run.stepIndex, 1);
	assert.ok(run.currentActivity.includes("Second step"));
});

test("ActivityTracker resolves stepIndex from stepIndex/taskIndex args", () => {
	const t = new ActivityTracker();
	const q = quest();

	// stepIndex
	t.onStart("call-a", "subagent", { stepIndex: 0 }, q);
	assert.equal([...t["runs"].values()].find((r) => r.toolCallId === "call-a")?.stepIndex, 0);

	// taskIndex (legacy)
	t.onStart("call-b", "subagent", { taskIndex: 2 }, q);
	assert.equal([...t["runs"].values()].find((r) => r.toolCallId === "call-b")?.stepIndex, 2);
});

test("ActivityTracker transitions phases on update/end", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	assert.equal(t.activeRuns[0].phase, "starting");

	t.onUpdate("call-1", "Working on the code...");
	assert.equal(t.activeRuns[0].phase, "running");

	t.onEnd("call-1", false);
	assert.equal(t.activeRuns.length, 0);
	assert.equal(t.recentRuns.length, 1);
	assert.equal(t.recentRuns[0].phase, "completed");
});

test("ActivityTracker records errors", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onEnd("call-1", true, "timeout");
	assert.equal(t.recentRuns[0].phase, "failed");
	assert.equal(t.recentRuns[0].isError, true);
	assert.equal(t.recentRuns[0].error, "timeout");
});

test("ActivityTracker extracts safe activity from partialResult", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);

	t.onUpdate("call-1", "## Analysis Complete\n\nFound 3 issues in the codebase.\n");
	const run = t.activeRuns[0];
	assert.ok(run.currentActivity.includes("Analysis Complete"));
});

test("ActivityTracker truncates long activity text", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);

	const long = "A".repeat(200);
	t.onUpdate("call-1", long);
	assert.ok(t.activeRuns[0].currentActivity.length <= 80);
});

test("ActivityTracker handles malformed partialResult", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);

	// null, undefined, number — none should throw
	t.onUpdate("call-1", null);
	t.onUpdate("call-1", undefined);
	t.onUpdate("call-1", 42);
	t.onUpdate("call-1", { content: null });
	// Activity should not change from the initial
	assert.equal(t.activeRuns[0].currentActivity, "delegating to worker");
});

test("ActivityTracker detects write claim from output", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onUpdate("call-1", "Writing to `src/app.ts` completed successfully.");

	assert.equal(t.activeRuns[0].writeClaim, "src/app.ts");
});

test("ActivityTracker detects write claim from Created pattern", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onUpdate("call-1", "Created `utils/helper.ts`");

	assert.equal(t.activeRuns[0].writeClaim, "utils/helper.ts");
});

test("ActivityTracker tolerates unknown toolCallIds", () => {
	const t = new ActivityTracker();
	t.onUpdate("nonexistent", "foo");
	t.onEnd("nonexistent", false);
	// Should not throw
});

test("ActivityTracker reset clears all state", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.reset();
	assert.equal(t.activeRuns.length, 0);
	assert.equal(t.recentRuns.length, 0);
	assert.equal(t.hasActivity, false);
});

test("ActivityTracker prunes stale completed runs", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onEnd("call-1", false);

	// Manually set completedAt far in the past
	const run = [...t["runs"].values()][0];
	run.completedAt = Date.now() - 20_000;

	t.prune();
	assert.equal(t.hasActivity, false);
});

test("ActivityTracker tracks waiting verifier", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "verifier", stepIndex: 2 }, q);
	t.setWaitingVerifier(2);
	assert.equal(t.activeRuns[0].waitingVerifier, true);
});

test("ActivityTracker.hasActivity true when active or recent", () => {
	const t = new ActivityTracker();
	const q = quest();

	assert.equal(t.hasActivity, false);

	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	assert.equal(t.hasActivity, true);

	t.onEnd("call-1", false);
	assert.equal(t.hasActivity, true);

	// Expire it
	const run = [...t["runs"].values()][0];
	run.completedAt = Date.now() - 20_000;
	t.prune();
	assert.equal(t.hasActivity, false);
});

// ── ActivityQuestState (questSnapshot) ───────────────────────────────────

test("questSnapshot returns correct counts and flags", () => {
	const t = new ActivityTracker();
	const q = quest();
	const snap = t.questSnapshot(q);
	assert.equal(snap.name, "Test Quest");
	assert.equal(snap.status, "active");
	assert.equal(snap.done, 1);
	assert.equal(snap.total, 3);
	assert.equal(snap.hasVerifierPending, false);
});

test("questSnapshot detects verifier pending", () => {
	const t = new ActivityTracker();
	const q = quest({
		steps: [
			step({ content: "Step 0", status: "verifying", agent: "verifier" }),
			step({ content: "Step 1", status: "pending", agent: "worker" }),
		],
	});
	const snap = t.questSnapshot(q);
	assert.equal(snap.hasVerifierPending, true);
});

test("questSnapshot next step content", () => {
	const t = new ActivityTracker();
	const q = quest();
	const snap = t.questSnapshot(q);
	assert.equal(snap.nextStepContent, "Third step");
});

// ── Widget renderer ──────────────────────────────────────────────────────

test("buildActivityWidget returns empty lines when idle", () => {
	const t = new ActivityTracker();
	const widget = buildActivityWidgetFn(t, null)(null, null);
	const lines = widget.render();
	assert.equal(lines.length, 0);
});

test("buildActivityWidget shows quest header", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "My Quest",
		status: "active",
		done: 3,
		total: 7,
		hasVerifierPending: false,
		nextStepContent: "next",
	};
	const widget = buildActivityWidgetFn(t, snap)(null, null);
	const lines = widget.render();
	assert.ok(lines.length >= 1);
	assert.ok(lines[0].includes("My Quest"));
	assert.ok(lines[0].includes("3/7"));
});

test("buildActivityWidget shows active runs", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker", model: "gpt-4" }, q);
	const snap = t.questSnapshot(q);
	const widget = buildActivityWidgetFn(t, snap)(null, null);
	const lines = widget.render();

	assert.ok(lines.some((l) => l.includes("worker")));
});

test("buildActivityWidget shows verification pending", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "Quest",
		status: "active",
		done: 2,
		total: 5,
		hasVerifierPending: true,
		nextStepContent: "Step 4",
	};
	const widget = buildActivityWidgetFn(t, snap)(null, null);
	const lines = widget.render();

	assert.ok(lines.some((l) => l.includes("verifying")));
});

test("buildActivityWidget shows recent completions", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onEnd("call-1", false);
	const snap = t.questSnapshot(q);
	const widget = buildActivityWidgetFn(t, snap)(null, null);
	const lines = widget.render();

	assert.ok(lines.some((l) => l.includes("✓")));
});

// ── Footer renderer ──────────────────────────────────────────────────────

test("buildActivityFooter returns null when idle", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "Q",
		status: "active",
		done: 0,
		total: 0,
		hasVerifierPending: false,
		nextStepContent: "",
	};
	assert.equal(buildActivityFooter(t, snap), null);
});

test("buildActivityFooter returns verifying when no active runs", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "Q",
		status: "active",
		done: 0,
		total: 0,
		hasVerifierPending: true,
		nextStepContent: "",
	};
	assert.equal(buildActivityFooter(t, snap), "🔍 verifying");
});

test("buildActivityFooter shows active run info", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker", model: "gpt-4" }, q);
	const snap = t.questSnapshot(q);
	const footer = buildActivityFooter(t, snap);
	assert.ok(footer?.includes("Test Quest"));
	assert.ok(footer?.includes("worker"));
	assert.ok(footer?.includes("gpt-4"));
});

test("buildActivityFooter shows +N for multiple active", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	t.onStart("call-2", "subagent", { agent: "scout" }, q);
	t.onStart("call-3", "subagent", { agent: "verifier" }, q);
	const snap = t.questSnapshot(q);
	const footer = buildActivityFooter(t, snap);
	assert.ok(footer?.includes("+2"));
});

// ── Status badge renderer ────────────────────────────────────────────────

test("buildActivityStatus returns null without quest", () => {
	const t = new ActivityTracker();
	assert.equal(buildActivityStatus(t, null), null);
});

test("buildActivityStatus shows quest progress", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "Q",
		status: "active",
		done: 2,
		total: 5,
		hasVerifierPending: false,
		nextStepContent: "",
	};
	const status = buildActivityStatus(t, snap);
	assert.equal(status, "⚔ 2/5");
});

test("buildActivityStatus shows running indicator when active", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	const snap = t.questSnapshot(q);
	const status = buildActivityStatus(t, snap);
	assert.equal(status, "⚔ 1/3 ▶");
});

test("buildActivityStatus shows verifying indicator", () => {
	const t = new ActivityTracker();
	const snap: ActivityQuestState = {
		name: "Q",
		status: "active",
		done: 2,
		total: 5,
		hasVerifierPending: true,
		nextStepContent: "",
	};
	const status = buildActivityStatus(t, snap);
	assert.equal(status, "⚔ 2/5 🔍");
});

// ── Working indicator ────────────────────────────────────────────────────

test("buildActivityWorkingIndicator returns undefined when idle", () => {
	const t = new ActivityTracker();
	assert.equal(buildActivityWorkingIndicator(t), undefined);
});

test("buildActivityWorkingIndicator returns frames when active", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker" }, q);
	const indicator = buildActivityWorkingIndicator(t);
	assert.ok(indicator);
	assert.equal(indicator.frames.length, 4);
	assert.ok(indicator.intervalMs > 0);
});

// ── Edge cases ───────────────────────────────────────────────────────────

test("ActivityTracker handles quest_delegate without a matching quest step", () => {
	const t = new ActivityTracker();
	const q = quest();
	// index out of bounds
	t.onStart("call-1", "quest_delegate", { index: 99 }, q);
	assert.equal(t.activeRuns[0].currentActivity, "delegating to worker");
});

test("ActivityTracker handles subagent without agent arg", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", {}, q);
	assert.equal(t.activeRuns[0].agent, "worker"); // default
});

test("ActivityTracker handles subagent with empty model string", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "scout", model: "" }, q);
	assert.equal(t.activeRuns[0].model, undefined);
});

test("buildActivityWidget handles multiple concurrent runs", () => {
	const t = new ActivityTracker();
	const q = quest();
	t.onStart("call-1", "subagent", { agent: "worker", model: "a" }, q);
	t.onStart("call-2", "subagent", { agent: "scout", model: "b" }, q);
	const snap = t.questSnapshot(q);
	const widget = buildActivityWidgetFn(t, snap)(null, null);
	const lines = widget.render();
	// Should show both
	assert.ok(lines.some((l) => l.includes("worker")));
	assert.ok(lines.some((l) => l.includes("scout")));
});

test("buildActivityWidget limits recent completions to 2", () => {
	const t = new ActivityTracker();
	const q = quest();
	for (let i = 0; i < 5; i++) {
		t.onStart(`call-${i}`, "subagent", { agent: "worker" }, q);
		t.onEnd(`call-${i}`, false);
	}
	const widget = buildActivityWidgetFn(t, null)(null, null);
	const lines = widget.render();
	// Count ✓ lines
	const checkLines = lines.filter((l) => l.includes("✓") || l.includes("✗"));
	assert.ok(checkLines.length <= 2);
});

test("buildActivityWidget renders without throwing for empty quest", () => {
	const t = new ActivityTracker();
	const widget = buildActivityWidgetFn(t, null)(null, null);
	assert.doesNotThrow(() => widget.render());
});

test("invalidate is a no-op", () => {
	const t = new ActivityTracker();
	const widget = buildActivityWidgetFn(t, null)(null, null);
	assert.doesNotThrow(() => widget.invalidate());
});

// ── UI lifecycle ─────────────────────────────────────────────────────────

function activityContext(calls: {
	widgets: Array<[string, unknown]>;
	statuses: Array<[string, string | undefined]>;
	working: unknown[];
}): ExtensionContext {
	return {
		hasUI: true,
		cwd: "/tmp/activity-test",
		ui: {
			setWidget: (id: string, value: unknown) => calls.widgets.push([id, value]),
			setStatus: (id: string, value: string | undefined) => calls.statuses.push([id, value]),
			setWorkingIndicator: (value?: unknown) => calls.working.push(value),
			setFooter: () => assert.fail("activity UI must not replace the shared footer"),
		},
	} as unknown as ExtensionContext;
}

function activityRuntime(tracker: ActivityTracker, q: Quest): QuestRuntime {
	return { activity: tracker, getQuest: () => q } as unknown as QuestRuntime;
}

test("pushActivityUI uses keyed status without replacing the shared footer", () => {
	const calls = { widgets: [] as Array<[string, unknown]>, statuses: [], working: [] as unknown[] };
	const ctx = activityContext(calls);
	const tracker = new ActivityTracker();
	const q = quest();
	tracker.onStart("call-1", "subagent", { agent: "worker" }, q);

	pushActivityUI(ctx, activityRuntime(tracker, q));

	assert.equal(calls.widgets.at(-1)?.[0], "quest-activity");
	assert.equal(calls.statuses.at(-1)?.[0], "quest-activity");
	assert.match(calls.statuses.at(-1)?.[1] ?? "", /worker/);
	assert.ok(calls.working.at(-1));
});

test("clearActivityUI is idempotent and releases all owned UI state", () => {
	const calls = { widgets: [] as Array<[string, unknown]>, statuses: [], working: [] as unknown[] };
	const ctx = activityContext(calls);
	const tracker = new ActivityTracker();
	const q = quest();
	tracker.onStart("call-1", "subagent", {}, q);
	const rt = activityRuntime(tracker, q);

	clearActivityUI(ctx, rt);
	clearActivityUI(ctx, rt);

	assert.equal(tracker.hasActivity, false);
	assert.deepEqual(calls.widgets.at(-1), ["quest-activity", undefined]);
	assert.deepEqual(calls.statuses.slice(-2), [
		["quest-activity", undefined],
		["quest", undefined],
	]);
	assert.equal(calls.working.at(-1), undefined);
});

test("session_shutdown runs activity cleanup", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const tracker = new ActivityTracker();
	const q = quest();
	tracker.onStart("call-1", "subagent", {}, q);
	const rt = activityRuntime(tracker, q);
	registerEvents(pi, rt);
	const calls = { widgets: [] as Array<[string, unknown]>, statuses: [], working: [] as unknown[] };

	await handlers.get("session_shutdown")?.({}, activityContext(calls));

	assert.equal(tracker.hasActivity, false);
	assert.deepEqual(calls.widgets.at(-1), ["quest-activity", undefined]);
	assert.equal(calls.working.at(-1), undefined);
});
