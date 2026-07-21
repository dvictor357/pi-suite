import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateToolCall } from "./sandbox-guard";
import { isSandboxActive } from "./sandbox";
import type { Quest, QuestStep, SandboxPolicy } from "./types";
import {
	effectiveSandboxProfile,
	isGuardActiveStep,
	maxRestrictiveProfile,
	parseSubagentTaskEntries,
	resolveSubagentClaimTargets,
} from "./tool-call-guard";
import { resolveSandboxProfile } from "./sandbox";

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeQuest(overrides: Partial<Quest> = {}): Quest {
	return {
		version: 1,
		name: "test-quest",
		goal: "test guard",
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

const RESTRICTED: SandboxPolicy = {
	mode: "restricted",
	allowedPaths: ["src/**"],
	deniedPaths: [],
	allowCommands: ["npm test"],
	denyCommands: [],
	allowNetwork: false,
	allowPackageInstall: false,
	worktree: null,
};

// ── isGuardActiveStep ────────────────────────────────────────────────────────

describe("isGuardActiveStep", () => {
	test("true for running/dispatching/verifying/checking phases", () => {
		assert.equal(isGuardActiveStep(makeStep({ status: "running", phase: "running" })), true);
		assert.equal(isGuardActiveStep(makeStep({ status: "pending", phase: "dispatching" })), true);
		assert.equal(isGuardActiveStep(makeStep({ status: "verifying", phase: "verifying" })), true);
		assert.equal(isGuardActiveStep(makeStep({ status: "running", phase: "checking" })), true);
	});

	test("false for queued/done/failed/skipped", () => {
		assert.equal(isGuardActiveStep(makeStep({ status: "pending" })), false);
		assert.equal(isGuardActiveStep(makeStep({ status: "done", phase: "done" })), false);
		assert.equal(isGuardActiveStep(makeStep({ status: "failed", phase: "failed" })), false);
		assert.equal(isGuardActiveStep(makeStep({ status: "skipped", phase: "skipped" })), false);
	});
});

// ── R8: effectiveSandboxProfile ──────────────────────────────────────────────

describe("effectiveSandboxProfile (R8)", () => {
	test("quest-none + step-restricted → effective restricted (blocks writes)", () => {
		const quest = makeQuest({
			// no quest.sandbox — step override escalates mode; path allow-list
			// cannot re-open what quest-level empty-under-restricted denies.
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					sandbox: { mode: "restricted", allowedPaths: ["src/**"] },
				}),
			],
		});
		const profile = effectiveSandboxProfile(quest);
		assert.equal(profile.mode, "restricted");
		assert.equal(isSandboxActive(profile), true);
		// Escalation to restricted with empty quest allow-list = deny-all writes.
		assert.equal(evaluateToolCall(profile, "write", { path: "src/a.ts" }).block, true);
		assert.equal(evaluateToolCall(profile, "write", { path: "docs/x.md" }).block, true);
	});

	test("quest-restricted + step-none → still restricted (blocks)", () => {
		const quest = makeQuest({
			sandbox: RESTRICTED,
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					// step tries to de-escalate; resolveSandboxProfile ignores it
					sandbox: { mode: "none" },
				}),
			],
		});
		const profile = effectiveSandboxProfile(quest);
		assert.equal(profile.mode, "restricted");
		assert.equal(isSandboxActive(profile), true);
		// empty step allow-list under restricted still denies outside quest allow
		assert.equal(evaluateToolCall(profile, "write", { path: "docs/x.md" }).block, true);
	});

	test("quest-none + no active steps → mode none (no block)", () => {
		const quest = makeQuest({
			steps: [makeStep({ status: "pending" })],
		});
		const profile = effectiveSandboxProfile(quest);
		assert.equal(profile.mode, "none");
		assert.equal(isSandboxActive(profile), false);
		assert.equal(evaluateToolCall(profile, "write", { path: ".env" }).block, false);
	});

	test("quest-none + pending step with restricted sandbox is ignored", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "pending",
					sandbox: { mode: "restricted", allowedPaths: ["src/**"] },
				}),
			],
		});
		const profile = effectiveSandboxProfile(quest);
		assert.equal(profile.mode, "none");
	});

	test("dispatching step contributes to effective profile", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "pending",
					phase: "dispatching",
					sandbox: { mode: "isolated" },
				}),
			],
		});
		assert.equal(effectiveSandboxProfile(quest).mode, "isolated");
	});

	test("max of two running steps takes the tighter mode", () => {
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					sandbox: { mode: "restricted" },
				}),
				makeStep({
					status: "running",
					phase: "running",
					sandbox: { mode: "isolated" },
				}),
			],
		});
		assert.equal(effectiveSandboxProfile(quest).mode, "isolated");
	});

	test("maxRestrictiveProfile intersects allow paths across active profiles", () => {
		const a = resolveSandboxProfile({
			...RESTRICTED,
			allowedPaths: ["src/**", "tests/**"],
		});
		const b = resolveSandboxProfile({
			...RESTRICTED,
			allowedPaths: ["src/**", "docs/**"],
		});
		const merged = maxRestrictiveProfile(a, b);
		assert.deepEqual(merged.allowedPaths, ["src/**"]);
		assert.equal(merged.allowNetwork, false);
	});
});

