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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJSON, projectMemoryPath, type ProjectMemory } from "../../core";
import { VERIFICATION } from "./constants";

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
export function readPackageScripts(cwd: string): Record<string, string> {
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
		const e = err as {
			status?: number | null;
			code?: string;
			stdout?: Buffer | string;
			stderr?: Buffer | string;
		};
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
		return {
			kind: check.kind,
			command: check.command,
			status: "fail",
			exitCode: typeof e.status === "number" ? e.status : -1,
			summary: tail(combined || (e.code ?? "check failed"), VERIFICATION.outputTailChars),
		};
	}
}

/**
 * Run planned checks in order, stopping at the first failure (the gate only
 * needs one). Returns every result produced so far — the failing one last.
 */
export function runChecks(planned: PlannedCheck[], cwd: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const check of planned) {
		const res = runCheck(check, cwd);
		results.push(res);
		if (res.status === "fail") break;
	}
	return results;
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

/** Compact one-line summary of check outcomes, e.g. "typecheck:pass test:fail". */
export function summarizeChecks(results: readonly CheckResult[]): string {
	return results.map((r) => `${r.kind}:${r.status}`).join(" ");
}

/** The first failing check, or null when all passed/were skipped. */
export function firstFailure(results: readonly CheckResult[]): CheckResult | null {
	return results.find((r) => r.status === "fail") ?? null;
}
