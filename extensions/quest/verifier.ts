import type { SandboxProfile } from "./sandbox";
import type { StepEvidence } from "./evidence";
import { renderEvidenceBlock } from "./evidence";

export type VerifyOutcome = "pass" | "fail" | "inconclusive";

/**
 * Max inconclusive verifier replies before auto-fail. 1 = one re-prompt, then
 * the second unclear reply fails the step with an explicit FailureCode.
 */
export const MAX_VERIFY_INCONCLUSIVES = 1;

/** Fixed machine-readable completion shape the verifier must emit. */
export const VERIFY_COMPLETION_SCHEMA = {
	outcome: "PASS | FAIL",
	evidence: "short concrete reason (what you checked / what is wrong)",
	impact: "optional dependency/architecture notes",
} as const;

/**
 * Build a sandbox compliance checklist for the verifier prompt.
 *
 * When a sandbox profile is active, this returns additional checklist items
 * the verifier must check. Returns an empty array when sandbox is off.
 */
export function buildSandboxComplianceChecks(profile?: SandboxProfile): string[] {
	if (!profile || profile.mode === "none") return [];

	const checks: string[] = [];

	checks.push(`**Sandbox compliance** (mode: ${profile.mode}):`);

	if (profile.allowedPaths.length > 0) {
		checks.push(
			`- All changed/created files MUST be within allowed paths: ${profile.allowedPaths.map((g) => `\`${g}\``).join(", ")}`,
		);
	} else {
		checks.push(
			`- **CRITICAL:** No files should be created or modified (allowed paths is empty — deny-all).`,
		);
	}

	if (profile.deniedPaths.length > 0) {
		checks.push(
			`- No file matching a denied glob was touched: ${profile.deniedPaths
				.slice(0, 5)
				.map((g) => `\`${g}\``)
				.join(", ")}${profile.deniedPaths.length > 5 ? " …" : ""}`,
		);
	}

	if (!profile.allowNetwork) {
		checks.push(`- No network access was used (curl, git push/fetch, npm publish, etc.).`);
	}

	if (!profile.allowPackageInstall) {
		checks.push(`- No package install commands were run (npm install, pip install, etc.).`);
	}

	if (profile.denyCommands.length > 0) {
		checks.push(
			`- None of these denied commands were used: ${profile.denyCommands
				.slice(0, 5)
				.map((c) => `\`${c}\``)
				.join(", ")}`,
		);
	}

	if (profile.worktree) {
		checks.push(
			`- Worktree branch \`${profile.worktree.baseBranch}\` is consistent (no switching to other branches).`,
			`- Changes are isolated to the worktree path \`${profile.worktree.path}\`.`,
		);
	}

	checks.push(`- Any required project checks (format, lint, test) were actually run and passed.`);

	return checks;
}

/**
 * Parse the outcome from the verifier's raw text output.
 *
 * The verifier is instructed to *start* its reply with PASS or FAIL, but smaller
 * models rarely comply exactly — they wrap it in markdown (`**PASS**`), a heading
 * (`## FAIL`), a label (`Verdict: PASS`), an emoji (`✅ PASS`), or bury the verdict
 * on the final line. This parser stays deterministic but tolerant, in confidence
 * order, so the quality gate isn't silently lost to formatting.
 */
