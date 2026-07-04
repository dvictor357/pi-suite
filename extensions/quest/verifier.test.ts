import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSandboxComplianceChecks, parseVerifyOutcome } from "./verifier";
import type { SandboxProfile } from "./sandbox";

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

	test("tolerates markdown / heading / emoji decoration on the verdict", () => {
		assert.equal(parseVerifyOutcome("**PASS** — everything checks out"), "pass");
		assert.equal(parseVerifyOutcome("## FAIL\nformatting is broken"), "fail");
		assert.equal(parseVerifyOutcome("`PASSED`"), "pass");
		assert.equal(parseVerifyOutcome("- FAILED: missing tests"), "fail");
		assert.equal(parseVerifyOutcome("✅ PASS, looks correct"), "pass");
		assert.equal(parseVerifyOutcome("❌ FAIL, needs work"), "fail");
	});

	test("reads a labelled verdict when the reply doesn't lead with it", () => {
		assert.equal(
			parseVerifyOutcome("I reviewed the code and ran the tests.\nVerdict: PASS"),
			"pass",
		);
		assert.equal(parseVerifyOutcome("Some analysis here.\n\nResult — FAIL"), "fail");
		assert.equal(parseVerifyOutcome("Outcome: passed all checks"), "pass");
	});

	test("reads a verdict on the final line", () => {
		assert.equal(parseVerifyOutcome("Checked the diff.\nRan lint and tests.\nPASS"), "pass");
		assert.equal(parseVerifyOutcome("The formatter was not run.\nFAIL"), "fail");
	});

	test("does not misread prose that merely mentions failing", () => {
		assert.equal(
			parseVerifyOutcome("Make sure the tests do not fail before shipping."),
			"inconclusive",
		);
		assert.equal(
			parseVerifyOutcome("This could pass review later, but I'm not sure yet."),
			"inconclusive",
		);
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
