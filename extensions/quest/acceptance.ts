/**
 * quest/acceptance.ts — quest-level acceptance gate.
 *
 * Step verification proves each step did what it said; it doesn't prove the
 * quest's goal holds. A quest whose steps all passed can still leave the
 * user-visible outcome broken — and the worker that does the work is the one
 * deciding what "done" meant. Acceptance closes that gap:
 *
 * - quest_create declares criteria (human-readable) and commands (machine
 *   proof) BEFORE any step runs. quest_plan may add commands, never remove them.
 * - When every step is done, the harness — not the model — runs the commands.
 *   All pass → the quest completes. A failure appends one focused corrective
 *   step; after ACCEPTANCE.maxCorrectiveRounds the quest pauses instead.
 * - Unlike the step gate, a command that already failed at the quest baseline
 *   is NOT exempt: red-at-baseline is the expected start (the goal wasn't met
 *   yet), so it is recorded as evidence ("was red, now green").
 *
 * Commands run without a shell: a command using pipes, redirects, chaining or
 * substitution is rejected at declaration. In a sandboxed quest each command
 * must also pass the sandbox guard as a `bash` call, at declaration and again
 * before it runs. Pure: no I/O. The runner lives in
 * checks.ts (`runAcceptanceCommand`); knobs in constants.ts `ACCEPTANCE`.
 */
import { asRecord, numOr, oneOf, optNum, strArray, strOr } from "../../core";
import { ACCEPTANCE, type AcceptanceConfig } from "./constants";
import { resolveSandboxProfile } from "./sandbox";
import { evaluateToolCall } from "./sandbox-guard";
import type { SandboxPolicy } from "./types";

/** One acceptance command's result, kept as completion evidence. */
export interface AcceptanceEvidence {
	command: string;
	status: "pass" | "fail";
	/** Process exit code; -1 when it could not be spawned or timed out. */
	exitCode: number;
	/** Truncated tail of combined output. */
	summary: string;
	/**
	 * Whether a passing command failed at the quest baseline commit. `false`
	 * means it was already green, so it proves nothing about the quest's change.
	 * Absent when unknown (no baseline, or the command failed).
	 */
	redAtBaseline?: boolean;
	/** Epoch ms the command finished. */
	at: number;
}

/** Quest-level acceptance: what must be observably true before the quest is done. */
export interface QuestAcceptance {
	/** Human-readable criteria, shown in the recap. */
	criteria: string[];
	/** Deterministic proof, run by the harness without a shell. May be empty. */
	commands: string[];
	/** "pending" until the gate first runs; "passing" once every command passed. */
	status: "pending" | "passing" | "failed";
	/** Corrective steps appended so far. */
	rounds: number;
	/** Results of the most recent gate run. */
	evidence: AcceptanceEvidence[];
}

/** Raw acceptance input as the model supplies it. */
export interface AcceptanceInput {
	criteria?: string[];
	commands?: string[];
}

export type ParsedCommand = { file: string; args: string[] } | { error: string };