export function parseVerifyOutcome(rawOutput: string): VerifyOutcome {
	const text = (rawOutput ?? "").trim();
	if (!text) return "inconclusive";

	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	const leadingVerdict = (line: string): VerifyOutcome | null => {
		const stripped = line
			.replace(/^[*_`#>~\s-]+/, "")
			.trim()
			.toUpperCase();
		if (/^PASS(ED)?\b/.test(stripped)) return "pass";
		if (/^FAIL(ED|URE)?\b/.test(stripped)) return "fail";
		if (/^✅/.test(line) && /\bPASS/.test(stripped)) return "pass";
		if (/^(❌|🚫)/.test(line) && /\bFAIL/.test(stripped)) return "fail";
		return null;
	};

	const first = leadingVerdict(lines[0]);
	if (first) return first;

	const labelled = text.match(
		/\b(?:verdict|result|outcome|conclusion|status|assessment|decision)\b\s*[:\-–—]*\s*[*_`]*\s*(pass(?:ed)?|fail(?:ed|ure)?)\b/i,
	);
	if (labelled) return /^pass/i.test(labelled[1]) ? "pass" : "fail";

	const last = leadingVerdict(lines[lines.length - 1]);
	if (last) return last;

	return "inconclusive";
}

// ── Structured verify report (machine-readable preferred) ────────────────────

/** Parsed verifier reply with optional evidence/impact fields. */
export interface ParsedVerifyReport {
	outcome: VerifyOutcome;
	evidence?: string;
	impact?: string;
	/** True when a fixed-schema JSON object supplied the verdict. */
	structured: boolean;
}

const MAX_FIELD = 2_000;

function boundedField(value: unknown, max = MAX_FIELD): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t ? t.slice(0, max) : undefined;
}

function normalizeOutcomeToken(raw: unknown): VerifyOutcome | null {
	if (typeof raw !== "string") return null;
	const t = raw.trim().toUpperCase();
	if (/^PASS(ED)?$/.test(t)) return "pass";
	if (/^FAIL(ED|URE)?$/.test(t)) return "fail";
	if (t === "INCONCLUSIVE" || t === "UNKNOWN") return "inconclusive";
	return null;
}

/**
 * Prefer a fixed-schema JSON report (`outcome` + `evidence` + optional `impact`);
 * fall back to {@link parseVerifyOutcome} prose when no structured object is found.
 */
export function parseVerifyReport(rawOutput: string): ParsedVerifyReport {
	const text = (rawOutput ?? "").trim();
	if (!text) return { outcome: "inconclusive", structured: false };

	const fenced = [...text.matchAll(/```(?:json|verify)?\s*([\s\S]*?)```/gi)].reverse();
	const candidates = [...fenced.map((m) => m[1].trim()), text];

	for (const candidate of candidates) {
		// Prefer a JSON object that looks like the fixed completion schema.
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		try {
			const raw = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
			const outcome =
				normalizeOutcomeToken(raw.outcome) ??
				normalizeOutcomeToken(raw.verdict) ??
				normalizeOutcomeToken(raw.result);
			if (!outcome || outcome === "inconclusive") continue;
			return {
				outcome,
				evidence:
					boundedField(raw.evidence) ?? boundedField(raw.reason) ?? boundedField(raw.details),
				impact: boundedField(raw.impact),
				structured: true,
			};
		} catch {
			// try next candidate
		}
	}

	const outcome = parseVerifyOutcome(text);
	if (outcome === "inconclusive") return { outcome, structured: false };

	// Best-effort evidence from a labelled line when prose was used.
	const evidenceMatch = text.match(/\b(?:evidence|reason|details)\b\s*[:\-–—]\s*(.+?)(?:\n|$)/i);
	return {
		outcome,
		evidence: evidenceMatch ? boundedField(evidenceMatch[1]) : undefined,
		structured: false,
	};
}

// ── Closed-loop verifier handoff ─────────────────────────────────────────────

export interface VerifierHandoffInput {
	stepIndex: number;
	stepContent: string;
	stepContext?: string;
	/** Worker result text being verified. */
	stepResult?: string | null;
	verifierAgent?: string;
	/** Absolute worktree/cwd for the sub-agent when isolated. */
	verificationCwd?: string;
	/** Optional model id to pass through the pasteable subagent call. */
	model?: string;
	/** Objective evidence captured by the deterministic gate. */
	evidence?: StepEvidence;
	/** Pre-rendered evidence block; built from `evidence` when omitted. */
	evidenceBlock?: string;
	impactContext?: string;
	sandboxChecks?: string[];
	checksSummary?: string;
	maxVerifyRetries?: number;
	/** True when this handoff is a re-prompt after an inconclusive reply. */
	rePrompt?: boolean;
	/** Prior unclear verifier text (shown only on re-prompt). */
	previousInconclusive?: string;
	/** Files changed (for checklist emphasis when no full evidence object). */
	changedFiles?: string[];
}

