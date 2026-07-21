import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETRY_POLICY } from "../../core";
import {
	decideAfterAgentEnd,
	decideForNextStep,
	DEFAULT_STEP_TIMEOUT_MS,
	nextPendingFromSnapshot,
	planTimeoutActions,
	planUnresolvedRequeues,
	simulateAfterUnresolved,
	snapshotQuestForAutoPilot,
	type AutoPilotQuestSnapshot,
	type AutoPilotStepSnapshot,
} from "./auto-pilot";

const policy = DEFAULT_RETRY_POLICY;

function step(
	partial: Partial<AutoPilotStepSnapshot> & { content?: string },
): AutoPilotStepSnapshot {
	return {
		content: partial.content ?? "step",
		status: partial.status ?? "pending",
		phase: partial.phase,
		agent: partial.agent ?? "worker",
		attempts: partial.attempts ?? 0,
		dependencies: partial.dependencies ?? [],
		rung: partial.rung,
		escalations: partial.escalations,
		result: partial.result,
		phaseChangedAt: partial.phaseChangedAt,
		startedAt: partial.startedAt,
	};
}

function quest(
	steps: AutoPilotStepSnapshot[],
	overrides: Partial<AutoPilotQuestSnapshot> = {},
): AutoPilotQuestSnapshot {
	return {
		name: "Test",
		lastFiredStepIndex: -1,
		sameStepCount: 0,
		stepsSincePause: 0,
		parallelEnabled: false,
		steps,
		...overrides,
	};
}

describe("planUnresolvedRequeues", () => {
	test("requeues dispatching/running within attempt budget", () => {
		const plan = planUnresolvedRequeues(
			[
				step({ status: "running", phase: "running", attempts: 1 }),
				step({ status: "pending", phase: "queued", attempts: 0 }),
				step({ status: "running", phase: "dispatching", attempts: 0 }),
			],
			policy.maxRetries,
		);
		assert.deepEqual(plan, [
			{ index: 0, action: "requeue" },
			{ index: 2, action: "requeue" },
		]);
	});

	test("fails unresolved steps past max retries", () => {
		const plan = planUnresolvedRequeues(
			[step({ status: "running", phase: "running", attempts: policy.maxRetries + 1 })],
			policy.maxRetries,
		);
		assert.deepEqual(plan, [{ index: 0, action: "fail" }]);
	});

	test("ignores done/failed/queued steps", () => {
		const plan = planUnresolvedRequeues(
			[
				step({ status: "done", phase: "done" }),
				step({ status: "failed", phase: "failed" }),
				step({ status: "pending", phase: "queued" }),
			],
			policy.maxRetries,
		);
		assert.deepEqual(plan, []);
	});
});

describe("simulateAfterUnresolved + nextPendingFromSnapshot", () => {
	test("requeued steps become selectable pending", () => {
		const steps = [
			step({ status: "running", phase: "running", attempts: 1, content: "a" }),
			step({ status: "pending", phase: "queued", content: "b", dependencies: [0] }),
		];
		const simulated = simulateAfterUnresolved(steps, [{ index: 0, action: "requeue" }]);
		const next = nextPendingFromSnapshot(simulated);
		assert.equal(next?.index, 0);
		assert.equal(next?.step.content, "a");
	});

	test("failed unresolved does not become pending", () => {
		const steps = [step({ status: "running", phase: "running", attempts: 9 })];
		const simulated = simulateAfterUnresolved(steps, [{ index: 0, action: "fail" }]);
		assert.equal(nextPendingFromSnapshot(simulated), null);
		assert.equal(simulated[0].status, "failed");
	});
});

describe("decideAfterAgentEnd — abort", () => {
	test("abort_pause when turn was aborted", () => {
		const d = decideAfterAgentEnd({
			wasAborted: true,
			hasUI: false,
			quest: quest([step({ status: "running", phase: "running" })]),
		});
		assert.equal(d.kind, "abort_pause");
	});
});