// ── R2: resolveSubagentClaimTargets ──────────────────────────────────────────

describe("parseSubagentTaskEntries", () => {
	test("parses single-agent form", () => {
		const entries = parseSubagentTaskEntries({
			agent: "worker",
			task: "do the thing",
			model: "gpt-4",
		});
		assert.equal(entries.length, 1);
		assert.equal(entries[0].agent, "worker");
	});

	test("parses multi-task form", () => {
		const entries = parseSubagentTaskEntries({
			tasks: [
				{ agent: "worker", cwd: "/wt/step-0", writeClaim: ["src/a.ts"] },
				{ agent: "quick-worker", cwd: "/wt/step-1", writeClaim: ["tests/a.ts"] },
			],
			onError: "continue",
		});
		assert.equal(entries.length, 2);
		assert.equal(entries[0].cwd, "/wt/step-0");
		assert.equal(entries[1].agent, "quick-worker");
	});

	test("ignores entries without agent", () => {
		assert.deepEqual(parseSubagentTaskEntries({ task: "no agent" }), []);
		assert.deepEqual(parseSubagentTaskEntries({ tasks: [{ cwd: "/x" }] }), []);
	});
});

describe("resolveSubagentClaimTargets (R2)", () => {
	test("sequential single-agent matches lastFiredStepIndex", () => {
		const quest = makeQuest({
			lastFiredStepIndex: 0,
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/a.ts"],
					content: "Write A",
				}),
				makeStep({ status: "pending", agent: "worker", writeClaim: ["src/b.ts"] }),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, { agent: "worker", task: "…" });
		assert.equal(targets.length, 1);
		assert.equal(targets[0].stepIndex, 0);
		assert.deepEqual(targets[0].writeClaim, ["src/a.ts"]);
	});

	test("sequential: agent mismatch yields no targets", () => {
		const quest = makeQuest({
			lastFiredStepIndex: 0,
			steps: [makeStep({ status: "running", phase: "running", agent: "worker" })],
		});
		assert.deepEqual(resolveSubagentClaimTargets(quest, { agent: "scout" }), []);
	});

	test("multi-task: disjoint claims resolve each step via worktree cwd", () => {
		const wt0 = "/tmp/.pi-worktrees/hash/quest/step-0";
		const wt1 = "/tmp/.pi-worktrees/hash/quest/step-1";
		const quest = makeQuest({
			lastFiredStepIndex: 1, // only last batch member — must NOT be the only match
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/auth.ts"],
					content: "Auth",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt0 },
				}),
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["tests/auth.test.ts"],
					content: "Auth tests",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt1 },
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			tasks: [
				{ agent: "worker", cwd: wt0, writeClaim: ["src/auth.ts"] },
				{ agent: "worker", cwd: wt1, writeClaim: ["tests/auth.test.ts"] },
			],
			onError: "continue",
		});
		assert.equal(targets.length, 2);
		assert.equal(targets[0].stepIndex, 0);
		assert.equal(targets[1].stepIndex, 1);
		assert.deepEqual(targets[0].writeClaim, ["src/auth.ts"]);
		assert.deepEqual(targets[1].writeClaim, ["tests/auth.test.ts"]);
	});

	test("multi-task: overlapping claims still resolve both steps (enforcement is caller's job)", () => {
		const wt0 = "/tmp/wt/0";
		const wt1 = "/tmp/wt/1";
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/shared.ts"],
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt0 },
				}),
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/shared.ts"],
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt1 },
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			tasks: [
				{ agent: "worker", cwd: wt0 },
				{ agent: "worker", cwd: wt1 },
			],
		});
		assert.equal(targets.length, 2);
		// Both claim the same path — registry will block the second on register.
		assert.deepEqual(targets[0].writeClaim, ["src/shared.ts"]);
		assert.deepEqual(targets[1].writeClaim, ["src/shared.ts"]);
	});

	test("explicit stepIndex binds when agent matches", () => {
		const quest = makeQuest({
			steps: [
				makeStep({ status: "running", phase: "running", agent: "worker", writeClaim: ["a"] }),
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["b"],
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			tasks: [{ agent: "worker", stepIndex: 1 }],
		});
		assert.equal(targets.length, 1);
		assert.equal(targets[0].stepIndex, 1);
		assert.deepEqual(targets[0].writeClaim, ["b"]);
	});

	test("unique agent among running steps binds without lastFired", () => {
		const quest = makeQuest({
			lastFiredStepIndex: -1,
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/x.ts"],
				}),
				makeStep({ status: "pending", agent: "scout" }),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, { agent: "worker" });
		assert.equal(targets.length, 1);
		assert.equal(targets[0].stepIndex, 0);
	});

	test("ambiguous same agent without cwd falls back to lastFiredStepIndex", () => {
		const quest = makeQuest({
			lastFiredStepIndex: 1,
			steps: [
				makeStep({ status: "running", phase: "running", agent: "worker", writeClaim: ["a"] }),
				makeStep({ status: "running", phase: "running", agent: "worker", writeClaim: ["b"] }),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, { agent: "worker" });
		assert.equal(targets.length, 1);
		assert.equal(targets[0].stepIndex, 1);
	});

	test("step writeClaim is source of truth over input claims", () => {
		const quest = makeQuest({
			lastFiredStepIndex: 0,
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/real.ts"],
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			agent: "worker",
			writeClaim: ["src/forged.ts"],
		});
		assert.deepEqual(targets[0].writeClaim, ["src/real.ts"]);
	});
});

