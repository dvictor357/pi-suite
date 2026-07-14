import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	validateTransition,
	toCanonicalStatus,
	resolvePhase,
	recoverStaleRuns,
	DispatchGuard,
	checkTimeout,
} from "./phase-loop";
import type { QuestStep } from "./types";

// ── Test step factory ───────────────────────────────────────────────────────

function makeStep(overrides: Partial<QuestStep> = {}): QuestStep {
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

// ── toCanonicalStatus ──────────────────────────────────────────────────────

describe("toCanonicalStatus", () => {
	test("maps extended phases to canonical statuses", () => {
		assert.equal(toCanonicalStatus("queued"), "pending");
		assert.equal(toCanonicalStatus("dispatching"), "pending");
		assert.equal(toCanonicalStatus("retrying"), "pending");
		assert.equal(toCanonicalStatus("blocked"), "pending");
		assert.equal(toCanonicalStatus("checking"), "running");
	});

	test("passes through canonical statuses unchanged", () => {
		assert.equal(toCanonicalStatus("pending"), "pending");
		assert.equal(toCanonicalStatus("running"), "running");
		assert.equal(toCanonicalStatus("verifying"), "verifying");
		assert.equal(toCanonicalStatus("done"), "done");
		assert.equal(toCanonicalStatus("failed"), "failed");
		assert.equal(toCanonicalStatus("skipped"), "skipped");
	});
});

// ── resolvePhase ───────────────────────────────────────────────────────────

describe("resolvePhase", () => {
	test("returns the step's stored status as the phase", () => {
		const step = makeStep({ status: "running" });
		assert.equal(resolvePhase(step), "running");
	});

	test("derives queued for legacy pending steps", () => {
		const step = makeStep({ status: "pending" });
		assert.equal(resolvePhase(step), "queued");
	});
});

// ── validateTransition ─────────────────────────────────────────────────────

describe("validateTransition", () => {
	test("rejects duplicate queued transition", () => {
		const step = makeStep({ status: "pending" });
		const result = validateTransition(step, "queued");
		assert.equal(result.ok, false);
		assert.equal(result.from, "queued");
	});

	test("persists queued → dispatching", () => {
		const step = makeStep({ status: "pending", phase: "queued" });
		const result = validateTransition(step, "dispatching", 123);
		assert.equal(result.ok, true);
		assert.equal(step.phase, "dispatching");
		assert.equal(step.phaseChangedAt, 123);
	});

	test("allows queued → retrying for pre-dispatch budget escalation", () => {
		const step = makeStep({ status: "pending", phase: "queued" });
		assert.equal(validateTransition(step, "retrying").ok, true);
	});

	test("allows dispatching → running", () => {
		const step = makeStep({ status: "pending", phase: "dispatching" });
		const result = validateTransition(step, "running");
		assert.equal(result.ok, true);
		assert.equal(step.status, "running");
	});

	test("allows running → checking", () => {
		const step = makeStep({ status: "running" });
		const result = validateTransition(step, "checking");
		assert.equal(result.ok, true);
		assert.equal(step.status, "running"); // checking maps to running
	});

	test("allows running → verifying", () => {
		const step = makeStep({ status: "running" });
		const result = validateTransition(step, "verifying");
		assert.equal(result.ok, true);
		assert.equal(step.status, "verifying");
	});

	test("allows verifying → done", () => {
		const step = makeStep({ status: "verifying" });
		const result = validateTransition(step, "done");
		assert.equal(result.ok, true);
		assert.equal(step.status, "done");
	});

	test("allows running → failed", () => {
		const step = makeStep({ status: "running" });
		const result = validateTransition(step, "failed");
		assert.equal(result.ok, true);
		assert.equal(step.status, "failed");
	});

	test("allows retrying → pending", () => {
		const step = makeStep({ status: "failed" });
		const result = validateTransition(step, "retrying");
		assert.equal(result.ok, true);
		assert.equal(step.status, "pending"); // retrying maps to pending
	});

	test("allows pending → blocked", () => {
		const step = makeStep({ status: "pending" });
		const result = validateTransition(step, "blocked");
		assert.equal(result.ok, true);
		assert.equal(step.status, "pending"); // blocked maps to pending
	});

	test("allows blocked → queued", () => {
		const step = makeStep({ status: "pending", phase: "blocked" });
		const result = validateTransition(step, "queued");
		assert.equal(result.ok, true);
	});

	test("allows failed → retrying", () => {
		const step = makeStep({ status: "failed" });
		const result = validateTransition(step, "retrying");
		assert.equal(result.ok, true);
		assert.equal(step.status, "pending"); // retrying maps to pending
	});

	// ── Rejected transitions ───────────────────────────────────────────

	test("rejects terminal → anything", () => {
		const step = makeStep({ status: "done" });
		assert.equal(validateTransition(step, "pending").ok, false);
		assert.equal(validateTransition(step, "running").ok, false);
	});

	test("rejects done → failed (terminal)", () => {
		const step = makeStep({ status: "done" });
		assert.equal(validateTransition(step, "failed").ok, false);
	});

	test("rejects skipped → anything", () => {
		const step = makeStep({ status: "skipped" });
		assert.equal(validateTransition(step, "pending").ok, false);
	});

	test("rejects invalid hop: pending → done", () => {
		const step = makeStep({ status: "pending" });
		const result = validateTransition(step, "done");
		assert.equal(result.ok, false);
		assert.match(result.error!, /Invalid transition/);
	});

	test("rejects invalid hop: running → pending", () => {
		const step = makeStep({ status: "running" });
		assert.equal(validateTransition(step, "pending").ok, false);
	});

	test("rejects invalid hop: verifying → running", () => {
		const step = makeStep({ status: "verifying" });
		assert.equal(validateTransition(step, "running").ok, false);
	});

	test("rejects invalid hop: done → verifying", () => {
		const step = makeStep({ status: "done" });
		assert.equal(validateTransition(step, "verifying").ok, false);
	});
});

// ── recoverStaleRuns ───────────────────────────────────────────────────────

describe("recoverStaleRuns", () => {
	test("recovers steps stuck in running", () => {
		const steps = [
			makeStep({ status: "running", startedAt: Date.now() - 3600_000, attempts: 1 }),
			makeStep({ status: "pending" }),
		];
		const { recovered, skipped } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [0]);
		assert.deepEqual(skipped, []);
		assert.equal(steps[0].status, "pending");
		assert.equal(steps[0].attempts, 1); // stale attempt consumes retry budget
	});

	test("recovers steps stuck in verifying", () => {
		const steps = [makeStep({ status: "verifying", attempts: 2 })];
		const { recovered } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [0]);
		assert.equal(steps[0].status, "pending");
		assert.equal(steps[0].attempts, 2);
	});

	test("skips terminal steps (done/failed/skipped)", () => {
		const steps = [
			makeStep({ status: "done" }),
			makeStep({ status: "failed" }),
			makeStep({ status: "skipped" }),
			makeStep({ status: "running", attempts: 1 }),
		];
		const { recovered, skipped } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [3]);
		assert.deepEqual(skipped, [0, 1, 2]);
	});

	test("does not touch already-pending steps", () => {
		const steps = [makeStep({ status: "pending", attempts: 0 })];
		const { recovered, skipped } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, []);
		assert.deepEqual(skipped, []);
	});

	test("does not decrement attempts below zero", () => {
		const steps = [makeStep({ status: "running", attempts: 0 })];
		const { recovered } = recoverStaleRuns(steps);
		assert.deepEqual(recovered, [0]);
		assert.equal(steps[0].status, "pending");
		assert.equal(steps[0].attempts, 0);
	});
});

