import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { QuestStep } from "./types";
import {
	CODEBASE_RANKING,
	type CodebaseFieldBoosts,
	type CodebaseRankingConfig,
} from "./constants";

export const CODEBASE_CACHE_PATH = ".pi/codebase-index.json";

/**
 * The `.pi/codebase-index.json` cache is OWNED by `pi-minions`, not pi-suite.
 * pi-quest only reads it (a stable integration contract; see docs/architecture.md
 * "Codebase intelligence ownership split"). This is the cache shape this code
 * understands: a cache stamped with a higher `contractVersion` is treated as
 * absent (`loadCodebaseIndex` → status "future") rather than reinterpreted, so a
 * future pi-minions format can never corrupt quest orchestration decisions.
 */
export const SUPPORTED_CODEBASE_CONTRACT_VERSION = 1;

export interface CodebaseImportEntry {
	source?: string;
	names?: string[];
	isDefault?: boolean;
	isType?: boolean;
	resolved?: string;
}

export interface CodebaseExportEntry {
	name?: string;
	kind?: string;
}

export interface CodebaseSymbolEntry {
	name?: string;
	kind?: string;
}

export interface CodebaseFileEntry {
	path?: string;
	name?: string;
	relativePath: string;
	imports?: CodebaseImportEntry[];
	exports?: CodebaseExportEntry[];
	symbols?: CodebaseSymbolEntry[];
	mtime?: number;
	hash?: string;
}

export interface CodebaseIndexV1 {
	contractVersion: 1;
	rootDir: string;
	scannedAt: number;
	fileCount: number;
	files: Record<string, CodebaseFileEntry>;
	dependencies: Record<string, string[]>;
	reverseDependencies: Record<string, string[]>;
}

export type CodebaseLoadResult =
	| { status: "ok"; path: string; index: CodebaseIndexV1 }
	| { status: "missing"; path: string }
	| { status: "future"; path: string; contractVersion: number }
	| { status: "unsupported"; path: string; contractVersion: unknown }
	| { status: "invalid"; path: string; error: string };

export interface CodebaseQueryResult {
	relativePath: string;
	name: string;
	symbols: string[];
	exports: string[];
}

export interface CodebaseMapResult extends CodebaseQueryResult {
	imports: string[];
	dependencies: string[];
	reverseDependencies: string[];
}

export interface PlanningEnrichmentResult {
	cache: CodebaseLoadResult;
	enrichedTasks: QuestStep[];
	summary: string;
}

const COMMON_WORDS = new Set([
	"with",
	"from",
	"this",
	"that",
	"into",
	"task",
	"code",
	"file",
	"files",
	"test",
	"tests",
	"update",
	"implement",
	"create",
	"add",
	"use",
	"using",
	"when",
	"then",
	"should",
	"must",
	"context",
]);

export function codebaseCachePath(cwd: string): string {
	return join(cwd, CODEBASE_CACHE_PATH);
}

export function hasCodebaseCache(cwd: string): boolean {
	return existsSync(codebaseCachePath(cwd));
}

export function hasCodebaseTool(tools: readonly { name?: string }[] | readonly string[]): boolean {
	return tools.some((tool) => (typeof tool === "string" ? tool : tool.name) === "codebase");
}

