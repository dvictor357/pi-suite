import { join } from "node:path";
import {
	AGENT_DIR,
	MAX_BURST,
	MAX_RETRIES,
	MAX_VERIFY_RETRIES,
	MAX_DEPENDENCY_DEPTH,
	verbosityForModel,
	type BudgetModelInfo,
} from "../../core";
import type { StepStatus, TeamConfig } from "./types";
import { DEFAULT_LADDER_ROLES, type LadderConfig } from "./ladder";

export { MAX_BURST, MAX_RETRIES, MAX_VERIFY_RETRIES, MAX_DEPENDENCY_DEPTH };
export { MAX_ESCALATIONS } from "../../core";

// ── Model escalation ladder ──────────────────────────────────────────────────
/**
 * Tunable knobs for the verified escalation ladder (see ladder.ts). No default
 * rung list ships here — a hardcoded model catalog would rot; the ladder stays
 * inert until the user approves one per project via `quest_assign_ladder`.
 */
export const LADDER: LadderConfig = {
	roles: [...DEFAULT_LADDER_ROLES],
	// A rung needs this many recorded outcomes for a role before its pass rate
	// can disqualify it as a starting point.
	minSamples: 5,
	// Verified-pass rate below which a proven rung is skipped at start.
	passRateFloor: 0.55,
	// Character budget for the rendered failure-brief block, scaled per model
	// at the injection site via budgetForModel.
	briefBudget: 700,
	maxBriefs: 3,
};

/**
 * Language-agnostic code-hygiene directive injected into steering and verification.
 * It deliberately names no specific tool or language — the agent must detect and
 * use whatever formatter/linter the project itself already relies on.
 */
export const FORMAT_DIRECTIVE = [
	"**Before marking a code step done:** apply this project's own formatting and lint conventions.",
	"Detect the tooling the codebase already uses — a format/lint script in its manifest, a config file",
	"(e.g. .editorconfig or a formatter/linter config), or the standard tool for its language/ecosystem —",
	"then run it and confirm the working tree is clean and consistent. Do NOT assume a specific language",
	"or tool, and do NOT impose a style the project doesn't already use; adapt to this codebase.",
].join(" ");

/**
 * Compact variant of {@link FORMAT_DIRECTIVE} for constrained (small / low-context)
 * models, where the full five-sentence version crowds out the actual task. Same
 * intent — run the project's own tooling, match its existing style — in one line.
 */
export const FORMAT_DIRECTIVE_COMPACT =
	"**Before done:** run the project's own formatter/linter and confirm the tree is clean; match the existing style, don't impose a new one.";

/**
 * Pick the format directive appropriate to a model: constrained models get the
 * compact one-liner, larger models get the full explanatory directive.
 */
export function formatDirectiveFor(model?: BudgetModelInfo): string {
	return verbosityForModel(model) === "compact" ? FORMAT_DIRECTIVE_COMPACT : FORMAT_DIRECTIVE;
}

// ── Deterministic verification gate ──────────────────────────────────────────
/**
 * Tunable knobs for the deterministic verification gate (see `checks.ts` and the
 * `quest_update` gate). These checks run in the project's own cwd after a worker
 * reports a step done; a failing check hard-fails the step before any LLM
 * verifier is spawned. Surfaced here so timeouts and ordering are configured in
 * one place rather than as magic numbers inside the runner.
 */
export interface VerificationConfig {
	/** Master switch. When false, the gate is skipped and behaviour matches pre-gate. */
	enabled: boolean;
	/** Per-check wall-clock timeout in ms (a hung check counts as a failure). */
	timeoutMs: number;
	/** Max characters of a check's captured output tail kept in its summary. */
	outputTailChars: number;
	/**
	 * Order checks run in. Cheapest/most-decisive first so the gate can stop at the
	 * first failure without spending time on slower checks.
	 */
	checkOrder: readonly ("typecheck" | "lint" | "test" | "format")[];
}

export const VERIFICATION: VerificationConfig = {
	enabled: true,
	// Generous enough for a real test suite, bounded so a hang can't stall the loop.
	timeoutMs: 180_000,
	outputTailChars: 1200,
	// Fast type/lint/format signals before the (usually slower) test run.
	checkOrder: ["typecheck", "lint", "format", "test"],
};

