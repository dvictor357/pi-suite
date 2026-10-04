import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ProjectMemory } from "../../core";
import {
	resolveChecks,
	runCheck,
	failureCodeForCheck,
	summarizeChecks,
	firstFailure,
	gateChecks,
	runChecks,
	type CheckResult,
	type PlannedCheck,
} from "./checks";

/** A minimal profile with only the fields resolveChecks reads. */
function profile(overrides: Partial<ProjectMemory>): ProjectMemory {
	return {
		name: "fixture",
		packageManager: null,
		language: null,
		framework: null,
		designSystem: null,
		buildTool: null,
		testRunner: null,
		linter: null,
		formatter: null,
		monorepo: false,
		directoryPattern: null,
		conventions: [],
		facts: [],
		lastScanned: 0,
		...overrides,
	};
}

/** A dir guaranteed to have no package.json / tsconfig.json. */
const bareDir = mkdtempSync(join(tmpdir(), "pi-checks-"));

// This repo's own root: has package.json + tsconfig.json.
const repoRoot = process.cwd();

describe("resolveChecks — precedence", () => {
	test("package.json scripts win over tool-name fallback", () => {
		const checks = resolveChecks(
			profile({ packageManager: "npm", linter: "Biome" }),
			{ lint: "eslint ." },
			repoRoot,
		);
		const lint = checks.find((c) => c.kind === "lint");
		assert.ok(lint, "lint check resolved");
		assert.equal(lint!.command, "npm run lint"); // script, not the Biome fallback
	});

	test("maps script kinds through checkOrder", () => {
		const checks = resolveChecks(
			profile({ packageManager: "npm" }),
			{ typecheck: "tsc --noEmit", "format:check": "prettier --check .", test: "node --test" },
			repoRoot,
		);
		assert.deepEqual(
			checks.map((c) => c.kind),
			["typecheck", "format", "test"], // in VERIFICATION.checkOrder, lint has no signal
		);
		assert.equal(checks.find((c) => c.kind === "test")!.command, "npm run test");
	});

	test("format never runs a mutating 'format' script — falls back to a --check command", () => {
		const checks = resolveChecks(
			profile({ packageManager: "npm", formatter: "Prettier" }),
			{ format: "prettier --write ." }, // writes → must not be used as a gate
			repoRoot,
		);
		const fmt = checks.find((c) => c.kind === "format");
		assert.ok(fmt);
		assert.match(fmt!.command, /--check/);
		assert.doesNotMatch(fmt!.command, /run format/);
	});

	test("tool-name fallback resolves per-language commands", () => {
		const checks = resolveChecks(
			profile({ testRunner: "pytest", linter: "Ruff", formatter: "Black" }),
			{},
			bareDir,
		);
		assert.equal(checks.find((c) => c.kind === "test")?.command, "pytest");
		assert.equal(checks.find((c) => c.kind === "lint")?.command, "ruff check .");
		assert.equal(checks.find((c) => c.kind === "format")?.command, "black --check .");
	});

	test("typecheck fallback fires when a tsconfig.json is present", () => {
		const checks = resolveChecks(profile({}), {}, repoRoot);
		assert.equal(checks.find((c) => c.kind === "typecheck")?.command, "npx tsc --noEmit");
	});

	test("no signal for any kind → empty (all skipped)", () => {
		assert.deepEqual(resolveChecks(profile({}), {}, bareDir), []);
		assert.deepEqual(resolveChecks(null, {}, bareDir), []);
	});

	test("a package.json with an unknown PM still gets scripts via npm default", () => {
		// bareDir has no package.json, so scripts are ignored regardless of profile.
		const ignored = resolveChecks(profile({ packageManager: "exotic" }), { test: "x" }, bareDir);
		assert.deepEqual(ignored, []);
		// repoRoot has a package.json, so an unknown PM defaults to npm run.
		const used = resolveChecks(profile({ packageManager: "exotic" }), { test: "x" }, repoRoot);
		assert.equal(used.find((c) => c.kind === "test")?.command, "npm run test");
	});
});

describe("runCheck — execution outcomes", () => {
	test("exit 0 → pass", () => {
		const check: PlannedCheck = {
			kind: "test",
			command: "node -e 0",
			file: process.execPath,
			args: ["-e", "process.exit(0)"],
		};
		const res = runCheck(check, repoRoot);
		assert.equal(res.status, "pass");
		assert.equal(res.exitCode, 0);
	});

	test("non-zero exit → fail with that exit code", () => {
		const check: PlannedCheck = {
			kind: "test",
			command: "node exit 3",
			file: process.execPath,
			args: ["-e", "process.exit(3)"],
		};
		const res = runCheck(check, repoRoot);
		assert.equal(res.status, "fail");
		assert.equal(res.exitCode, 3);
	});

	test("missing executable → skipped (can't judge, must not block)", () => {
		const check: PlannedCheck = {
			kind: "lint",
			command: "definitely-not-a-real-binary-xyz",
			file: "definitely-not-a-real-binary-xyz",
			args: [],
		};
		const res = runCheck(check, repoRoot);
		assert.equal(res.status, "skipped");
	});
});