/** Structured, ready-to-run verifier handoff (no live spawn required). */
export interface VerifierHandoffPayload {
	/** Fixed completion schema the verifier must produce. */
	schema: {
		outcome: "PASS" | "FAIL";
		evidence: string;
		impact?: string;
	};
	/** Ready-to-invoke subagent parameters. */
	subagent: {
		agent: string;
		task: string;
		cwd?: string;
		model?: string;
	};
	/** Pasteable tool call for the orchestrator. */
	paste: string;
	/** Full verifier task body (same as subagent.task). */
	task: string;
	/** After the verifier returns, report via quest_update with these fields. */
	reportVia: {
		tool: "quest_update";
		index: number;
		verifyOutcome: "PASS" | "FAIL";
		verifyEvidence: string;
	};
	details: {
		stepIndex: number;
		stepContent: string;
		checksSummary?: string;
		changedFiles: string[];
		impactContext?: string;
		maxVerifyRetries: number;
		rePrompt: boolean;
	};
}

export interface VerifierHandoffResult {
	payload: VerifierHandoffPayload;
	/** Orchestrator-facing message (includes paste + schema + context). */
	message: string;
}

function buildVerifierTaskBody(input: VerifierHandoffInput): string {
	const evidenceBlock =
		input.evidenceBlock ?? (input.evidence ? renderEvidenceBlock(input.evidence) : "");
	const sandboxChecks = input.sandboxChecks ?? [];
	const noFileChanges =
		(input.evidence?.changedFiles.length ?? input.changedFiles?.length ?? 0) === 0;

	const lines = [
		`Verify quest step #${input.stepIndex + 1}: ${input.stepContent}`,
		``,
		`## Step result to verify`,
		input.stepResult?.trim() || "(no result provided)",
		``,
		evidenceBlock,
		``,
		`## Checklist`,
		`1. Does the result match the step requirements?`,
		`2. Is the implementation correct and complete for the domain?`,
		`3. Are there issues or missing pieces deterministic checks cannot catch?`,
		`4. Is the change architecturally sound and readable? (Type/lint/format/test were already gated — do not re-run or re-litigate them.)`,
		`5. Review dependency impact for the changed files before PASS.`,
		noFileChanges
			? `6. This step changed no files — confirm whether that is expected before PASS.`
			: "",
		...(sandboxChecks.length > 0 ? [``, ...sandboxChecks] : []),
		``,
		input.impactContext?.trim() || "",
		``,
		input.stepContext?.trim() ? `## Step context\n${input.stepContext.trim()}` : "",
		``,
		`## Required completion schema`,
		`End with this JSON object (preferred). Prose "PASS"/"FAIL" is accepted as fallback:`,
		"```json",
		JSON.stringify(
			{
				outcome: "PASS",
				evidence: VERIFY_COMPLETION_SCHEMA.evidence,
				impact: VERIFY_COMPLETION_SCHEMA.impact,
			},
			null,
			2,
		),
		"```",
		`Use outcome "FAIL" with concrete evidence when anything is wrong or incomplete.`,
	];

	if (input.rePrompt) {
		lines.unshift(
			`**RE-PROMPT:** Your previous reply was inconclusive (no clear PASS/FAIL).`,
			`Reply with the fixed JSON schema only — outcome must be PASS or FAIL.`,
			input.previousInconclusive?.trim()
				? `Previous unclear output (truncated):\n> ${input.previousInconclusive.trim().slice(0, 400)}`
				: "",
			``,
		);
	}

	return lines.filter((l) => l !== undefined).join("\n");
}