describe("decideAfterAgentEnd — complete / blocked / failed", () => {
	test("complete when all done or skipped", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({ status: "done", phase: "done" }),
				step({ status: "skipped", phase: "skipped" }),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "complete");
		assert.equal(d.tryParallel, false);
	});

	test("failed_steps without UI prompt when hasUI false", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({ status: "failed", phase: "failed" }),
				step({ status: "done", phase: "done" }),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "failed_steps");
		if (d.sequential.kind !== "failed_steps") return;
		assert.deepEqual(d.sequential.indices, [0]);
		assert.equal(d.sequential.offerPrompt, false);
	});

	test("failed_steps offers prompt when hasUI", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: true,
			quest: quest([step({ status: "failed", phase: "failed" })]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "failed_steps");
		if (d.sequential.kind !== "failed_steps") return;
		assert.equal(d.sequential.offerPrompt, true);
	});

	test("blocked when pending deps unmet and nothing failed", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({ status: "running", phase: "checking", content: "a" }),
				step({ status: "pending", phase: "queued", content: "b", dependencies: [0] }),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		// checking is not requeued (only dispatching/running); no next pending → blocked
		assert.equal(d.sequential.kind, "blocked");
	});
});

describe("decideAfterAgentEnd — verifying", () => {
	test("verifying allResolved with UI prompt", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: true,
			quest: quest([
				step({ status: "verifying", phase: "verifying", content: "a" }),
				step({ status: "done", phase: "done", content: "b" }),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "verifying");
		if (d.sequential.kind !== "verifying") return;
		assert.equal(d.sequential.allResolved, true);
		assert.equal(d.sequential.offerPrompt, true);
		assert.deepEqual(d.sequential.indices, [0]);
	});

	test("verifying not allResolved does not offer prompt", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: true,
			quest: quest([
				step({ status: "verifying", phase: "verifying", content: "a" }),
				step({ status: "pending", phase: "queued", content: "b", dependencies: [0] }),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "verifying");
		if (d.sequential.kind !== "verifying") return;
		assert.equal(d.sequential.allResolved, false);
		assert.equal(d.sequential.offerPrompt, false);
	});
});

describe("decideAfterAgentEnd — requeue then fire", () => {
	test("unresolved requeue + ready fire_step", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "running", phase: "running", attempts: 1, content: "work" })]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.deepEqual(d.unresolved, [{ index: 0, action: "requeue" }]);
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.index, 0);
		assert.equal(d.sequential.fire, "step");
		assert.equal(d.sequential.sameStepCount, 1);
		assert.equal(d.sequential.burst.hit, false);
	});
});

describe("decideAfterAgentEnd — stall", () => {
	test("stall when same step fired thrice without progress", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "pending", phase: "queued", content: "stuck" })], {
				lastFiredStepIndex: 0,
				sameStepCount: 2,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "stall");
		if (d.sequential.kind !== "stall") return;
		assert.equal(d.sequential.index, 0);
		assert.equal(d.sequential.sameStepCount, 3);
		assert.equal(d.sequential.offerPrompt, false);
	});

	test("stall offers prompt when hasUI", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: true,
			quest: quest([step({ status: "pending", phase: "queued" })], {
				lastFiredStepIndex: 0,
				sameStepCount: 2,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "stall");
		if (d.sequential.kind !== "stall") return;
		assert.equal(d.sequential.offerPrompt, true);
	});

	test("does not stall on second attempt (sameStepCount becomes 2)", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "pending", phase: "queued" })], {
				lastFiredStepIndex: 0,
				sameStepCount: 1,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.sameStepCount, 2);
	});
});