describe("check helpers", () => {
	test("failureCodeForCheck maps kinds to taxonomy codes", () => {
		assert.equal(failureCodeForCheck("test"), "TEST_FAILURE");
		assert.equal(failureCodeForCheck("typecheck"), "TYPECHECK_FAILURE");
		assert.equal(failureCodeForCheck("lint"), "LINT_FAILURE");
		assert.equal(failureCodeForCheck("format"), "FORMAT_FAILURE");
	});

	test("summarizeChecks and firstFailure", () => {
		const results: CheckResult[] = [
			{ kind: "typecheck", command: "tsc", status: "pass", exitCode: 0, summary: "" },
			{ kind: "test", command: "vitest", status: "fail", exitCode: 1, summary: "boom" },
		];
		assert.equal(summarizeChecks(results), "typecheck:pass test:fail");
		assert.equal(firstFailure(results)?.kind, "test");
		assert.equal(firstFailure(results.slice(0, 1)), null);
	});
});

describe("baseline-aware gate", () => {
	const check = (kind: PlannedCheck["kind"]): PlannedCheck => ({
		kind,
		command: `npm run ${kind}`,
		file: "npm",
		args: ["run", kind],
	});
	const result = (kind: PlannedCheck["kind"], status: CheckResult["status"]): CheckResult => ({
		kind,
		command: `npm run ${kind}`,
		status,
		exitCode: status === "fail" ? 1 : 0,
		summary: "",
	});

	test("a failure that also fails at baseline is pre-existing and the gate continues", () => {
		const ran: string[] = [];
		const results = gateChecks(
			[check("typecheck"), check("test")],
			(c) => {
				ran.push(c.kind);
				return result(c.kind, c.kind === "typecheck" ? "fail" : "pass");
			},
			(c) => result(c.kind, "fail"),
		);
		assert.deepEqual(ran, ["typecheck", "test"], "kept going past the inherited failure");
		assert.equal(results[0].preexisting, true);
		assert.equal(firstFailure(results), null, "nothing the step caused");
		assert.equal(summarizeChecks(results), "typecheck:preexisting test:pass");
	});

	test("a failure that passes at baseline is the step's and stops the gate", () => {
		const results = gateChecks(
			[check("typecheck"), check("test")],
			(c) => result(c.kind, "fail"),
			(c) => result(c.kind, "pass"),
		);
		assert.equal(results.length, 1);
		assert.equal(firstFailure(results)?.kind, "typecheck");
	});

	test("an inherited failure does not mask a new one in a later check", () => {
		const results = gateChecks(
			[check("typecheck"), check("test")],
			(c) => result(c.kind, "fail"),
			(c) => result(c.kind, c.kind === "typecheck" ? "fail" : "pass"),
		);
		assert.equal(firstFailure(results)?.kind, "test");
		assert.equal(summarizeChecks(results), "typecheck:preexisting test:fail");
	});

	test("no baseline answer keeps the strict behaviour", () => {
		const results = gateChecks(
			[check("typecheck"), check("test")],
			(c) => result(c.kind, "fail"),
			() => null,
		);
		assert.equal(results.length, 1);
		assert.equal(firstFailure(results)?.kind, "typecheck");
	});

	test("runChecks compares against a real baseline commit", () => {
		const repo = mkdtempSync(join(tmpdir(), "quest-baseline-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				cwd: repo,
				stdio: "pipe",
			})
				.toString()
				.trim();
		const flagCheck = (name: string): PlannedCheck => ({
			kind: "test",
			command: `check ${name}`,
			file: process.execPath,
			args: [
				"-e",
				`process.exit(require("fs").readFileSync(${JSON.stringify(name)}, "utf8").trim() === "bad" ? 1 : 0)`,
			],
		});
		git("init", "-q");
		writeFileSync(join(repo, "inherited"), "bad");
		writeFileSync(join(repo, "caused"), "good");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const sha = git("rev-parse", "HEAD");
		writeFileSync(join(repo, "caused"), "bad"); // the step breaks this one

		const inherited = runChecks([flagCheck("inherited")], repo, sha);
		assert.equal(inherited[0].preexisting, true);
		assert.equal(firstFailure(inherited), null);

		const caused = runChecks([flagCheck("caused")], repo, sha);
		assert.equal(caused[0].status, "fail");
		assert.equal(caused[0].preexisting, undefined);
		assert.equal(firstFailure(caused)?.command, "check caused");

		const strict = runChecks([flagCheck("inherited")], repo, null);
		assert.equal(firstFailure(strict)?.command, "check inherited", "no baseline: strict");
	});
});
