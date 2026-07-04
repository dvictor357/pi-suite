import type { SandboxProfile } from "./sandbox";

export type VerifyOutcome = "pass" | "fail" | "inconclusive";

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