describe("decideAfterAgentEnd — attempt budget", () => {
	test("fail_budget when attempts exhausted and no ladder", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({
					status: "pending",
					phase: "queued",
					attempts: policy.maxRetries + 1,
				}),
			]),
			nextStepLadderLength: 0,
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "fail_budget");
		if (d.sequential.kind !== "fail_budget") return;
		assert.equal(d.sequential.index, 0);
	});

	test("escalate when laddered with remaining rungs", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({
					status: "pending",
					phase: "queued",
					attempts: policy.maxRetries + 1,
					rung: 0,
					escalations: 0,
				}),
			]),
			nextStepLadderLength: 3,
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "escalate");
		if (d.sequential.kind !== "escalate") return;
		assert.equal(d.sequential.nextRung, 1);
		assert.equal(d.sequential.then.fire, "step");
		assert.equal(d.sequential.then.sameStepCount, 0);
	});

	test("fail_budget when escalations exhausted", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([
				step({
					status: "pending",
					phase: "queued",
					attempts: policy.maxRetries + 1,
					rung: 1,
					escalations: policy.maxEscalations,
				}),
			]),
			nextStepLadderLength: 3,
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "fail_budget");
	});
});

describe("decideAfterAgentEnd — burst", () => {
	test("burst checkpoint without UI auto-pauses path (hit + no confirm)", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "pending", phase: "queued", content: "next" })], {
				stepsSincePause: policy.maxBurst,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.burst.hit, true);
		if (!d.sequential.burst.hit) return;
		assert.equal(d.sequential.burst.offerConfirm, false);
		assert.equal(d.sequential.burst.stepsSincePause, policy.maxBurst);
	});

	test("burst with UI offers confirm", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: true,
			quest: quest([step({ status: "pending", phase: "queued" })], {
				stepsSincePause: policy.maxBurst,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.burst.hit, true);
		if (!d.sequential.burst.hit) return;
		assert.equal(d.sequential.burst.offerConfirm, true);
	});

	test("no burst when under maxBurst", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "pending", phase: "queued" })], {
				stepsSincePause: policy.maxBurst - 1,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.burst.hit, false);
	});
});

describe("decideAfterAgentEnd — parallel", () => {
	test("tryParallel true and fire parallel_conflict when fall-through", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "pending", phase: "queued", content: "p" })], {
				parallelEnabled: true,
			}),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.tryParallel, true);
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.fire, "parallel_conflict");
	});

	test("tryParallel with no next still sequential complete path", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			quest: quest([step({ status: "done", phase: "done" })], { parallelEnabled: true }),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.tryParallel, true);
		assert.equal(d.sequential.kind, "complete");
	});
});

describe("decideForNextStep", () => {
	test("resets sameStepCount when index changes", () => {
		const q = quest([step({ status: "pending", phase: "queued" })], {
			lastFiredStepIndex: 5,
			sameStepCount: 9,
		});
		const d = decideForNextStep(q, 0, q.steps[0], {
			hasUI: false,
			ladderLength: 0,
			policy,
		});
		assert.equal(d.kind, "ready");
		if (d.kind !== "ready") return;
		assert.equal(d.sameStepCount, 1);
	});
});

