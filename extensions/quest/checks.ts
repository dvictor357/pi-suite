/**
 * quest/checks.ts — deterministic verification adapters.
 *
 * After a worker reports a step done, pi-suite runs the project's own
 * type/lint/format/test checks and uses the result as a HARD GATE: a failing
 * check fails the step before any LLM verifier is spawned (see the `quest_update`
 * gate in register-planning.ts). This is the machine-checkable half of
 * verification — the LLM verifier then only judges what checks cannot.
 *
 * Because normal execution now runs inside pi-minions (which returns only final
 * text), quest cannot observe the worker's tool calls. So the checks run here,
 * in the project cwd, against whatever the worker left on disk.
 *
 * Which checks apply is resolved from the pi-memory ProjectMemory profile (tool
 * NAMES like "Vitest"/"ESLint") plus package.json scripts (the concrete
 * commands). Resolution (`resolveChecks`) is pure and unit-tested; execution
 * (`runChecks`) is the thin process-spawning wrapper kept out of the test path.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJSON, projectMemoryPath, type ProjectMemory } from "../../core";
import { parseCommand, type AcceptanceEvidence } from "./acceptance";
import { ACCEPTANCE, VERIFICATION } from "./constants";

/** The deterministic checks the gate knows how to run. */
export type CheckKind = "typecheck" | "lint" | "format" | "test";

/** A resolved, ready-to-run check. */
export interface PlannedCheck {
	kind: CheckKind;
	/** Human-readable command, for prompts and ledgers (e.g. "npm run lint"). */
	command: string;
	/** Executable passed to execFileSync (no shell). */
	file: string;
	/** Argument vector for {@link file}. */
	args: string[];
}

/** Outcome of one check. */
export interface CheckResult {
	kind: CheckKind;
	command: string;
	/** "skipped" means no signal for this kind — never blocks the gate. */
	status: "pass" | "fail" | "skipped";
	/** Process exit code; -1 when the process could not be spawned or timed out. */
	exitCode: number;
	/** Truncated tail of combined output, for diagnostics. Empty for "skipped". */
	summary: string;
	/**
	 * Set on a "fail" that also fails at the step's baseline commit: the step
	 * didn't cause it, so it never fails the gate (see {@link gateChecks}).
	 */
	preexisting?: boolean;
}

/** Node package managers that expose `<pm> run <script>`. */
const NODE_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Resolve the node package-manager binary for run-scripts, or null. */
function pmBinary(profile: ProjectMemory | null, hasPackageJson: boolean): string | null {
	const pm = profile?.packageManager?.trim().toLowerCase();
	if (pm && NODE_PACKAGE_MANAGERS.has(pm)) return pm;
	// A package.json with scripts but an unknown/non-node PM → default to npm.
	return hasPackageJson ? "npm" : null;
}

/**
 * The package.json `scripts` map for a project, or an empty object when absent
 * or unreadable. Pulled out so {@link resolveChecks} stays pure over its inputs.
 */
function readPackageScripts(cwd: string): Record<string, string> {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return {};
	try {
		const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> };
		const scripts = pkg.scripts;
		if (!scripts || typeof scripts !== "object") return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(scripts)) if (typeof v === "string") out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** Split a display command string into an execFileSync file + argv. */
function toExec(command: string): { file: string; args: string[] } {
	const parts = command.split(/\s+/).filter(Boolean);
	return { file: parts[0] ?? "", args: parts.slice(1) };
}

/** First script key present in `scripts`, or null. */
function firstScript(scripts: Record<string, string>, ...keys: string[]): string | null {
	for (const k of keys) if (scripts[k]?.trim()) return k;
	return null;
}

function planFromScript(kind: CheckKind, pm: string, script: string): PlannedCheck {
	const command = `${pm} run ${script}`;
	return { kind, command, ...toExec(command) };
}

function planFromCommand(kind: CheckKind, command: string): PlannedCheck {
	return { kind, command, ...toExec(command) };
}

