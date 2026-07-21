import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	buildSandboxComplianceChecks,
	buildVerifierHandoff,
	MAX_VERIFY_INCONCLUSIVES,
	parseVerifyOutcome,
	parseVerifyReport,
	VERIFY_COMPLETION_SCHEMA,
} from "./verifier";
import type { SandboxProfile } from "./sandbox";
import type { StepEvidence } from "./evidence";

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

// ── parseVerifyReport (structured preferred, prose fallback) ────────────────

describe("parseVerifyReport", () => {
	test("parses fixed-schema JSON outcome + evidence + impact", () => {
		const r = parseVerifyReport(
			JSON.stringify({
				outcome: "PASS",
				evidence: "diff matches step; tests green",
				impact: "only utils.ts dependents",
			}),
		);
		assert.equal(r.outcome, "pass");
		assert.equal(r.structured, true);
		assert.equal(r.evidence, "diff matches step; tests green");
		assert.equal(r.impact, "only utils.ts dependents");
	});

	test("parses fenced JSON verify block", () => {
		const r = parseVerifyReport(`Notes above.

\`\`\`json
{"outcome":"FAIL","evidence":"missing error handling"}
\`\`\`
`);
		assert.equal(r.outcome, "fail");
		assert.equal(r.structured, true);
		assert.equal(r.evidence, "missing error handling");
	});

	test("falls back to prose parseVerifyOutcome when no JSON", () => {
		const r = parseVerifyReport("PASS: looks good overall");
		assert.equal(r.outcome, "pass");
		assert.equal(r.structured, false);
	});

	test("inconclusive when neither structured nor prose verdict", () => {
		const r = parseVerifyReport("I looked at the files and they seem mostly fine.");
		assert.equal(r.outcome, "inconclusive");
		assert.equal(r.structured, false);
	});

	test("accepts verdict alias field", () => {
		const r = parseVerifyReport('{"verdict":"FAIL","reason":"no tests"}');
		assert.equal(r.outcome, "fail");
		assert.equal(r.evidence, "no tests");
		assert.equal(r.structured, true);
	});
});

// ── buildVerifierHandoff ────────────────────────────────────────────────────

describe("buildVerifierHandoff", () => {
	const baseEvidence: StepEvidence = {
		changedFiles: ["src/foo.ts"],
		diffStat: " src/foo.ts | 3 +++",
		baselineSha: "abc",
		checks: [
			{ kind: "typecheck", command: "npm run typecheck", status: "pass", exitCode: 0, summary: "" },
		],
		capturedAt: 1,
	};

	test("returns ready-to-run paste + fixed schema + reportVia", () => {
		const { payload, message } = buildVerifierHandoff({
			stepIndex: 2,
			stepContent: "Add handler",
			stepContext: "wire POST /x",
			stepResult: "added route",
			verifierAgent: "verifier",
			evidence: baseEvidence,
			checksSummary: "typecheck:pass",
			impactContext: "Codebase impact: src/foo.ts → bar.ts",
			maxVerifyRetries: 3,
		});

		assert.equal(payload.subagent.agent, "verifier");
		assert.match(payload.paste, /^subagent\(agent="verifier"/);
		assert.match(payload.paste, /task=/);
		assert.equal(payload.reportVia.tool, "quest_update");
		assert.equal(payload.reportVia.index, 2);
		assert.equal(payload.schema.outcome, "PASS");
		assert.ok(payload.schema.evidence);
		assert.deepEqual(
			{ outcome: VERIFY_COMPLETION_SCHEMA.outcome.split(" | ")[0] },
			{ outcome: "PASS" },
		);
		assert.match(payload.task, /Required completion schema/);
		assert.match(payload.task, /"outcome"/);
		assert.match(payload.task, /Add handler/);
		assert.match(payload.task, /Objective evidence/);
		assert.match(message, /Ready-to-run verifier handoff/);
		assert.match(message, /quest_update\(index=2/);
		assert.equal(payload.details.stepIndex, 2);
		assert.equal(payload.details.rePrompt, false);
		assert.deepEqual(payload.details.changedFiles, ["src/foo.ts"]);
		assert.equal(MAX_VERIFY_INCONCLUSIVES, 1);
	});

	test("includes cwd and model in paste when provided", () => {
		const { payload } = buildVerifierHandoff({
			stepIndex: 0,
			stepContent: "x",
			verificationCwd: "/tmp/wt",
			model: "gpt-test",
		});
		assert.equal(payload.subagent.cwd, "/tmp/wt");
		assert.equal(payload.subagent.model, "gpt-test");
		assert.match(payload.paste, /cwd="\/tmp\/wt"/);
		assert.match(payload.paste, /model="gpt-test"/);
	});

	test("re-prompt mode marks details and task body", () => {
		const { payload, message } = buildVerifierHandoff({
			stepIndex: 0,
			stepContent: "x",
			rePrompt: true,
			previousInconclusive: "looks fine to me",
		});
		assert.equal(payload.details.rePrompt, true);
		assert.match(payload.task, /RE-PROMPT/);
		assert.match(payload.task, /looks fine to me/);
		assert.match(message, /verification re-prompt/);
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
