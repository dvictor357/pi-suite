import { join } from "node:path";
import {
	AGENT_DIR,
	MAX_BURST,
	MAX_RETRIES,
	MAX_VERIFY_RETRIES,
	MAX_DEPENDENCY_DEPTH,
} from "../../core";
import type { StepStatus, TeamConfig } from "./types";

export { MAX_BURST, MAX_RETRIES, MAX_VERIFY_RETRIES, MAX_DEPENDENCY_DEPTH };

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

export interface CodebaseSemanticConfig {
	/** When true, expand the query with terms that co-occur with query terms in the corpus. */
	enabled: boolean;
	/** Weight applied to each expansion term's BM25 contribution (< 1 = softer than a real hit). */
	expansionWeight: number;
	/** Max expansion terms contributed per original query term. */
	perTermExpansions: number;
	/** Overall cap on expansion terms across the whole query. */
	maxExpansions: number;
	/** A co-occurring term must appear in at least this many files to be considered (drops noise). */
	minCoTermDf: number;
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
	/** Corpus co-occurrence query expansion (a dependency-free, offline semantic layer). */
	semantic: CodebaseSemanticConfig;
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
	// Corpus co-occurrence query expansion. Kept as a tunable seam but DEFAULT OFF:
	// measured against pi-suite's own index it *regressed* recall@1 (0.60 → 0.35),
	// because quest's cache is identifier-only (symbol/export/path names, no file
	// content) so co-occurrence is dominated by generic utility tokens rather than
	// real synonymy. Closing the lexical-vocabulary gap needs content-based
	// embeddings (a model), not corpus co-occurrence — see docs/architecture.md.
	semantic: {
		enabled: false,
		expansionWeight: 0.3,
		perTermExpansions: 3,
		maxExpansions: 6,
		minCoTermDf: 2,
	},
};

export { AGENT_DIR };
export const ACTIVE_PATH = join(AGENT_DIR, "quests", "active.json");
export const ARCHIVE_DIR = join(AGENT_DIR, "quests", "archive");
export const ARCHIVE_INDEX_PATH = join(ARCHIVE_DIR, "archive-index.json");
export const TEAMS_DIR = join(AGENT_DIR, "quests", "teams");
export const ERROR_LOG_PATH = join(AGENT_DIR, "quests", "error.log");

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
};