/** Tool-name → command fallback for each kind, keyed off the profile fields. */
function fallbackCheck(
	kind: CheckKind,
	profile: ProjectMemory | null,
	cwd: string,
): PlannedCheck | null {
	const test = profile?.testRunner?.toLowerCase() ?? "";
	const lint = profile?.linter?.toLowerCase() ?? "";
	const fmt = profile?.formatter?.toLowerCase() ?? "";
	const build = profile?.buildTool?.toLowerCase() ?? "";

	switch (kind) {
		case "typecheck":
			if (build.includes("tsc") || existsSync(join(cwd, "tsconfig.json")))
				return planFromCommand("typecheck", "npx tsc --noEmit");
			return null;
		case "lint":
			if (lint.includes("biome")) return planFromCommand("lint", "npx biome check .");
			if (lint.includes("eslint")) return planFromCommand("lint", "npx eslint .");
			if (lint.includes("oxlint")) return planFromCommand("lint", "npx oxlint");
			if (lint.includes("ruff")) return planFromCommand("lint", "ruff check .");
			if (lint.includes("clippy")) return planFromCommand("lint", "cargo clippy");
			return null;
		case "format":
			// Only ever a non-mutating *check* — never a formatter that rewrites files.
			if (fmt.includes("biome")) return planFromCommand("format", "npx biome format .");
			if (fmt.includes("prettier")) return planFromCommand("format", "npx prettier --check .");
			if (fmt.includes("ruff")) return planFromCommand("format", "ruff format --check .");
			if (fmt.includes("black")) return planFromCommand("format", "black --check .");
			return null;
		case "test":
			if (test.includes("vitest")) return planFromCommand("test", "npx vitest run");
			if (test.includes("jest")) return planFromCommand("test", "npx jest");
			if (test.includes("mocha")) return planFromCommand("test", "npx mocha");
			if (test.includes("ava")) return planFromCommand("test", "npx ava");
			if (test.includes("pytest")) return planFromCommand("test", "pytest");
			if (test.includes("cargo")) return planFromCommand("test", "cargo test");
			if (test.includes("go test")) return planFromCommand("test", "go test ./...");
			return null;
	}
}

/**
 * Resolve which checks apply, in {@link VERIFICATION.checkOrder}. Precedence per
 * kind: a matching package.json script (concrete, PM-correct) beats the
 * tool-name fallback; a kind with no signal is omitted (treated as "skipped").
 * Pure over its inputs so it is unit-testable without a real project.
 */
export function resolveChecks(
	profile: ProjectMemory | null,
	scripts: Record<string, string>,
	cwd: string,
): PlannedCheck[] {
	const hasPackageJson = existsSync(join(cwd, "package.json"));
	const pm = pmBinary(profile, hasPackageJson);
	const planned: PlannedCheck[] = [];

	for (const kind of VERIFICATION.checkOrder) {
		let check: PlannedCheck | null = null;
		if (pm) {
			// Format uses only a non-mutating *check* script; a bare "format" that
			// rewrites files must never run as a gate.
			const scriptKey =
				kind === "typecheck"
					? firstScript(scripts, "typecheck", "type-check", "tsc")
					: kind === "format"
						? firstScript(scripts, "format:check", "format-check", "fmt:check", "check:format")
						: firstScript(scripts, kind);
			if (scriptKey) check = planFromScript(kind, pm, scriptKey);
		}
		if (!check) check = fallbackCheck(kind, profile, cwd);
		if (check) planned.push(check);
	}
	return planned;
}

/** Load the project profile (best-effort) and resolve the applicable checks. */
export function planChecks(cwd: string): PlannedCheck[] {
	let profile: ProjectMemory | null = null;
	try {
		profile = readJSON<ProjectMemory | null>(projectMemoryPath(cwd), null);
	} catch {
		profile = null;
	}
	return resolveChecks(profile, readPackageScripts(cwd), cwd);
}

/** Keep the last `n` characters of `text`, prefixed with an ellipsis when cut. */
function tail(text: string, n: number): string {
	const t = text.trimEnd();
	return t.length <= n ? t : `…${t.slice(-n)}`;
}

/**
 * Run one planned check to completion. Never throws: a non-zero exit, a timeout,
 * or a missing executable all resolve to a `fail`/`skipped` result. A missing
 * executable (ENOENT) is "skipped", not "fail" — the tool simply isn't installed,
 * which must not block a step it can't judge.
 */
export function runCheck(check: PlannedCheck, cwd: string): CheckResult {
	try {
		const out = execFileSync(check.file, check.args, {
			cwd,
			timeout: VERIFICATION.timeoutMs,
			stdio: "pipe",
			encoding: "utf8",
		});
		return {
			kind: check.kind,
			command: check.command,
			status: "pass",
			exitCode: 0,
			summary: tail(out ?? "", VERIFICATION.outputTailChars),
		};
	} catch (err) {
		const e = err as { status?: number | null; code?: string };
		return failedCheck(check, err, typeof e.status === "number" ? e.status : null);
	}
}

/**
 * Map a failed spawn to a result. A missing executable (ENOENT) is "skipped";
 * anything else — non-zero exit, timeout, kill — is a "fail" with the output tail.
 */
