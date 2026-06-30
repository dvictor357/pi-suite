import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	shouldVerify,
	buildVerificationPrompt,
	buildSandboxComplianceChecks,
	nextVerifyAttempt,
	parseVerifyOutcome,
} from "./verifier";
import type { QuestStep } from "./types";
import type { SandboxProfile } from "./sandbox";

// ── shouldVerify ────────────────────────────────────────────────────────────

describe("shouldVerify", () => {
	test("true when both flags are on", () => {
		assert.equal(shouldVerify({ verifyOnComplete: true, teamVerificationEnabled: true }), true);
	});

	test("false when verifyOnComplete is off", () => {
		assert.equal(shouldVerify({ verifyOnComplete: false, teamVerificationEnabled: true }), false);
	});

	test("false when team verification is off", () => {
		assert.equal(shouldVerify({ verifyOnComplete: true, teamVerificationEnabled: false }), false);
	});

	test("false when both are off", () => {
		assert.equal(shouldVerify({ verifyOnComplete: false, teamVerificationEnabled: false }), false);
	});
});

// ── nextVerifyAttempt ───────────────────────────────────────────────────────

describe("nextVerifyAttempt", () => {
	test("initial retry returns count 1 with retries remaining", () => {
		const r = nextVerifyAttempt(0);
		assert.equal(r.nextCount, 1);
		assert.ok(r.retriesLeft > 0);
		assert.equal(r.canRetry, true);
	});

	test("exhausted retries returns canRetry false", () => {
		// MAX_VERIFY_RETRIES is 2 from constants (imported from core)
		const r = nextVerifyAttempt(2);
		assert.equal(r.nextCount, 3);
		assert.equal(r.retriesLeft, -1);
		assert.equal(r.canRetry, false);
	});
});

// ── parseVerifyOutcome ──────────────────────────────────────────────────────

describe("parseVerifyOutcome", () => {
	test("parses PASS", () => {
		assert.equal(parseVerifyOutcome("PASS: looks good"), "pass");
		assert.equal(parseVerifyOutcome("PASS everything checks out"), "pass");
	});

	test("parses FAIL", () => {
		assert.equal(parseVerifyOutcome("FAIL: formatting broken"), "fail");
		assert.equal(parseVerifyOutcome("FAIL missing file"), "fail");
	});

	test("inconclusive for ambiguous output", () => {
		assert.equal(parseVerifyOutcome("everything is fine"), "inconclusive");
		assert.equal(parseVerifyOutcome(""), "inconclusive");
	});

	test("case-insensitive", () => {
		assert.equal(parseVerifyOutcome("pass"), "pass");
		assert.equal(parseVerifyOutcome("fail"), "fail");
	});
});

// ── buildSandboxComplianceChecks ────────────────────────────────────────────

describe("buildSandboxComplianceChecks", () => {
	test("returns empty array when sandbox is none", () => {
		assert.deepEqual(buildSandboxComplianceChecks({ mode: "none" } as SandboxProfile), []);
		assert.deepEqual(buildSandboxComplianceChecks(undefined), []);
	});

	test("includes allowed paths in restricted mode", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**", "tests/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /within allowed paths/);
		assert.match(joined, /`src\/\*\*`/);
		assert.match(joined, /`tests\/\*\*`/);
	});

	test("shows critical deny-all when allowed paths is empty", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: [],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /CRITICAL/);
		assert.match(joined, /No files should be created or modified/);
	});

	test("includes denied paths check when present", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: ["src/secrets/**", "*.key"],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /denied glob/);
		assert.match(joined, /`src\/secrets\/\*\*`/);
	});

	test("checks network access when denied", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: false,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /No network access was used/);
	});

	test("checks package install when denied", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: false,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /No package install commands were run/);
	});

	test("checks denied commands when present", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: ["npm test"],
			denyCommands: ["rm -rf", "sudo"],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /denied commands were used/);
		assert.match(joined, /`rm -rf`/);
	});

	test("checks worktree consistency in isolated mode", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "isolated",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: {
				enabled: true,
				baseBranch: "main",
				path: ".pi/worktrees/my-quest",
				autoCleanup: true,
			},
		});
		const joined = checks.join("\n");
		assert.match(joined, /branch.*consistent/);
		assert.match(joined, /isolated to the worktree path/);
		assert.match(joined, /\.pi\/worktrees\/my-quest/);
	});

	test("always includes the required-checks item", () => {
		const checks = buildSandboxComplianceChecks({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		const joined = checks.join("\n");
		assert.match(joined, /required project checks/);
	});
});

// ── buildVerificationPrompt with sandbox ────────────────────────────────────

describe("buildVerificationPrompt with sandbox", () => {
	const baseTask: QuestStep = {
		content: "Add user auth",
		status: "verifying",
		agent: "worker",
		context: "Implement login/logout",
		dependencies: [],
		result: "auth module completed",
		attempts: 1,
		startedAt: null,
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};

	test("includes sandbox compliance checks when profile is provided", () => {
		const prompt = buildVerificationPrompt({
			task: baseTask,
			taskIndex: 0,
			config: { cwd: "/tmp/test", verifierAgent: "verifier", includeImpact: false },
			result: "done",
			sandboxProfile: {
				mode: "restricted",
				allowedPaths: ["src/**"],
				deniedPaths: [],
				allowCommands: [],
				denyCommands: [],
				allowNetwork: false,
				allowPackageInstall: true,
				worktree: null,
			},
		});
		assert.match(prompt, /Sandbox compliance/);
		assert.match(prompt, /No network access was used/);
	});

	test("omits sandbox checks when profile is not provided", () => {
		const prompt = buildVerificationPrompt({
			task: baseTask,
			taskIndex: 0,
			config: { cwd: "/tmp/test", verifierAgent: "verifier", includeImpact: false },
			result: "done",
		});
		assert.doesNotMatch(prompt, /Sandbox compliance/);
	});

	test("omits sandbox checks when profile mode is none", () => {
		const prompt = buildVerificationPrompt({
			task: baseTask,
			taskIndex: 0,
			config: { cwd: "/tmp/test", verifierAgent: "verifier", includeImpact: false },
			result: "done",
			sandboxProfile: { mode: "none" } as SandboxProfile,
		});
		assert.doesNotMatch(prompt, /Sandbox compliance/);
	});
});