/**
 * Build a ready-to-run structured verifier handoff after deterministic checks pass.
 *
 * Returns a pasteable `subagent(...)` invocation plus a fixed PASS/FAIL completion
 * schema. Does not spawn a live sub-agent — the orchestrator runs the handoff.
 */
export function buildVerifierHandoff(input: VerifierHandoffInput): VerifierHandoffResult {
	const agent = (input.verifierAgent ?? "verifier").trim() || "verifier";
	const maxVerifyRetries = input.maxVerifyRetries ?? 3;
	const task = buildVerifierTaskBody(input);
	const changedFiles = input.evidence?.changedFiles ?? input.changedFiles ?? [];

	const subagentArgs = [`agent="${agent}"`, `task=${JSON.stringify(task)}`];
	if (input.verificationCwd) {
		subagentArgs.push(`cwd=${JSON.stringify(input.verificationCwd)}`);
	}
	if (input.model?.trim()) {
		subagentArgs.push(`model=${JSON.stringify(input.model.trim())}`);
	}
	const paste = `subagent(${subagentArgs.join(", ")})`;

	const payload: VerifierHandoffPayload = {
		schema: {
			outcome: "PASS",
			evidence: VERIFY_COMPLETION_SCHEMA.evidence,
		},
		subagent: {
			agent,
			task,
			...(input.verificationCwd ? { cwd: input.verificationCwd } : {}),
			...(input.model?.trim() ? { model: input.model.trim() } : {}),
		},
		paste,
		task,
		reportVia: {
			tool: "quest_update",
			index: input.stepIndex,
			verifyOutcome: "PASS",
			verifyEvidence: "<short evidence>",
		},
		details: {
			stepIndex: input.stepIndex,
			stepContent: input.stepContent,
			...(input.checksSummary ? { checksSummary: input.checksSummary } : {}),
			changedFiles,
			...(input.impactContext ? { impactContext: input.impactContext } : {}),
			maxVerifyRetries,
			rePrompt: Boolean(input.rePrompt),
		},
	};

	const checksLine =
		input.checksSummary && input.checksSummary.trim()
			? `Deterministic checks passed (${input.checksSummary}).`
			: noFileHint(input);

	const message = [
		input.rePrompt
			? `🔁 Step #${input.stepIndex + 1} **verification re-prompt** (inconclusive reply): ${input.stepContent}`
			: `🔍 Step #${input.stepIndex + 1} **entered verification**: ${input.stepContent}`,
		checksLine,
		``,
		`## Ready-to-run verifier handoff`,
		`Run exactly:`,
		"```",
		paste,
		"```",
		``,
		`### Fixed completion schema (verifier must produce)`,
		"```json",
		`{"outcome":"PASS|FAIL","evidence":"<short concrete reason>","impact":"<optional>"}`,
		"```",
		`Prefer the JSON object. Prose PASS/FAIL remains accepted via parseVerifyOutcome.`,
		``,
		`### After the verifier returns`,
		`Call quest_update(index=${input.stepIndex}, verifyOutcome="PASS"|"FAIL", verifyEvidence="...").`,
		`If the reply is structured JSON, you may pass it as result and omit verifyOutcome — the gate will parse it.`,
		``,
		`${maxVerifyRetries} verification retries available before auto-fail.`,
		`Inconclusive replies get one re-prompt, then fail with MODEL_QUALITY.`,
	]
		.filter(Boolean)
		.join("\n");

	return { payload, message };
}

function noFileHint(input: VerifierHandoffInput): string {
	const n = input.evidence?.changedFiles.length ?? input.changedFiles?.length;
	if (n === 0) {
		return `This step changed no files — confirm whether that is expected for this step before PASS.`;
	}
	return `No deterministic checks were applicable for this project — judge more carefully.`;
}