/** Characters that mean a shell feature we refuse to emulate. */
const SHELL_META = /[|&;<>`\n\r]|\$\(/;

/**
 * Split a command into an argv without a shell. Supports '…' and "…" quoting
 * and backslash escapes inside double quotes; rejects pipes, redirects,
 * chaining, substitution, and newlines outside quotes, plus leading VAR=value
 * assignments (those need a shell too).
 */
export function parseCommand(command: string): ParsedCommand {
	const args: string[] = [];
	let current = "";
	let inToken = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) {
				current += command[++i];
			} else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
				return {
					error: `"${command}" uses command substitution; acceptance runs without a shell.`,
				};
			} else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inToken = true;
			continue;
		}
		if (SHELL_META.test(ch) || (ch === "$" && command[i + 1] === "(")) {
			return {
				error: `"${command}" uses shell syntax (${JSON.stringify(ch)}); acceptance runs without a shell — use one plain command per entry.`,
			};
		}
		if (/\s/.test(ch)) {
			if (inToken) args.push(current);
			current = "";
			inToken = false;
			continue;
		}
		current += ch;
		inToken = true;
	}
	if (quote) return { error: `"${command}" has an unterminated ${quote} quote.` };
	if (inToken) args.push(current);
	if (args.length === 0) return { error: "Empty acceptance command." };
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
		return {
			error: `"${command}" starts with an environment assignment; acceptance runs without a shell.`,
		};
	}
	return { file: args[0], args: args.slice(1) };
}

/**
 * Why the quest's sandbox would block `command`, or null. A command the model
 * couldn't run through its own bash tool must not run via the gate either.
 */
export function sandboxBlockReason(
	command: string,
	policy: SandboxPolicy | undefined,
): string | null {
	if (!policy) return null;
	const decision = evaluateToolCall(resolveSandboxProfile(policy), "bash", { command });
	return decision.block ? (decision.reason ?? `Sandbox blocks "${command}".`) : null;
}

/** What declaration-time validation checks commands against. */
export interface AcceptanceContext {
	/** The quest's sandbox policy, when sandboxed. */
	sandbox?: SandboxPolicy;
	/**
	 * Commands the step check gate already runs after every step (checks.ts
	 * `planChecks`). Repeating one as acceptance adds nothing and drops the
	 * gate's baseline exemption, so a repo-wide check that already fails for
	 * unrelated reasons would send the quest off fixing unrelated code.
	 */
	gatedCommands?: readonly string[];
	/** The project's package.json scripts, to see what a `<pm> run X` command really runs. */
	scripts?: Readonly<Record<string, string>>;
}

const RUN_SCRIPT_PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** npm's own aliases for `npm run test` (other package managers accept any bare script). */
const NPM_TEST_ALIASES = new Set(["test", "t", "tst"]);

/**
 * Canonical argv of a command for comparing against gated checks, with
 * package-manager script shorthands expanded so `npm test`, `npm run test` and
 * `yarn test` all read `<pm> run test …`. Null when it isn't a plain command.
 */
function canonicalArgv(command: string): string[] | null {
	const parsed = parseCommand(command);
	if ("error" in parsed) return null;
	const argv = [parsed.file, ...parsed.args];
	if (RUN_SCRIPT_PMS.has(argv[0]) && argv.length >= 2 && argv[1] !== "run") {
		const bare = parsed.file !== "npm" || NPM_TEST_ALIASES.has(argv[1]);
		if (bare) argv.splice(1, 1, "run", parsed.file === "npm" ? "test" : argv[1]);
	}
	return argv;
}

/** `<pm> run <script> [--] [args…]` → the script and its extra args, else null. */
function scriptRun(argv: readonly string[] | null): { script: string; extra: string[] } | null {
	if (!argv || !RUN_SCRIPT_PMS.has(argv[0]) || argv[1] !== "run" || !argv[2]) return null;
	const rest = argv.slice(3);
	return { script: argv[2], extra: rest[0] === "--" ? rest.slice(1) : rest };
}

/** Commands of a script body: package scripts chain with `&&`, `||` and `;`. */
function bodySegments(body: string): string[] {
	return body
		.split(/&&|\|\||;/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/**
 * Scripts the step gate runs: the gated `<pm> run X` checks plus every script
 * their bodies run in turn (`"test": "npm run test:node && npm run test:subagent"`
 * gates test:node and test:subagent too).
 */
function gatedScripts(
	gated: readonly string[],
	scripts: Readonly<Record<string, string>>,
): Map<string, string> {
	const reached = new Map<string, string>(); // script → the gated check that runs it
	const queue: [string, string][] = [];
	for (const check of gated) {
		const run = scriptRun(canonicalArgv(check));
		if (run) queue.push([run.script, check]);
	}
	while (queue.length > 0) {
		const [script, check] = queue.shift()!;
		if (reached.has(script)) continue;
		reached.set(script, check);
		for (const segment of bodySegments(scripts[script] ?? "")) {
			const run = scriptRun(canonicalArgv(segment));
			if (run) queue.push([run.script, check]);
		}
	}
	return reached;
}

/** A positional that selects tests: a glob or a test/spec file. */
const TEST_TARGET = /\*|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether running `body` with `extra` appended still runs everything the script
 * runs. Extra args can only narrow a single command that doesn't already name
 * its own test targets: `"test": "vitest run"` + `-- a.test.ts` narrows, but a
 * chained script, or one with hard-coded globs (`--test core/*.test.ts`), just
 * gets more files.
 */
function runsWholeScript(body: string, extra: readonly string[]): boolean {
	if (extra.length === 0) return true;
	const segments = bodySegments(body);
	if (segments.length !== 1) return true;
	const argv = canonicalArgv(segments[0]);
	if (!argv) return true;
	return argv.slice(1).some((arg) => !arg.startsWith("-") && TEST_TARGET.test(arg));
}

/**
 * The gated check `command` repeats, or null. Catches exact repeats in any
 * shorthand, and — given the project's package.json `scripts` — script runs that
 * still execute a gated check's whole suite despite extra arguments.
 */
export function gatedDuplicate(
	command: string,
	gated: readonly string[] | undefined,
	scripts: Readonly<Record<string, string>> = {},
): string | null {
	const argv = canonicalArgv(command);
	if (!argv || !gated?.length) return null;
	const canonical = argv.join(" ");
	const exact = gated.find((g) => canonicalArgv(g)?.join(" ") === canonical);
	if (exact) return exact;
	const run = scriptRun(argv);
	if (!run) return null;
	const check = gatedScripts(gated, scripts).get(run.script);
	if (!check) return null;
	const body = scripts[run.script];
	// Unknown body: extra arguments might narrow it, so give them the benefit of the doubt.
	if (body === undefined) return run.extra.length === 0 ? check : null;
	return runsWholeScript(body, run.extra) ? check : null;
}

function cleanList(values: readonly string[] | undefined): string[] {
	return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

/**
 * Validate and build a quest's acceptance from quest_create input. Returns
 * `undefined` when nothing was declared and the tier doesn't require it, or an
 * error the tool reports back so the model can fix its call.
 */
export function createAcceptance(
	input: AcceptanceInput | undefined,
	tier: "simple" | "medium" | "complex",
	context: AcceptanceContext = {},
	cfg: AcceptanceConfig = ACCEPTANCE,
): { acceptance?: QuestAcceptance } | { error: string } {
	const criteria = cleanList(input?.criteria);
	const commands = cleanList(input?.commands);
	if (criteria.length === 0 && commands.length === 0) {
		if (cfg.enabled && cfg.requiredForTiers.includes(tier)) {
			return {
				error: `A ${tier} quest needs acceptance: what must be observably true when it is done (acceptance.criteria), and ideally commands that prove it (acceptance.commands, e.g. a test file run).`,
			};
		}
		return {};
	}
	if (criteria.length === 0) {
		return { error: "acceptance.commands need acceptance.criteria describing what they prove." };
	}
	const bad = validateCommands(commands, [], context, cfg);
	if (bad) return { error: bad };
	return { acceptance: { criteria, commands, status: "pending", rounds: 0, evidence: [] } };
}

/** First problem with a command list, or null. `existing` counts toward the cap. */
function validateCommands(
	commands: readonly string[],
	existing: readonly string[],
	context: AcceptanceContext,
	cfg: AcceptanceConfig,
): string | null {
	const total = new Set([...existing, ...commands]).size;
	if (total > cfg.maxCommands) {
		return `At most ${cfg.maxCommands} acceptance commands (got ${total}); keep the few that prove the goal.`;
	}
	for (const command of commands) {
		const parsed = parseCommand(command);
		if ("error" in parsed) return parsed.error;
		const gated = gatedDuplicate(command, context.gatedCommands, context.scripts);
		if (gated) {
			return `Acceptance command "${command}" repeats \`${gated}\` (the whole suite), which quest already runs after every step. Use a targeted command that proves this goal, e.g. the test runner on the test file for this change.`;
		}
		const blocked = sandboxBlockReason(command, context.sandbox);
		if (blocked)
			return `Acceptance command "${command}" is blocked by the quest sandbox: ${blocked}`;
	}
	return null;
}

/**
 * Append commands to an existing acceptance (quest_plan). Append-only: the
 * definition of done can grow as planning learns more, never shrink. Adding a
 * command reopens a passing acceptance.
 */
export function addAcceptanceCommands(
	acceptance: QuestAcceptance,
	commands: readonly string[] | undefined,
	context: AcceptanceContext = {},
	cfg: AcceptanceConfig = ACCEPTANCE,
): { acceptance: QuestAcceptance; added: string[] } | { error: string } {
	const added = cleanList(commands).filter((c) => !acceptance.commands.includes(c));
	if (added.length === 0) return { acceptance, added };
	const bad = validateCommands(added, acceptance.commands, context, cfg);
	if (bad) return { error: bad };
	return {
		acceptance: { ...acceptance, commands: [...acceptance.commands, ...added], status: "pending" },
		added,
	};
}

/** Whether the quest must pass the acceptance gate before it may complete. */
export function acceptancePending(
	quest: { acceptance?: QuestAcceptance },
	cfg: AcceptanceConfig = ACCEPTANCE,
): boolean {
	return cfg.enabled && !!quest.acceptance && quest.acceptance.status !== "passing";
}

export type AcceptanceDecision =
	| { kind: "pass" }
	| { kind: "corrective"; failures: AcceptanceEvidence[]; round: number }
	| { kind: "pause"; failures: AcceptanceEvidence[]; reason: string };

/**
 * What to do after a gate run. All pass (or no commands to run) → pass. A
 * failure with rounds left → one corrective step; out of rounds → pause, so a
 * broken or impossible criterion reaches the user instead of looping.
 */
export function decideAcceptance(
	evidence: readonly AcceptanceEvidence[],
	roundsUsed: number,
	cfg: AcceptanceConfig = ACCEPTANCE,
): AcceptanceDecision {
	const failures = evidence.filter((e) => e.status === "fail");
	if (failures.length === 0) return { kind: "pass" };
	if (roundsUsed >= cfg.maxCorrectiveRounds) {
		return {
			kind: "pause",
			failures,
			reason: `Acceptance still failing after ${roundsUsed} corrective round(s): ${failures.map((f) => f.command).join(", ")}. Fix it, then /quest resume.`,
		};
	}
	return { kind: "corrective", failures, round: roundsUsed + 1 };
}

/** The step appended for a failing acceptance run. */
export interface CorrectiveStepSpec {
	content: string;
	context: string;
	agent: string;
}

/**
 * Build one focused corrective step from the failing commands — the failure
 * output is the brief, so the fix targets the gap instead of replaying the quest.
 */
export function buildCorrectiveStep(
	failures: readonly AcceptanceEvidence[],
	round: number,
	criteria: readonly string[],
): CorrectiveStepSpec {
	const lines = [
		`All planned steps passed, but the quest's acceptance check failed (round ${round}).`,
		`Make these commands pass without weakening them or the tests they run:`,
	];
	for (const f of failures) {
		lines.push(``, `$ ${f.command}  (exit ${f.exitCode})`);
		if (f.summary.trim()) lines.push("```", f.summary.trim(), "```");
	}
	lines.push(``, `Acceptance criteria:`, ...criteria.map((c) => `- ${c}`));
	return {
		content: `Fix acceptance: ${failures.map((f) => f.command).join(", ")}`,
		context: lines.join("\n"),
		agent: "worker",
	};
}

const VERDICT_LABELS: Record<QuestAcceptance["status"], string> = {
	passing: "✅ passing",
	failed: "❌ failed",
	pending: "pending",
};

/** One command's recap result: its outcome plus what the baseline says it proves. */
function evidenceLabel(evidence: AcceptanceEvidence | undefined): string {
	if (!evidence) return "not run";
	if (evidence.status === "fail") return `FAIL (exit ${evidence.exitCode})`;
	if (evidence.redAtBaseline === true) return "pass (red at baseline → green)";
	if (evidence.redAtBaseline === false) {
		return "pass (already green at baseline — doesn't prove the change)";
	}
	return "pass";
}

/** Recap section for a quest's acceptance. Empty when the quest declared none. */
export function renderAcceptanceRecap(acceptance: QuestAcceptance | undefined): string[] {
	if (!acceptance) return [];
	const lines = [``, `### Acceptance`];
	for (const c of acceptance.criteria) lines.push(`- ${c}`);
	if (acceptance.commands.length === 0) {
		lines.push(``, `⚠ No acceptance commands — criteria were not machine-verified.`);
		return lines;
	}
	lines.push(``, `**Evidence:**`);
	for (const command of acceptance.commands) {
		const evidence = acceptance.evidence.find((e) => e.command === command);
		lines.push(`- \`${command}\` — ${evidenceLabel(evidence)}`);
	}
	lines.push(
		``,
		`**Result:** ${VERDICT_LABELS[acceptance.status]}` +
			(acceptance.rounds ? ` after ${acceptance.rounds} corrective round(s)` : ""),
	);
	return lines;
}

/** Disk-read boundary: a quest file's `acceptance`, or undefined when absent/garbled. */
export function coerceAcceptance(value: unknown): QuestAcceptance | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = asRecord(value);
	const criteria = strArray(rec.criteria);
	if (criteria.length === 0) return undefined;
	const evidence = Array.isArray(rec.evidence)
		? rec.evidence.flatMap((raw): AcceptanceEvidence[] => {
				const e = asRecord(raw);
				if (typeof e.command !== "string" || !oneOf(e.status, ["pass", "fail"] as const)) return [];
				return [
					{
						command: e.command,
						status: e.status,
						exitCode: numOr(e.exitCode, -1),
						summary: strOr(e.summary, ""),
						redAtBaseline: typeof e.redAtBaseline === "boolean" ? e.redAtBaseline : undefined,
						at: optNum(e.at) ?? 0,
					},
				];
			})
		: [];
	return {
		criteria,
		commands: strArray(rec.commands),
		status: oneOf(rec.status, ["pending", "passing", "failed"] as const) ? rec.status : "pending",
		rounds: Math.max(0, numOr(rec.rounds, 0)),
		evidence,
	};
}
