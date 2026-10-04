import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	runAcceptanceCommand,
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

describe("runAcceptanceCommand", () => {
	test("records pass/fail, missing tools, shell syntax, and red-at-baseline", async () => {
		const repo = mkdtempSync(join(tmpdir(), "quest-acceptance-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				cwd: repo,
				stdio: "pipe",
			})
				.toString()
				.trim();
		writeFileSync(join(repo, "feature"), "missing");
		writeFileSync(join(repo, "stable"), "ok");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const sha = git("rev-parse", "HEAD");
		writeFileSync(join(repo, "feature"), "ok"); // the quest delivers this
		const node = JSON.stringify(process.execPath);
		const check = (file: string) =>
			`${node} -e 'process.exit(require("fs").readFileSync("${file}", "utf8") === "ok" ? 0 : 1)'`;

		const delivered = await runAcceptanceCommand(check("feature"), repo, sha);
		assert.equal(delivered.status, "pass");
		assert.equal(delivered.redAtBaseline, true, "was red before the quest");

		const already = await runAcceptanceCommand(check("stable"), repo, sha);
		assert.equal(already.status, "pass");
		assert.equal(already.redAtBaseline, false, "green at baseline proves nothing");

		assert.equal(
			(await runAcceptanceCommand(check("stable"), repo, null)).redAtBaseline,
			undefined,
		);

		writeFileSync(join(repo, "feature"), "broken");
		const failing = await runAcceptanceCommand(check("feature"), repo, sha);
		assert.equal(failing.status, "fail");
		assert.equal(failing.exitCode, 1);
		assert.equal(failing.redAtBaseline, undefined);

		const missing = await runAcceptanceCommand("definitely-not-a-real-tool-xyz", repo, sha);
		assert.equal(missing.status, "fail", "a missing tool can't prove the goal");

		const shell = await runAcceptanceCommand("echo a && echo b", repo, sha);
		assert.equal(shell.status, "fail");
		assert.match(shell.summary, /without a shell/);
	});
});

describe("runAcceptanceCommand concurrency", () => {
	function repoWith(files: Record<string, string>, after: Record<string, string>) {
		const repo = mkdtempSync(join(tmpdir(), "quest-acceptance-async-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
				cwd: repo,
				stdio: "pipe",
			})
				.toString()
				.trim();
		for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const sha = git("rev-parse", "HEAD");
		for (const [name, body] of Object.entries(after)) writeFileSync(join(repo, name), body);
		return { repo, sha };
	}
	const node = JSON.stringify(process.execPath);

	test("the baseline run overlaps the real run (and runs after it when turned off)", async () => {
		// Each run drops a marker in a shared dir, then waits up to 2s to see the
		// other run's marker: it passes only if both runs were alive together.
		const markers = mkdtempSync(join(tmpdir(), "quest-acceptance-markers-"));
		const script = [
			`const fs = require("fs"), path = require("path");`,
			`const dir = ${JSON.stringify(markers)};`,
			`fs.writeFileSync(path.join(dir, String(process.pid)), "");`,
			`const end = Date.now() + 2000;`,
			`(function poll() {`,
			`  if (fs.readdirSync(dir).length >= 2) process.exit(0);`,
			`  if (Date.now() > end) process.exit(1);`,
			`  setTimeout(poll, 20);`,
			`})();`,
		].join(" ");
		const { repo, sha } = repoWith({ a: "" }, {});
		const command = `${node} -e '${script}'`;

		const together = await runAcceptanceCommand(command, repo, sha, true);
		assert.equal(together.status, "pass", "saw the baseline run alive at the same time");

		rmSync(markers, { recursive: true, force: true });
		mkdirSync(markers);
		const apart = await runAcceptanceCommand(command, repo, sha, false);
		assert.equal(apart.status, "fail", "alone: the baseline hadn't started yet");
	});

	test("a failing real run aborts the speculative baseline instead of waiting for it", async () => {
		// Current tree fails at once; the baseline commit would sleep 10s.
		const script = `const m = require("fs").readFileSync("mode", "utf8"); if (m === "fail") process.exit(1); setTimeout(() => process.exit(0), 10000);`;
		const { repo, sha } = repoWith({ mode: "slow" }, { mode: "fail" });
		const started = Date.now();
		const res = await runAcceptanceCommand(`${node} -e '${script}'`, repo, sha, true);
		assert.equal(res.status, "fail");
		assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
	});
});