function failedCheck(check: PlannedCheck, err: unknown, exitCode: number | null): CheckResult {
	const e = err as { code?: unknown; stdout?: Buffer | string; stderr?: Buffer | string };
	// Tool not installed → can't judge; skip rather than block.
	if (e.code === "ENOENT") {
		return {
			kind: check.kind,
			command: check.command,
			status: "skipped",
			exitCode: -1,
			summary: `${check.file}: not found`,
		};
	}
	const combined = `${e.stdout?.toString() ?? ""}\n${e.stderr?.toString() ?? ""}`.trim();
	const code = typeof e.code === "string" ? e.code : undefined;
	return {
		kind: check.kind,
		command: check.command,
		status: "fail",
		exitCode: exitCode ?? -1,
		summary: tail(combined || (code ?? "check failed"), VERIFICATION.outputTailChars),
	};
}

/**
 * Async {@link runCheck}: same result mapping, but doesn't block the event loop,
 * so independent runs can overlap. Never rejects. `signal` aborts the process
 * (the result is then a "fail" the caller should discard).
 */
function runCheckAsync(
	check: PlannedCheck,
	cwd: string,
	signal?: AbortSignal,
): Promise<CheckResult> {
	return new Promise((resolve) => {
		execFile(
			check.file,
			check.args,
			{
				cwd,
				timeout: VERIFICATION.timeoutMs,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				signal,
			},
			(err, stdout, stderr) => {
				if (!err) {
					resolve({
						kind: check.kind,
						command: check.command,
						status: "pass",
						exitCode: 0,
						summary: tail(stdout ?? "", VERIFICATION.outputTailChars),
					});
					return;
				}
				// execFile reports the exit status as a numeric `code`.
				const exit =
					typeof (err as { code?: unknown }).code === "number" ? (err.code as number) : null;
				resolve(failedCheck(check, Object.assign(err, { stdout, stderr }), exit));
			},
		);
	});
}

/**
 * The gate's check loop, pure over its runners: run checks in order and stop
 * at the first failure the step caused. A failure that `runAtBaseline` reports
 * as also failing before the step is tagged `preexisting` and the loop moves on
 * — repo-wide checks would otherwise blame a step for redness it inherited.
 * `runAtBaseline` returning null (no baseline, or baseline-awareness off) keeps
 * the strict behaviour: any failure stops the gate.
 */
export function gateChecks(
	planned: readonly PlannedCheck[],
	run: (check: PlannedCheck) => CheckResult,
	runAtBaseline: (check: PlannedCheck) => CheckResult | null,
): CheckResult[] {
	const results: CheckResult[] = [];
	for (const check of planned) {
		const res = run(check);
		if (res.status === "fail" && runAtBaseline(check)?.status === "fail") {
			results.push({ ...res, preexisting: true });
			continue;
		}
		results.push(res);
		if (res.status === "fail") break;
	}
	return results;
}

/** Baseline outcomes per (repo, commit, command); a commit's result never changes. */
const baselineCache = new Map<string, CheckResult>();

/**
 * Run `check` against a pristine export of `sha` (git archive, so no worktree
 * bookkeeping and the step's working tree is untouched). `node_modules` is
 * symlinked from `cwd` so the toolchain matches. Null when the export fails —
 * the caller then can't tell, and treats the failure as the step's.
 */
export function runCheckAtBaseline(
	check: PlannedCheck,
	cwd: string,
	sha: string,
): CheckResult | null {
	let key: string;
	try {
		key = `${realpathSync(cwd)}\u0000${sha}\u0000${check.command}`;
	} catch {
		return null;
	}
	const cached = baselineCache.get(key);
	if (cached) return cached;
	const dir = mkdtempSync(join(tmpdir(), "pi-quest-baseline-"));
	try {
		const tar = execFileSync("git", ["archive", "--format=tar", sha], {
			cwd,
			maxBuffer: 512 * 1024 * 1024,
		});
		execFileSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 512 * 1024 * 1024 });
		if (existsSync(join(cwd, "node_modules"))) {
			symlinkSync(join(realpathSync(cwd), "node_modules"), join(dir, "node_modules"));
		}
		const result = runCheck(check, dir);
		baselineCache.set(key, result);
		return result;
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** In-flight/finished async baseline runs, keyed like {@link baselineCache}. */
const baselineAsyncCache = new Map<string, Promise<CheckResult | null>>();

/** Extract `sha` into `dir` by streaming `git archive` into `tar` (non-blocking). */
function exportCommit(cwd: string, sha: string, dir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const git = spawn("git", ["archive", "--format=tar", sha], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "ignore"] });
		git.stdout.pipe(tar.stdin);
		let pending = 2;
		let failed = false;
		const done = (name: string) => (code: number | null) => {
			if (failed) return;
			if (code !== 0) {
				failed = true;
				reject(new Error(`${name} exited ${code}`));
				return;
			}
			if (--pending === 0) resolve();
		};
		git.on("error", reject).on("close", done("git archive"));
		tar.on("error", reject).on("close", done("tar"));
	});
}