export function loadCodebaseIndex(cwd: string): CodebaseLoadResult {
	const path = codebaseCachePath(cwd);
	if (!existsSync(path)) return { status: "missing", path };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") {
			return { status: "invalid", path, error: "cache is not a JSON object" };
		}
		const blob = parsed as Record<string, unknown>;
		const contractVersion = blob.contractVersion;
		if (contractVersion !== SUPPORTED_CODEBASE_CONTRACT_VERSION) {
			if (
				typeof contractVersion === "number" &&
				contractVersion > SUPPORTED_CODEBASE_CONTRACT_VERSION
			) {
				return { status: "future", path, contractVersion };
			}
			return { status: "unsupported", path, contractVersion };
		}
		if (!blob.files || typeof blob.files !== "object") {
			return { status: "invalid", path, error: "cache is missing files" };
		}
		return { status: "ok", path, index: blob as unknown as CodebaseIndexV1 };
	} catch (error) {
		return {
			status: "invalid",
			path,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function fileToQueryResult(file: CodebaseFileEntry): CodebaseQueryResult {
	return {
		relativePath: file.relativePath,
		name: file.name || file.relativePath.split("/").pop() || file.relativePath,
		symbols: (file.symbols || []).map((s) => s.name).filter((s): s is string => Boolean(s)),
		exports: (file.exports || []).map((e) => e.name).filter((e): e is string => Boolean(e)),
	};
}

// ── Retrieval ranking (BM25 over a field-weighted token bag) ──────────────────
//
// The old ranker scored files by raw `includes()` substring hits with hand-tuned
// integer weights. That conflated unrelated tokens ("app" matched "mapper"),
// ignored corpus statistics (a term in every file counted as much as a rare,
// discriminating one), and couldn't combine evidence across query terms. This
// replaces it with token-boundary BM25 over a per-file weighted term bag built
// from the same read-only cache fields, plus an exact-identifier bonus and
// optional dependency-graph expansion. Tuning lives in CODEBASE_RANKING.

interface FileDoc {
	file: CodebaseFileEntry;
	/** Field-weighted term frequency for this file. */
	tf: Map<string, number>;
	/** Weighted document length (sum of tf values). */
	length: number;
	/** Lowercased untokenized symbol/export/base names, for the exact-match bonus. */
	exactNames: Set<string>;
}

export interface Corpus {
	docs: FileDoc[];
	/** Document frequency per term (docs whose weighted tf > 0). */
	df: Map<string, number>;
	/** Number of files in the corpus. */
	N: number;
	/** Average weighted document length. */
	avgdl: number;
}

/**
 * Split text into normalized lexical tokens: break on camelCase, snake_case,
 * kebab, and any non-alphanumeric boundary, lowercase, drop tokens shorter than
 * two chars and common filler words. Symmetric across query and document sides
 * so corpus statistics stay consistent.
 */
function tokenizeText(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.map((t) => t.toLowerCase())
		.filter((t) => t.length >= 2 && !COMMON_WORDS.has(t));
}

/**
 * Raw (un-split) query identifiers for the exact-match bonus: whole words and
 * file base names as the author wrote them, so a task naming `fooFn` or
 * `foo.ts` can reward a file that declares exactly that identifier.
 */
function rawQueryTerms(text: string): string[] {
	const words =
		text
			.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g)
			?.map((w) => w.toLowerCase())
			.filter((w) => !COMMON_WORDS.has(w)) ?? [];
	const bases = extractFilePaths(text).map((p) =>
		(p.split("/").pop() || p).replace(/\.[cm]?[jt]sx?$/, "").toLowerCase(),
	);
	return [...new Set([...words, ...bases])];
}

/** The field → raw strings a file contributes, before tokenization. */
function fileFieldStrings(file: CodebaseFileEntry): Record<keyof CodebaseFieldBoosts, string[]> {
	return {
		path: [file.relativePath],
		name: [file.name || file.relativePath.split("/").pop() || ""],
		symbol: (file.symbols || []).map((s) => s.name || ""),
		export: (file.exports || []).map((e) => e.name || ""),
		import: (file.imports || []).map((i) => i.source || ""),
	};
}

function exactNamesFor(file: CodebaseFileEntry): Set<string> {
	const set = new Set<string>();
	for (const s of file.symbols || []) if (s.name) set.add(s.name.toLowerCase());
	for (const e of file.exports || []) if (e.name) set.add(e.name.toLowerCase());
	const base = (file.name || file.relativePath.split("/").pop() || "")
		.replace(/\.[^.]+$/, "")
		.toLowerCase();
	if (base) set.add(base);
	return set;
}

function buildCorpus(index: CodebaseIndexV1, config: CodebaseRankingConfig): Corpus {
	const docs: FileDoc[] = [];
	const df = new Map<string, number>();

	for (const file of Object.values(index.files)) {
		const tf = new Map<string, number>();
		const fields = fileFieldStrings(file);
		for (const field of Object.keys(fields) as (keyof CodebaseFieldBoosts)[]) {
			const boost = config.boosts[field];
			if (boost <= 0) continue; // a zero/negative boost removes the field from lexical matching
			for (const raw of fields[field]) {
				for (const tok of tokenizeText(raw)) tf.set(tok, (tf.get(tok) ?? 0) + boost);
			}
		}
		let length = 0;
		for (const v of tf.values()) length += v;
		for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
		docs.push({ file, tf, length, exactNames: exactNamesFor(file) });
	}

	const N = docs.length;
	const avgdl = N ? docs.reduce((sum, d) => sum + d.length, 0) / N : 0;
	return { docs, df, N, avgdl };
}

// Memoize the corpus per index object so a whole planning pass (many steps)
// builds it once. Keyed on the config too, since custom boosts change the bag.
const corpusCache = new WeakMap<
	CodebaseIndexV1,
	{ config: CodebaseRankingConfig; corpus: Corpus }
>();

/**
 * Return the (memoized) BM25 corpus for an index. Exposed so callers/tests can
 * observe that repeated queries reuse one corpus rather than rebuilding it.
 */
export function corpusFor(
	index: CodebaseIndexV1,
	config: CodebaseRankingConfig = CODEBASE_RANKING,
): Corpus {
	const cached = corpusCache.get(index);
	if (cached && cached.config === config) return cached.corpus;
	const corpus = buildCorpus(index, config);
	corpusCache.set(index, { config, corpus });
	return corpus;
}

/** Score every file against a set of query terms, each carrying a weight. */
function scoreFilesWeighted(
	corpus: Corpus,
	weightedTerms: Map<string, number>,
	rawTerms: Set<string>,
	config: CodebaseRankingConfig,
): { file: CodebaseFileEntry; score: number }[] {
	const { df, N, avgdl } = corpus;
	return corpus.docs
		.map((doc) => {
			let score = 0;
			for (const [term, weight] of weightedTerms) {
				const f = doc.tf.get(term);
				if (!f) continue;
				const n = df.get(term) ?? 0;
				const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
				const denom = f + config.k1 * (1 - config.b + config.b * (avgdl ? doc.length / avgdl : 0));
				score += weight * ((idf * (f * (config.k1 + 1))) / (denom || 1));
			}
			for (const rt of rawTerms) {
				if (doc.exactNames.has(rt)) score += config.exactMatchBonus;
			}
			return { file: doc.file, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));
}

/** Score files against free text using lexical BM25 evidence. */
function scoreFiles(
	index: CodebaseIndexV1,
	text: string,
	config: CodebaseRankingConfig,
): { file: CodebaseFileEntry; score: number }[] {
	const corpus = corpusFor(index, config);
	if (!corpus.N) return [];

	const queryTerms = [...new Set(tokenizeText(text))];
	const weighted = new Map<string, number>(queryTerms.map((t) => [t, 1]));
	return scoreFilesWeighted(corpus, weighted, new Set(rawQueryTerms(text)), config);
}

/**
 * Rank files by lexical relevance to a single pattern. Backward-compatible entry
 * point (same signature/return as before); pure lexical scoring, no graph
 * expansion — it answers "which files match this text".
 */
export function queryCodebaseIndex(
	index: CodebaseIndexV1,
	pattern: string,
	limit = 8,
	config: CodebaseRankingConfig = CODEBASE_RANKING,
): CodebaseQueryResult[] {
	if (!pattern.trim()) return [];
	return scoreFiles(index, pattern, config)
		.slice(0, limit)
		.map((entry) => fileToQueryResult(entry.file));
}

/**
 * Rank files for a full free-text query (a whole task's content/context/goal),
 * scoring combined term evidence at once, then — when enabled — folding in the
 * dependency-graph neighbours of the top hits at a decayed score. This is the
 * richer entry point used by planning enrichment; neighbours surface files a
 * change is likely to touch even when the task text doesn't name them.
 */
export function rankFilesForQuery(
	index: CodebaseIndexV1,
	text: string,
	limit = 8,
	config: CodebaseRankingConfig = CODEBASE_RANKING,
): CodebaseQueryResult[] {
	const scored = scoreFiles(index, text, config);
	if (!scored.length) return [];

	const results = scored.map((e) => ({ file: e.file, path: e.file.relativePath, score: e.score }));

	if (config.graphExpansion.enabled) {
		const seen = new Set(results.map((r) => r.path));
		const seeds = scored.slice(0, limit);
		for (const seed of seeds) {
			const rel = seed.file.relativePath;
			const neighbors = [
				...(index.dependencies[rel] || []),
				...(index.reverseDependencies[rel] || []),
			].slice(0, config.graphExpansion.perSeed);
			for (const nb of neighbors) {
				if (seen.has(nb)) continue;
				const nbFile = index.files[nb];
				if (!nbFile) continue;
				seen.add(nb);
				results.push({ file: nbFile, path: nb, score: seed.score * config.graphExpansion.decay });
			}
		}
		results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	}

	return results.slice(0, limit).map((r) => fileToQueryResult(r.file));
}

export function mapCodebaseFile(index: CodebaseIndexV1, file: string): CodebaseMapResult | null {
	const relativePath = normalizeRelativePath(file);
	const entry = index.files[relativePath];
	if (!entry) return null;
	return {
		...fileToQueryResult(entry),
		imports: (entry.imports || []).map((i) => i.source).filter((s): s is string => Boolean(s)),
		dependencies: index.dependencies[relativePath] || [],
		reverseDependencies: index.reverseDependencies[relativePath] || [],
	};
}

export function impactCodebaseFile(index: CodebaseIndexV1, file: string, limit = 50): string[] {
	const start = normalizeRelativePath(file);
	const seen = new Set<string>();
	const queue = [...(index.reverseDependencies[start] || [])];
	while (queue.length && seen.size < limit) {
		const next = queue.shift();
		if (!next || seen.has(next)) continue;
		seen.add(next);
		for (const dep of index.reverseDependencies[next] || []) {
			if (!seen.has(dep)) queue.push(dep);
		}
	}
	return [...seen];
}

export function enrichPlanningContext(
	steps: QuestStep[],
	goal: string,
	cwd: string,
): PlanningEnrichmentResult {
	const cache = loadCodebaseIndex(cwd);
	if (cache.status !== "ok") {
		return { cache, enrichedTasks: steps, summary: codebaseStatusSummary(cache) };
	}

	const enrichedTasks = steps.map((task) => {
		const relevant = rankFilesForQuery(cache.index, `${task.content}\n${task.context}\n${goal}`, 5);
		if (!relevant.length) return task;

		const maps = relevant
			.slice(0, 3)
			.map((file) => mapCodebaseFile(cache.index, file.relativePath))
			.filter((map): map is CodebaseMapResult => Boolean(map));
		const block = formatPlanningBlock(relevant, maps);
		if (task.context.includes("[Codebase intelligence]")) return task;
		return { ...task, context: `${task.context}\n\n${block}` };
	});

	const enrichedCount = enrichedTasks.filter((task, i) => task.context !== steps[i].context).length;
	return {
		cache,
		enrichedTasks,
		summary: `Codebase intelligence: enriched ${enrichedCount}/${steps.length} step contexts from ${CODEBASE_CACHE_PATH} (${cache.index.fileCount} indexed files).`,
	};
}

export function extractFilePaths(text: string): string[] {
	const matches =
		text.match(/[A-Za-z0-9_.\/-]+\.(?:[cm]?[jt]sx?|json|md|css|scss|yml|yaml)/g) || [];
	return [...new Set(matches.map(normalizeRelativePath).filter((p) => !p.startsWith("..")))];
}

export function buildVerificationImpactContext(cwd: string, text: string): string {
	const cache = loadCodebaseIndex(cwd);
	const files = extractFilePaths(text);
	if (!files.length) {
		return 'Codebase impact: no changed file paths detected in the step result. If files changed, run codebase(operation="impact", file=...) for each changed file.';
	}

	const toolPrompt = [
		'Codebase impact: before deciding PASS/FAIL, run codebase(operation="impact", file=...) for changed files when the codebase tool is available.',
		`Changed files detected: ${files.join(", ")}`,
	];

	if (cache.status !== "ok") return [...toolPrompt, codebaseStatusSummary(cache)].join("\n");

	const impactLines = files.slice(0, 8).map((file) => {
		const impact = impactCodebaseFile(cache.index, file, 12);
		return `- ${file}: ${impact.length ? impact.join(", ") : "no indexed reverse dependencies"}`;
	});
	return [
		...toolPrompt,
		"Fallback cache impact from .pi/codebase-index.json:",
		...impactLines,
	].join("\n");
}

export function codebaseStatusSummary(cache: CodebaseLoadResult): string {
	switch (cache.status) {
		case "ok":
			return `Codebase cache ready: ${cache.index.fileCount} files, scanned ${new Date(cache.index.scannedAt).toISOString()}.`;
		case "missing":
			return `Codebase cache missing at ${CODEBASE_CACHE_PATH}. If available, run codebase(operation=\"scan\") before planning large code steps.`;
		case "future":
			return `Codebase cache contractVersion ${cache.contractVersion} is newer than supported ${SUPPORTED_CODEBASE_CONTRACT_VERSION}; ignoring direct cache fallback.`;
		case "unsupported":
			return `Codebase cache contractVersion ${String(cache.contractVersion)} is unsupported; ignoring direct cache fallback.`;
		case "invalid":
			return `Codebase cache invalid: ${cache.error}`;
	}
}

function formatPlanningBlock(relevant: CodebaseQueryResult[], maps: CodebaseMapResult[]): string {
	const lines = [
		"[Codebase intelligence]",
		`Relevant files: ${relevant.map((file) => file.relativePath).join(", ")}`,
	];
	for (const map of maps) {
		const deps = map.dependencies.length ? map.dependencies.slice(0, 5).join(", ") : "none";
		const revDeps = map.reverseDependencies.length
			? map.reverseDependencies.slice(0, 5).join(", ")
			: "none";
		lines.push(`- ${map.relativePath}: deps=[${deps}], reverseDeps=[${revDeps}]`);
	}
	return lines.join("\n");
}

function normalizeRelativePath(file: string): string {
	return file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