// ── Codebase retrieval ranking ───────────────────────────────────────────────
/**
 * Tunable knobs for the BM25-based codebase retrieval ranker (see
 * `codebase.ts`). Surfaced here so ranking behaviour is configured in one place
 * rather than scattered as magic numbers inside the scorer. Callers may pass a
 * custom `CodebaseRankingConfig` to override any of these per query.
 */
export interface CodebaseFieldBoosts {
	/** Term weight for tokens found in a file's declared symbols. */
	symbol: number;
	/** Term weight for tokens found in a file's exported names. */
	export: number;
	/** Term weight for tokens found in the file's base name. */
	name: number;
	/** Term weight for tokens found in the file's path segments. */
	path: number;
	/** Term weight for tokens from import sources. 0 = ignore imports for lexical matching. */
	import: number;
}

export interface CodebaseGraphExpansionConfig {
	/** When true, fold dependency-graph neighbours of top hits into results. */
	enabled: boolean;
	/** Score multiplier applied to a neighbour pulled in via the graph (0–1). */
	decay: number;
	/** Max neighbours to fold in per seed hit. */
	perSeed: number;
}

export interface CodebaseRankingConfig {
	/** BM25 term-frequency saturation. Higher = tf matters more before saturating. */
	k1: number;
	/** BM25 length normalisation (0 = none, 1 = full). */
	b: number;
	/** Per-field term-frequency boosts. */
	boosts: CodebaseFieldBoosts;
	/** Flat bonus added when a raw query identifier exactly equals a symbol/export/base name. */
	exactMatchBonus: number;
	/** Dependency-graph expansion of the top lexical hits. */
	graphExpansion: CodebaseGraphExpansionConfig;
}

/**
 * Default codebase ranking configuration. Callers may override per query.
 *
 * Values tuned by grid search against pi-suite's own 45-file index (see the
 * evaluation notes in docs/architecture.md): full length-normalisation (`b=1`)
 * plus higher tf saturation (`k1=1.6`) roughly doubled recall@1 (0.30 → 0.60,
 * MRR 0.57 → 0.73) versus the untuned starting point, by stopping large files
 * from dominating on raw token count and letting idf discriminate. `symbol`/
 * `export`/`exact` were pulled down because strong boosts over-rewarded broad
 * matches; the ranking plateau was insensitive to `name`/`path` once `b=1`.
 */
export const CODEBASE_RANKING: CodebaseRankingConfig = {
	k1: 1.6,
	b: 1.0,
	boosts: { symbol: 2, export: 2, name: 2.5, path: 1.5, import: 0 },
	exactMatchBonus: 3,
	graphExpansion: { enabled: true, decay: 0.35, perSeed: 3 },
};

export { AGENT_DIR };
export const TEAMS_DIR = join(AGENT_DIR, "quests", "teams");

export const ICON: Record<StepStatus, string> = {
	pending: "☐",
	running: "▶",
	verifying: "🔍",
	done: "☑",
	failed: "✗",
	skipped: "⏭",
};

export const BUILT_IN_TEAMS: Record<string, TeamConfig> = {
	engineering: {
		name: "engineering",
		description: "Balanced team for feature development with code review and testing",
		lead: "worker",
		members: [
			{ role: "developer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
			{ role: "tester", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	research: {
		name: "research",
		description: "Exploration-first team with scout, planner, and worker support",
		lead: "scout",
		members: [
			{ role: "explorer", agent: "scout" },
			{ role: "planner", agent: "planner" },
			{ role: "implementer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
		],
		defaultAgent: "scout",
		verification: true,
	},
	content: {
		name: "content",
		description: "Content creation team with writer, editor, and reviewer roles",
		lead: "worker",
		members: [
			{ role: "writer", agent: "worker" },
			{ role: "editor", agent: "reviewer" },
			{ role: "fact-checker", agent: "scout" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	devops: {
		name: "devops",
		description: "Infrastructure and deployment team with CI/CD, cloud, and security roles",
		lead: "worker",
		members: [
			{ role: "infra", agent: "worker" },
			{ role: "security", agent: "reviewer" },
			{ role: "monitoring", agent: "scout" },
			{ role: "release", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	"loop-engineering": {
		name: "loop-engineering",
		description:
			"Five-role loop: architect (planner), research (scout), product + builder (worker), evaluator (verifier/reviewer)",
		lead: "worker",
		members: [
			{ role: "architect", agent: "planner" },
			{ role: "research", agent: "scout" },
			{ role: "product", agent: "worker" },
			{ role: "builder", agent: "worker" },
			{ role: "evaluator", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
};