/**
 * Async {@link runCheckAtBaseline}: export `sha` and run `check` there without
 * blocking, deduplicating concurrent requests. Null when the export fails or
 * the run was aborted — aborted runs are never cached.
 */
function runCheckAtBaselineAsync(
	check: PlannedCheck,
	cwd: string,
	sha: string,
	signal?: AbortSignal,
): Promise<CheckResult | null> {
	let key: string;
	try {
		key = `${realpathSync(cwd)}\u0000${sha}\u0000${check.command}`;
	} catch {
		return Promise.resolve(null);
	}
	const known = baselineCache.get(key);
	if (known) return Promise.resolve(known);
	const inFlight = baselineAsyncCache.get(key);
	if (inFlight) return inFlight;

	const run = (async (): Promise<CheckResult | null> => {
		const dir = await mkdtemp(join(tmpdir(), "pi-quest-baseline-"));
		try {
			await exportCommit(cwd, sha, dir);
			if (existsSync(join(cwd, "node_modules"))) {
				await symlink(join(realpathSync(cwd), "node_modules"), join(dir, "node_modules"));
			}
			if (signal?.aborted) return null;
			const result = await runCheckAsync(check, dir, signal);
			if (signal?.aborted) return null;
			baselineCache.set(key, result);
			return result;
		} catch {
			return null;
		} finally {
			baselineAsyncCache.delete(key);
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	})();
	baselineAsyncCache.set(key, run);
	return run;
}

/**
 * Run the gate's checks in `cwd`. With a `baselineSha` (and
 * `VERIFICATION.baselineAware`), failures that also fail at the baseline are
 * tagged pre-existing instead of failing the step.
 */
export function runChecks(
	planned: PlannedCheck[],
	cwd: string,
	baselineSha: string | null = null,
): CheckResult[] {
	return gateChecks(
		planned,
		(check) => runCheck(check, cwd),
		(check) =>
			baselineSha && VERIFICATION.baselineAware
				? runCheckAtBaseline(check, cwd, baselineSha)
				: null,
	);
}

/**
 * Run one quest acceptance command in `cwd` without a shell. Unlike a gate
 * check, a missing executable is a failure (it can't prove the goal), and a
 * pass also records whether the command was red at `baselineSha` (cached) — a
 * command already green at baseline proves nothing about the quest's change.
 *
 * Non-blocking. With `concurrentBaseline` the baseline run starts alongside the
 * real one (wall time ≈ one run instead of two) and is aborted if the real run
 * fails, since its answer is then unused.
 */
export async function runAcceptanceCommand(
	command: string,
	cwd: string,
	baselineSha: string | null,
	concurrentBaseline: boolean = ACCEPTANCE.concurrentBaseline,
): Promise<AcceptanceEvidence> {
	const parsed = parseCommand(command);
	if ("error" in parsed) {
		return { command, status: "fail", exitCode: -1, summary: parsed.error, at: Date.now() };
	}
	const check: PlannedCheck = { kind: "test", command, file: parsed.file, args: parsed.args };
	const abort = new AbortController();
	const startBaseline = () =>
		baselineSha
			? runCheckAtBaselineAsync(check, cwd, baselineSha, abort.signal)
			: Promise.resolve(null);
	const early = concurrentBaseline ? startBaseline() : null;
	const res = await runCheckAsync(check, cwd);
	if (res.status !== "pass") {
		abort.abort();
		await early;
		return {
			command,
			status: "fail",
			exitCode: res.exitCode,
			summary: res.summary,
			at: Date.now(),
		};
	}
	const base = await (early ?? startBaseline());
	return {
		command,
		status: "pass",
		exitCode: 0,
		summary: res.summary,
		redAtBaseline: base ? base.status !== "pass" : undefined,
		at: Date.now(),
	};
}

/** Map a failing check's kind to the eval failure taxonomy code. */
export function failureCodeForCheck(kind: CheckKind) {
	switch (kind) {
		case "test":
			return "TEST_FAILURE" as const;
		case "typecheck":
			return "TYPECHECK_FAILURE" as const;
		case "lint":
			return "LINT_FAILURE" as const;
		case "format":
			return "FORMAT_FAILURE" as const;
	}
}

/**
 * Compact one-line summary of check outcomes, e.g. "typecheck:pass test:fail".
 * A failure inherited from the baseline reads "typecheck:preexisting".
 */
export function summarizeChecks(results: readonly CheckResult[]): string {
	return results.map((r) => `${r.kind}:${r.preexisting ? "preexisting" : r.status}`).join(" ");
}

/** The first failing check the step caused, or null when none did. */
export function firstFailure(results: readonly CheckResult[]): CheckResult | null {
	return results.find((r) => r.status === "fail" && !r.preexisting) ?? null;
}
