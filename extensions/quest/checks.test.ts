import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import type { ProjectMemory } from "../../core";
import {
	resolveChecks,
	runCheck,
	failureCodeForCheck,
	summarizeChecks,
	firstFailure,
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
