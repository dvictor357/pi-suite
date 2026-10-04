/**
 * quest/evidence.ts — machine-checkable evidence captured around a step.
 *
 * The quality gate used to trust the worker/verifier's prose. This module
 * captures the objective half instead: what the step actually changed on disk
 * (git diff) plus the deterministic check results (see checks.ts). Because
 * normal execution runs inside pi-minions — which returns only final text —
 * quest cannot see the worker's tool calls, so evidence is captured here at the
 * git level, path-independent of how the worker ran.
 *
 * A per-step baseline SHA is stamped when the step fires (runtime.ts fireStep);
 * at verification the diff is taken against that baseline so changes are
 * attributable to the step even across intermediate commits.
 *
 * All git access is best-effort via execFileSync (mirrors sandbox.ts) and never
 * throws — a missing/again-dirty repo degrades to empty evidence, never a crash.
 */
import { execFileSync } from "node:child_process";
import { asRecord, numOr, oneOf, strArray, strOr } from "../../core";
import type { CheckResult } from "./checks";

/** Objective record of what a step produced, consumed by the verifier + eval. */
export interface StepEvidence {
	/** Files changed since the step's baseline (git diff --name-only). */
	changedFiles: string[];
	/** Human-readable diff summary (git diff --stat), truncated. */
	diffStat: string;
	/** The baseline the diff was taken against; null when unknown/not a repo. */
	baselineSha: string | null;
	/** Deterministic check outcomes gathered at verification time. */
	checks: CheckResult[];
	/** Epoch-ms capture time. */
	capturedAt: number;
}

/**
 * Disk-read boundary: a persisted step's `evidence`, or undefined when absent
 * or garbled. Malformed check entries are dropped rather than trusted.
 */
export function coerceStepEvidence(value: unknown): StepEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const rec = asRecord(value);
	const checks = Array.isArray(rec.checks)
		? rec.checks.flatMap((raw): CheckResult[] => {
				const c = asRecord(raw);
				if (
					!oneOf(c.kind, ["typecheck", "lint", "format", "test"] as const) ||
					!oneOf(c.status, ["pass", "fail", "skipped"] as const) ||
					typeof c.command !== "string"
				) {
					return [];
				}
				return [
					{
						kind: c.kind,
						command: c.command,
						status: c.status,
						exitCode: numOr(c.exitCode, -1),
						summary: strOr(c.summary, ""),
						...(c.preexisting === true ? { preexisting: true } : {}),
					},
				];
			})
		: [];
	return {
		changedFiles: strArray(rec.changedFiles),
		// Verbatim: git --stat output is column-aligned with leading spaces.
		diffStat: typeof rec.diffStat === "string" ? rec.diffStat : "",
		baselineSha: typeof rec.baselineSha === "string" ? rec.baselineSha : null,
		checks,
		capturedAt: numOr(rec.capturedAt, 0),
	};
}

/** Run a git subcommand, returning trimmed stdout or null on any failure. */
function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, timeout: 10_000, stdio: "pipe", encoding: "utf8" })
			.toString()
			.trim();
	} catch {
		return null;
	}
}

/** Current worktree state used to attribute a step's later diff. */
export interface Baseline {
	/** HEAD commit SHA, or null when not a git repo. */
	sha: string | null;
	/** Whether the working tree already had uncommitted changes at capture. */
	dirty: boolean;
}

/**
 * Snapshot the repo baseline for a step: HEAD SHA plus whether the tree was
 * already dirty. Best-effort — outside a git repo this returns
 * `{ sha: null, dirty: false }`.
 */
export function captureBaseline(cwd: string): Baseline {
	const sha = git(cwd, ["rev-parse", "HEAD"]);
	const status = git(cwd, ["status", "--porcelain"]);
	return { sha, dirty: !!status && status.length > 0 };
}

/** Parse `git diff --name-only` output into a clean file list. */
export function parseChangedFiles(raw: string | null): string[] {
	if (!raw) return [];
	return raw
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * Collect the diff evidence for a step: files changed and a `--stat` summary,
 * taken against `baselineSha` when given, else against HEAD. Diffs include both
 * committed changes (baseline..HEAD) and any uncommitted working-tree changes,
 * so a worker that edited but didn't commit is still captured.
 */
export function collectDiffEvidence(
	cwd: string,
	baselineSha: string | null,
	statBudget = 1200,
): { changedFiles: string[]; diffStat: string } {
	// When a baseline commit is known, diff from it (captures commits the worker
	// made plus the current working tree). Otherwise fall back to HEAD, which
	// captures only uncommitted changes.
	const range = baselineSha ?? "HEAD";
	const names = parseChangedFiles(git(cwd, ["diff", "--name-only", range]));
	const statRaw = git(cwd, ["diff", "--stat", range]) ?? "";
	const diffStat = statRaw.length > statBudget ? `${statRaw.slice(0, statBudget)}…` : statRaw;
	return { changedFiles: names, diffStat };
}

/** Assemble the full {@link StepEvidence} for a step from its baseline + checks. */
export function buildStepEvidence(
	cwd: string,
	baselineSha: string | null,
	checks: CheckResult[],
	statBudget = 1200,
): StepEvidence {
	const { changedFiles, diffStat } = collectDiffEvidence(cwd, baselineSha, statBudget);
	return { changedFiles, diffStat, baselineSha, checks, capturedAt: Date.now() };
}

/**
 * Render a step's evidence as a prompt block for the LLM verifier — the
 * objective ground truth it should judge against instead of the worker's prose.
 * Returns "" when there is nothing to show.
 */
export function renderEvidenceBlock(evidence: StepEvidence): string {
	const lines: string[] = [
		"## Objective evidence (ground truth — judge against this, not the worker's prose)",
	];

	if (evidence.changedFiles.length > 0) {
		lines.push(
			``,
			`**Changed files (${evidence.changedFiles.length}):**`,
			...evidence.changedFiles.slice(0, 30).map((f) => `- ${f}`),
		);
		if (evidence.changedFiles.length > 30)
			lines.push(`- … and ${evidence.changedFiles.length - 30} more`);
	} else {
		lines.push(
			``,
			`**Changed files:** none detected — if the step required code changes, that is suspicious.`,
		);
	}

	if (evidence.diffStat.trim()) {
		lines.push(``, "**Diff stat:**", "```", evidence.diffStat.trim(), "```");
	}

	const ran = evidence.checks.filter((c) => c.status !== "skipped" && !c.preexisting);
	if (ran.length > 0) {
		lines.push(``, `**Deterministic checks (already gated — all passing):**`);
		for (const c of ran) lines.push(`- ${c.kind}: ${c.status} (\`${c.command}\`)`);
	}
	const inherited = evidence.checks.filter((c) => c.preexisting);
	if (inherited.length > 0) {
		lines.push(
			``,
			`**Pre-existing failures (also fail at the baseline commit — not gated):**`,
			...inherited.map((c) => `- ${c.kind} (\`${c.command}\`)`),
			`Judge only whether this step made them worse (new errors in the files it changed). Do not fail the step for errors it inherited, and do not ask it to fix unrelated code.`,
		);
		for (const c of inherited) {
			if (c.summary.trim()) lines.push("```", c.summary.trim(), "```");
		}
	}

	lines.push(
		``,
		`Deterministic checks above already passed, so do NOT re-litigate type/lint/format/test.`,
		`Judge only what they cannot: correctness for the domain, completeness vs the step,`,
		`readability, and architectural fit for the changed files.`,
	);

	return lines.join("\n");
}
