/**
 * Pure quest_update completion / verify-fail pipeline tests (no SDK).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETRY_POLICY } from "../../core";
import { validateTransition } from "./phase-loop";
import {
	awaitsIntegration,
	phaseAfterTerminalStatus,
	phaseAfterVerifyPass,
	planCheckFail,
	planTerminalUpdate,
	planVerifyFail,
	planVerifyPass,
	resolveEffectiveOutcome,
	snapshotStepForVerify,
	type VerifyStepSnapshot,
} from "./verify-outcome";
import type { QuestStep, StepStatus } from "./types";

const policy = DEFAULT_RETRY_POLICY;
const NOW = 1_700_000_000_000;

function step(
	partial: Partial<VerifyStepSnapshot> & { content?: string } = {},
): VerifyStepSnapshot {
	return {
		content: partial.content ?? "Implement feature",
		status: partial.status ?? "verifying",
		phase: partial.phase,
		agent: partial.agent ?? "worker",
		result: partial.result ?? "did the work",
		verified: partial.verified ?? false,
		verifyResult: partial.verifyResult ?? null,
		verifyRetries: partial.verifyRetries ?? 0,
		attempts: partial.attempts ?? 1,
		startedAt: partial.startedAt ?? NOW - 5_000,
		completedAt: partial.completedAt ?? null,
		rung: partial.rung,
		escalations: partial.escalations,
		model: partial.model,
		lastModel: partial.lastModel,
		failureBriefs: partial.failureBriefs,
		worktreePath: partial.worktreePath,
	};
}

// ── resolveEffectiveOutcome ──────────────────────────────────────────────────

describe("resolveEffectiveOutcome", () => {
	test("explicit verifyOutcome wins over prose", () => {
		const r = resolveEffectiveOutcome({
			verifyOutcome: "PASS",
			stepStatus: "verifying",
			resultText: "FAIL: everything broken",
			verifyEvidence: "looks good",
		});
		assert.equal(r.outcome, "PASS");
		assert.equal(r.inferred, false);
		assert.equal(r.evidence, "looks good");
	});

	test("infers PASS from prose when verifying and flag omitted", () => {
		const r = resolveEffectiveOutcome({
			stepStatus: "verifying",
			resultText: "PASS: checks out",
		});
		assert.equal(r.outcome, "PASS");
		assert.equal(r.inferred, true);
		assert.equal(r.evidence, "PASS: checks out");
	});

	test("infers FAIL from prose when verifying and flag omitted", () => {
		const r = resolveEffectiveOutcome({
			stepStatus: "verifying",
			resultText: "Verdict: FAIL\nmissing tests",
		});
		assert.equal(r.outcome, "FAIL");
		assert.equal(r.inferred, true);
	});

	test("does not infer from prose when step is not verifying", () => {
		const r = resolveEffectiveOutcome({
			stepStatus: "running",
			resultText: "PASS: done",
		});
		assert.equal(r.outcome, undefined);
		assert.equal(r.inferred, false);
	});

	test("inconclusive prose yields no outcome", () => {
		const r = resolveEffectiveOutcome({
			stepStatus: "verifying",
			resultText: "looks mostly fine",
		});
		assert.equal(r.outcome, undefined);
	});
});

// ── Phase selection (parallel PASS → checking) ───────────────────────────────

describe("phaseAfterVerifyPass / awaitsIntegration", () => {
	test("PASS → done when not parallel", () => {
		const p = phaseAfterVerifyPass({ parallelEnabled: false, hasWorktree: true });
		assert.equal(p.phase, "done");
		assert.equal(p.awaitingIntegration, false);
	});

	test("PASS → done when parallel but no worktree", () => {
		const p = phaseAfterVerifyPass({ parallelEnabled: true, hasWorktree: false });
		assert.equal(p.phase, "done");
		assert.equal(p.awaitingIntegration, false);
	});

	test("PASS → checking when parallel && worktree", () => {
		const p = phaseAfterVerifyPass({ parallelEnabled: true, hasWorktree: true });
		assert.equal(p.phase, "checking");
		assert.equal(p.awaitingIntegration, true);
		assert.match(p.reason, /awaiting integration/);
	});

	test("awaitsIntegration requires both flags", () => {
		assert.equal(awaitsIntegration({ parallelEnabled: true, hasWorktree: true }), true);
		assert.equal(awaitsIntegration({ parallelEnabled: true, hasWorktree: false }), false);
		assert.equal(awaitsIntegration({ parallelEnabled: false, hasWorktree: true }), false);
	});
});

describe("phaseAfterTerminalStatus", () => {
	test("done → checking when parallel && worktree", () => {
		const p = phaseAfterTerminalStatus({
			status: "done",
			parallelEnabled: true,
			hasWorktree: true,
		});
		assert.equal(p.phase, "checking");
	});

	test("done → done without parallel worktree", () => {
		const p = phaseAfterTerminalStatus({
			status: "done",
			parallelEnabled: false,
			hasWorktree: true,
		});
		assert.equal(p.phase, "done");
	});

	test("failed / skipped stay terminal", () => {
		assert.equal(
			phaseAfterTerminalStatus({
				status: "failed",
				parallelEnabled: true,
				hasWorktree: true,
			}).phase,
			"failed",
		);
		assert.equal(
			phaseAfterTerminalStatus({
				status: "skipped",
				parallelEnabled: true,
				hasWorktree: true,
			}).phase,
			"skipped",
		);
	});
});

// ── planVerifyPass ───────────────────────────────────────────────────────────

describe("planVerifyPass", () => {
	test("PASS without parallel lands on done and releases claims", () => {
		const plan = planVerifyPass({
			step: step({ status: "verifying", worktreePath: undefined }),
			stepIndex: 0,
			evidence: "ok",
			parallelEnabled: false,
			now: NOW,
		});
		assert.equal(plan.kind, "pass");
		assert.equal(plan.nextPhase, "done");
		assert.equal(plan.releaseClaims, true);
		assert.equal(plan.patches.verified, true);
		assert.match(plan.patches.verifyResult, /^\[PASS\]/);
		assert.equal(plan.events[0]?.kind, "verify_pass");
		assert.equal(plan.evalIntent.status, "done");
	});

	test("PASS with parallel+worktree lands on checking and keeps claims", () => {
		const plan = planVerifyPass({
			step: step({
				status: "verifying",
				worktreePath: "/tmp/wt-0",
			}),
			stepIndex: 2,
			evidence: "branch ok",
			parallelEnabled: true,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "checking");
		assert.equal(plan.awaitingIntegration, true);
		assert.equal(plan.releaseClaims, false);
		assert.equal(plan.transitionReason, "verification passed; awaiting integration");
	});
});

// ── planVerifyFail (retry / escalate / auto-fail) ────────────────────────────

describe("planVerifyFail", () => {
	test("retry when verify budget remains", () => {
		const plan = planVerifyFail({
			step: step({ verifyRetries: 0 }),
			stepIndex: 0,
			evidence: "tests red",
			inferred: false,
			ladderLength: 0,
			now: NOW,
			policy,
		});
		assert.equal(plan.kind, "retry");
		if (plan.kind !== "retry") return;
		assert.equal(plan.nextPhase, "queued");
		assert.equal(plan.bookkeeping.verifyRetries, 1);
		assert.equal(plan.retriesLeft, policy.maxVerifyRetries - 1);
		assert.equal(plan.events[0]?.kind, "verify_fail");
		assert.match(plan.patches.result, /Verification FAIL #1/);
	});

	test("escalate when per-rung budget exhausted and ladder has room", () => {
		const plan = planVerifyFail({
			step: step({
				verifyRetries: policy.maxVerifyRetries - 1, // this fail will exhaust
				rung: 0,
				escalations: 0,
				lastModel: "cheap-model",
			}),
			stepIndex: 1,
			evidence: "still broken",
			inferred: false,
			ladderLength: 3,
			ladderRungs: ["cheap-model", "mid-model", "frontier"],
			now: NOW,
			policy,
		});
		assert.equal(plan.kind, "escalate");
		if (plan.kind !== "escalate") return;
		assert.equal(plan.nextRung, 1);
		assert.equal(plan.patches.rung, 1);
		assert.equal(plan.patches.verifyRetries, 0);
		assert.equal(plan.fromModel, "cheap-model");
		assert.equal(plan.toModel, "mid-model");
		assert.equal(plan.events.length, 2);
		assert.equal(plan.events[0]?.kind, "verify_fail");
		assert.equal(plan.events[1]?.kind, "escalate");
	});

	test("auto-fail when retries and escalations exhausted", () => {
		const plan = planVerifyFail({
			step: step({
				verifyRetries: policy.maxVerifyRetries - 1,
				rung: undefined,
				escalations: 0,
			}),
			stepIndex: 0,
			evidence: "no more tries",
			inferred: true,
			ladderLength: 0,
			now: NOW,
			policy,
			briefBudget: 500,
			maxBriefs: 3,
		});
		assert.equal(plan.kind, "fail");
		if (plan.kind !== "fail") return;
		assert.equal(plan.nextPhase, "failed");
		assert.equal(plan.releaseClaims, true);
		assert.equal(plan.evalIntent.status, "failed");
		assert.equal(plan.evalIntent.failureCode, undefined);
		assert.match(plan.patches.result, /Verification FAIL after/);
		assert.equal(plan.bookkeeping.failureBrief.inferred, true);
	});

	test("check-fail path carries taxonomy failureCode", () => {
		const plan = planCheckFail({
			step: step({
				status: "running",
				phase: "checking",
				verifyRetries: policy.maxVerifyRetries - 1,
			}),
			stepIndex: 0,
			evidence: "Deterministic test check failed",
			failureCode: "TEST_FAILURE",
			ladderLength: 0,
			now: NOW,
			policy,
		});
		assert.equal(plan.kind, "fail");
		if (plan.kind !== "fail") return;
		assert.equal(plan.details.failureCode, "TEST_FAILURE");
		assert.equal(plan.evalIntent.failureCode, "TEST_FAILURE");
		assert.equal(plan.events[0]?.kind, "verify_fail");
		if (plan.events[0]?.kind === "verify_fail") {
			assert.equal(plan.events[0].failureCode, "TEST_FAILURE");
		}
	});
});

// ── planTerminalUpdate ───────────────────────────────────────────────────────

describe("planTerminalUpdate", () => {
	test("failed marks completedAt and releases claims", () => {
		const plan = planTerminalUpdate({
			step: step({ status: "running", phase: "running" }),
			stepIndex: 0,
			status: "failed",
			result: "blocked",
			parallelEnabled: false,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "failed");
		assert.equal(plan.patches.completedAt, NOW);
		assert.equal(plan.patches.result, "blocked");
		assert.equal(plan.releaseClaims, true);
	});

	test("done with parallel worktree → checking, no claim release", () => {
		const plan = planTerminalUpdate({
			step: step({
				status: "running",
				phase: "running",
				worktreePath: "/tmp/wt",
			}),
			stepIndex: 0,
			status: "done",
			result: "shipped",
			parallelEnabled: true,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "checking");
		assert.equal(plan.releaseClaims, false);
		assert.equal(plan.patches.completedAt, NOW);
	});

	test("skipped releases claims without completedAt", () => {
		const plan = planTerminalUpdate({
			step: step({ status: "running", phase: "running" }),
			stepIndex: 0,
			status: "skipped",
			parallelEnabled: false,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "skipped");
		assert.equal(plan.patches.completedAt, undefined);
		assert.equal(plan.releaseClaims, true);
	});
});

// ── Transition-table integration (ported + PASS→checking) ────────────────────

function makePhaseStep(status: StepStatus, extra: Partial<QuestStep> = {}): QuestStep {
	return {
		content: "t",
		status,
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
		...extra,
	};
}

describe("Transition-table integration (verify-outcome)", () => {
	test("quest_update flow: running → done (no verification)", () => {
		const s = makePhaseStep("running", { startedAt: Date.now() - 5000 });
		const t1 = validateTransition(s, "done");
		assert.equal(t1.ok, true);
		assert.equal(s.status, "done");
	});

	test("quest_update flow: running → verifying → done (with verification)", () => {
		const s = makePhaseStep("running", { startedAt: Date.now() - 5000 });
		const t1 = validateTransition(s, "verifying");
		assert.equal(t1.ok, true);
		assert.equal(s.status, "verifying");
		const t2 = validateTransition(s, "done");
		assert.equal(t2.ok, true);
		assert.equal(s.status, "done");
	});

	test("quest_update flow: running → verifying → failed", () => {
		const s = makePhaseStep("running");
		assert.equal(validateTransition(s, "verifying").ok, true);
		assert.equal(validateTransition(s, "failed").ok, true);
		assert.equal(s.status, "failed");
	});

	test("quest_update flow: verifying → retrying (pending on disk)", () => {
		const s = makePhaseStep("verifying");
		const t1 = validateTransition(s, "retrying");
		assert.equal(t1.ok, true);
		assert.equal(s.status, "pending");
	});

	test("PASS → checking when parallel && worktree (phase table)", () => {
		const s = makePhaseStep("verifying", {
			phase: "verifying",
			sandboxArtifacts: { worktreePath: "/tmp/wt-step-0", calls: [], touchedPaths: [] },
		});
		const plan = planVerifyPass({
			step: snapshotStepForVerify(s),
			stepIndex: 0,
			evidence: "ok",
			parallelEnabled: true,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "checking");
		const t = validateTransition(s, plan.nextPhase);
		assert.equal(t.ok, true);
		assert.equal(s.phase, "checking");
		// checking projects to running for coarse status
		assert.equal(s.status, "running");
	});

	test("PASS → done when parallel but no worktree (phase table)", () => {
		const s = makePhaseStep("verifying", { phase: "verifying" });
		const plan = planVerifyPass({
			step: snapshotStepForVerify(s),
			stepIndex: 0,
			evidence: "ok",
			parallelEnabled: true,
			now: NOW,
		});
		assert.equal(plan.nextPhase, "done");
		assert.equal(validateTransition(s, plan.nextPhase).ok, true);
		assert.equal(s.status, "done");
	});

	test("verify FAIL retry plan then phase hop verifying → retrying → queued", () => {
		const s = makePhaseStep("verifying", { phase: "verifying", verifyRetries: 0 });
		const plan = planVerifyFail({
			step: snapshotStepForVerify(s),
			stepIndex: 0,
			evidence: "lint",
			inferred: false,
			ladderLength: 0,
			now: NOW,
			policy,
		});
		assert.equal(plan.kind, "retry");
		// beginStepRetry path: verifying → retrying → queued
		assert.equal(validateTransition(s, "retrying").ok, true);
		assert.equal(validateTransition(s, "queued").ok, true);
		assert.equal(s.status, "pending");
	});

	test("rejects done → anything", () => {
		const s = makePhaseStep("done");
		assert.equal(validateTransition(s, "pending").ok, false);
		assert.equal(validateTransition(s, "running").ok, false);
		assert.equal(validateTransition(s, "verifying").ok, false);
		assert.equal(validateTransition(s, "failed").ok, false);
	});
});