// ── End-to-end claim conflict simulation (multi-task) ────────────────────────

describe("multi-task claim conflict simulation", () => {
	test("disjoint multi-task claims register without conflict", async () => {
		const { WriteClaimRegistry, normalizeClaims } = await import("./write-claim");
		const cwd = "/project";
		const reg = new WriteClaimRegistry();
		const wt0 = "/tmp/wt/a";
		const wt1 = "/tmp/wt/b";
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/a.ts"],
					content: "A",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt0 },
				}),
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/b.ts"],
					content: "B",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt1 },
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			tasks: [
				{ agent: "worker", cwd: wt0 },
				{ agent: "worker", cwd: wt1 },
			],
		});
		const conflicts: number[] = [];
		for (const t of targets) {
			const paths = normalizeClaims(t.writeClaim, cwd);
			const conflict = reg.register(cwd, t.stepIndex, quest.steps[t.stepIndex].content, paths);
			if (conflict) conflicts.push(t.stepIndex);
		}
		assert.deepEqual(conflicts, []);
		assert.equal(reg.active(cwd).length, 2);
	});

	test("overlapping multi-task claims block the second registration", async () => {
		const { WriteClaimRegistry, normalizeClaims } = await import("./write-claim");
		const cwd = "/project";
		const reg = new WriteClaimRegistry();
		const wt0 = "/tmp/wt/a";
		const wt1 = "/tmp/wt/b";
		const quest = makeQuest({
			steps: [
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/shared.ts"],
					content: "A",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt0 },
				}),
				makeStep({
					status: "running",
					phase: "running",
					agent: "worker",
					writeClaim: ["src/shared.ts"],
					content: "B",
					sandboxArtifacts: { calls: [], touchedPaths: [], worktreePath: wt1 },
				}),
			],
		});
		const targets = resolveSubagentClaimTargets(quest, {
			tasks: [
				{ agent: "worker", cwd: wt0 },
				{ agent: "worker", cwd: wt1 },
			],
		});
		assert.equal(targets.length, 2);
		const first = normalizeClaims(targets[0].writeClaim, cwd);
		assert.equal(reg.register(cwd, targets[0].stepIndex, "A", first), null);
		const second = normalizeClaims(targets[1].writeClaim, cwd);
		const conflict = reg.register(cwd, targets[1].stepIndex, "B", second);
		assert.ok(conflict);
		assert.equal(conflict.stepIndex, 0);
	});
});