// ── DispatchGuard ──────────────────────────────────────────────────────────

describe("DispatchGuard", () => {
	test("acquire returns true on first claim", () => {
		const guard = new DispatchGuard();
		assert.equal(guard.acquire("/project", 0), true);
		assert.equal(guard.isInFlight("/project", 0), true);
	});

	test("acquire returns false on duplicate (duplicate-dispatch protection)", () => {
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		assert.equal(guard.acquire("/project", 0), false);
	});

	test("release makes slot available again", () => {
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		guard.release("/project", 0);
		assert.equal(guard.isInFlight("/project", 0), false);
		assert.equal(guard.acquire("/project", 0), true);
	});

	test("different cwds don't interfere", () => {
		const guard = new DispatchGuard();
		guard.acquire("/p1", 0);
		assert.equal(guard.acquire("/p2", 0), true);
		assert.equal(guard.isInFlight("/p1", 0), true);
		assert.equal(guard.isInFlight("/p2", 0), true);
	});

	test("different step indices in same cwd are independent", () => {
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		assert.equal(guard.acquire("/project", 1), true);
	});

	test("inFlightCount tracks correctly", () => {
		const guard = new DispatchGuard();
		assert.equal(guard.inFlightCount("/project"), 0);
		guard.acquire("/project", 0);
		guard.acquire("/project", 1);
		assert.equal(guard.inFlightCount("/project"), 2);
		guard.release("/project", 0);
		assert.equal(guard.inFlightCount("/project"), 1);
	});

	test("clear removes all slots for a cwd", () => {
		const guard = new DispatchGuard();
		guard.acquire("/project", 0);
		guard.acquire("/project", 1);
		guard.clear("/project");
		assert.equal(guard.inFlightCount("/project"), 0);
		assert.equal(guard.isInFlight("/project", 0), false);
	});

	test("reset clears every cwd", () => {
		const guard = new DispatchGuard();
		guard.acquire("/p1", 0);
		guard.acquire("/p2", 0);
		guard.reset();
		assert.equal(guard.inFlightCount("/p1"), 0);
		assert.equal(guard.inFlightCount("/p2"), 0);
	});

	test("release on unknown step is safe (no-op)", () => {
		const guard = new DispatchGuard();
		guard.release("/project", 99); // shouldn't throw
	});
});

// ── checkTimeout ───────────────────────────────────────────────────────────

describe("checkTimeout", () => {
	test("returns 0 for steps not yet started", () => {
		const step = makeStep({ status: "running", startedAt: null });
		assert.equal(checkTimeout(step), 0);
	});

	test("returns 0 for steps within timeout window", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 5000 });
		assert.equal(checkTimeout(step, 30_000), 0);
	});

	test("returns non-zero elapsed for timed-out steps", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 120_000 });
		const elapsed = checkTimeout(step, 60_000);
		assert.ok(elapsed > 0);
		assert.ok(elapsed >= 120_000);
	});

	test("returns 0 for terminal steps even if started long ago", () => {
		const step = makeStep({ status: "done", startedAt: Date.now() - 999_999 });
		assert.equal(checkTimeout(step, 10_000), 0);
	});

	test("returns 0 for pending steps", () => {
		const step = makeStep({ status: "pending", startedAt: Date.now() - 999_999 });
		assert.equal(checkTimeout(step), 0);
	});

	test("respects custom timeout", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 30_000 });
		// 30s > 10s, so should be timed out.
		assert.ok(checkTimeout(step, 10_000) > 0, "30s running should exceed 10s timeout");
	});

	test("uses DEFAULT_STEP_TIMEOUT_MS when no timeout arg given", () => {
		const step = makeStep({ status: "running", startedAt: Date.now() - 1000 });
		assert.equal(checkTimeout(step), 0); // 1s < 600s default
	});
});