describe("planTimeoutActions + sequential timeout (R7)", () => {
	const now = 10_000_000;
	const timeoutMs = 60_000;

	test("requeues running step past phaseChangedAt deadline", () => {
		const plan = planTimeoutActions(
			[
				step({
					status: "running",
					phase: "running",
					attempts: 1,
					phaseChangedAt: now - timeoutMs - 1,
				}),
			],
			policy.maxRetries,
			timeoutMs,
			now,
		);
		assert.equal(plan.length, 1);
		assert.equal(plan[0].action, "requeue");
		assert.ok(plan[0].elapsedMs > timeoutMs);
	});

	test("includes verifying steps (unlike unresolved requeue)", () => {
		const plan = planTimeoutActions(
			[
				step({
					status: "verifying",
					phase: "verifying",
					attempts: 0,
					phaseChangedAt: now - timeoutMs - 5_000,
				}),
			],
			policy.maxRetries,
			timeoutMs,
			now,
		);
		assert.equal(plan.length, 1);
		assert.equal(plan[0].action, "requeue");
	});

	test("fails when attempts already past maxRetries", () => {
		const plan = planTimeoutActions(
			[
				step({
					status: "running",
					phase: "running",
					attempts: policy.maxRetries + 1,
					phaseChangedAt: now - timeoutMs - 1,
				}),
			],
			policy.maxRetries,
			timeoutMs,
			now,
		);
		assert.deepEqual(plan, [{ index: 0, action: "fail", elapsedMs: plan[0].elapsedMs }]);
	});

	test("ignores steps within window or without timestamps", () => {
		const plan = planTimeoutActions(
			[
				step({
					status: "running",
					phase: "running",
					phaseChangedAt: now - 1_000,
				}),
				step({ status: "running", phase: "running" }),
				step({ status: "pending", phase: "queued", phaseChangedAt: now - 999_999 }),
			],
			policy.maxRetries,
			timeoutMs,
			now,
		);
		assert.deepEqual(plan, []);
	});

	test("decideAfterAgentEnd applies timeout before unresolved and requeues to fire", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			now,
			quest: quest(
				[
					step({
						status: "running",
						phase: "running",
						attempts: 1,
						content: "hung",
						phaseChangedAt: now - DEFAULT_STEP_TIMEOUT_MS - 100,
					}),
				],
				{ stepTimeoutMs: DEFAULT_STEP_TIMEOUT_MS },
			),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.timeouts.length, 1);
		assert.equal(d.timeouts[0].action, "requeue");
		// Timed-out index is not also in unresolved.
		assert.deepEqual(d.unresolved, []);
		assert.equal(d.sequential.kind, "ready");
		if (d.sequential.kind !== "ready") return;
		assert.equal(d.sequential.index, 0);
	});

	test("decideAfterAgentEnd timeout fail when budget exhausted", () => {
		const d = decideAfterAgentEnd({
			wasAborted: false,
			hasUI: false,
			now,
			quest: quest([
				step({
					status: "verifying",
					phase: "verifying",
					attempts: policy.maxRetries + 1,
					phaseChangedAt: now - 700_000,
				}),
			]),
		});
		assert.equal(d.kind, "proceed");
		if (d.kind !== "proceed") return;
		assert.equal(d.timeouts[0]?.action, "fail");
		// After timeout fail simulation, no next pending → failed_steps
		assert.equal(d.sequential.kind, "failed_steps");
	});

	test("snapshotQuestForAutoPilot carries phaseChangedAt and stepTimeoutMs", () => {
		const snap = snapshotQuestForAutoPilot({
			name: "Q",
			lastFiredStepIndex: -1,
			sameStepCount: 0,
			stepsSincePause: 0,
			parallel: { enabled: false, stepTimeoutMs: 12_000 },
			steps: [
				{
					content: "s",
					status: "running",
					phase: "running",
					agent: "worker",
					attempts: 1,
					dependencies: [],
					phaseChangedAt: 42,
					startedAt: 40,
				},
			],
		});
		assert.equal(snap.stepTimeoutMs, 12_000);
		assert.equal(snap.steps[0].phaseChangedAt, 42);
		assert.equal(snap.steps[0].startedAt, 40);
	});
});

describe("snapshotQuestForAutoPilot", () => {
	test("maps live quest fields", () => {
		const snap = snapshotQuestForAutoPilot({
			name: "N",
			lastFiredStepIndex: 2,
			sameStepCount: 1,
			stepsSincePause: 3,
			parallel: { enabled: true },
			steps: [
				{
					content: "c",
					status: "pending",
					phase: "queued",
					agent: "worker",
					attempts: 1,
					dependencies: [],
					rung: 0,
					escalations: 1,
					result: "r",
				},
			],
		});
		assert.equal(snap.name, "N");
		assert.equal(snap.parallelEnabled, true);
		assert.equal(snap.steps[0].rung, 0);
		assert.equal(snap.steps[0].escalations, 1);
	});
});
