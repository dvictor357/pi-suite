import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildVerificationImpactContext,
	CODEBASE_CACHE_PATH,
	type CodebaseIndexV1,
	corpusFor,
	expandQuery,
	enrichPlanningContext,
	hasCodebaseCache,
	hasCodebaseTool,
	impactCodebaseFile,
	loadCodebaseIndex,
	mapCodebaseFile,
	queryCodebaseIndex,
	rankFilesForQuery,
} from "./codebase";
import { CODEBASE_RANKING } from "./constants";
import type { QuestStep } from "./types";

/**
 * Build an in-memory index for ranking tests, so we can control the corpus
 * precisely without touching disk. Files carry symbols/exports; deps/reverseDeps
 * are supplied verbatim.
 */
function makeIndex(
	files: Record<string, { symbols?: string[]; exports?: string[]; imports?: string[] }>,
	graph: {
		dependencies?: Record<string, string[]>;
		reverseDependencies?: Record<string, string[]>;
	} = {},
): CodebaseIndexV1 {
	const fileEntries: CodebaseIndexV1["files"] = {};
	for (const [rel, spec] of Object.entries(files)) {
		fileEntries[rel] = {
			relativePath: rel,
			name: rel.split("/").pop() || rel,
			imports: (spec.imports || []).map((source) => ({ source })),
			exports: (spec.exports || []).map((name) => ({ name, kind: "named" })),
			symbols: (spec.symbols || []).map((name) => ({ name, kind: "function" })),
		};
	}
	return {
		contractVersion: 1,
		rootDir: "/repo",
		scannedAt: 1719000000000,
		fileCount: Object.keys(files).length,
		files: fileEntries,
		dependencies: graph.dependencies || {},
		reverseDependencies: graph.reverseDependencies || {},
	};
}

function tempRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-suite-codebase-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	return cwd;
}

function writeIndex(cwd: string, contractVersion = 1): void {
	writeFileSync(
		join(cwd, CODEBASE_CACHE_PATH),
		JSON.stringify(
			{
				contractVersion,
				rootDir: cwd,
				scannedAt: 1719000000000,
				fileCount: 3,
				files: {
					"src/foo.ts": {
						path: join(cwd, "src/foo.ts"),
						name: "foo.ts",
						relativePath: "src/foo.ts",
						imports: [{ source: "./bar", names: ["barFn"], resolved: "src/bar.ts" }],
						exports: [{ name: "fooFn", kind: "named" }],
						symbols: [{ name: "fooFn", kind: "function" }],
						mtime: 1,
						hash: "a",
					},
					"src/bar.ts": {
						path: join(cwd, "src/bar.ts"),
						name: "bar.ts",
						relativePath: "src/bar.ts",
						imports: [],
						exports: [{ name: "barFn", kind: "named" }],
						symbols: [{ name: "barFn", kind: "function" }],
						mtime: 1,
						hash: "b",
					},
					"src/baz.ts": {
						path: join(cwd, "src/baz.ts"),
						name: "baz.ts",
						relativePath: "src/baz.ts",
						imports: [{ source: "./foo", names: ["fooFn"], resolved: "src/foo.ts" }],
						exports: [{ name: "bazFn", kind: "named" }],
						symbols: [{ name: "bazFn", kind: "function" }],
						mtime: 1,
						hash: "c",
					},
				},
				dependencies: {
					"src/foo.ts": ["src/bar.ts"],
					"src/bar.ts": [],
					"src/baz.ts": ["src/foo.ts"],
				},
				reverseDependencies: {
					"src/foo.ts": ["src/baz.ts"],
					"src/bar.ts": ["src/foo.ts"],
					"src/baz.ts": [],
				},
			},
			null,
			2,
		),
	);
}

function task(overrides: Partial<QuestStep> = {}): QuestStep {
	return {
		content: "Update foo behavior",
		status: "pending",
		agent: "worker",
		context: "Change fooFn in src/foo.ts and keep callers working.",
		dependencies: [],
		result: null,
		attempts: 0,
		startedAt: null,
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
		...overrides,
	};
}

test("detects codebase cache presence", () => {
	const cwd = tempRepo();
	assert.equal(hasCodebaseCache(cwd), false);
	writeIndex(cwd);
	assert.equal(hasCodebaseCache(cwd), true);
});

test("supports contractVersion 1 and gracefully ignores future versions", () => {
	const cwd = tempRepo();
	writeIndex(cwd, 1);
	const supported = loadCodebaseIndex(cwd);
	assert.equal(supported.status, "ok");

	writeIndex(cwd, 2);
	const future = loadCodebaseIndex(cwd);
	assert.equal(future.status, "future");
	if (future.status === "future") assert.equal(future.contractVersion, 2);
});

test("planning enrichment degrades gracefully on a future-version cache", () => {
	const cwd = tempRepo();
	writeIndex(cwd, 2); // newer than SUPPORTED_CODEBASE_CONTRACT_VERSION

	const steps = [task()];
	const result = enrichPlanningContext(steps, "improve foo", cwd);
	// Steps are returned untouched (no enrichment from an unreadable cache)...
	assert.equal(result.cache.status, "future");
	assert.deepEqual(result.enrichedTasks, steps);
	assert.match(result.summary, /newer than supported/);

	// ...and the verifier impact context falls back to the tool prompt, not cache data.
	const impact = buildVerificationImpactContext(cwd, "edited src/foo.ts");
	assert.match(impact, /newer than supported/);
	assert.doesNotMatch(impact, /Fallback cache impact/);
});

test("queries and maps codebase cache data", () => {
	const cwd = tempRepo();
	writeIndex(cwd);
	const loaded = loadCodebaseIndex(cwd);
	assert.equal(loaded.status, "ok");
	if (loaded.status !== "ok") return;

	assert.deepEqual(
		queryCodebaseIndex(loaded.index, "foo").map((file) => file.relativePath),
		["src/foo.ts"],
	);
	assert.deepEqual(mapCodebaseFile(loaded.index, "src/foo.ts")?.dependencies, ["src/bar.ts"]);
});

test("enriches planning context from direct cache fallback when codebase tool is unavailable", () => {
	const cwd = tempRepo();
	writeIndex(cwd);
	assert.equal(hasCodebaseTool([{ name: "read" }, { name: "bash" }]), false);

	const result = enrichPlanningContext([task()], "Improve foo module", cwd);
	assert.equal(result.cache.status, "ok");
	assert.match(result.summary, /enriched 1\/1/);
	assert.match(result.enrichedTasks[0].context, /\[Codebase intelligence\]/);
	assert.match(result.enrichedTasks[0].context, /src\/foo\.ts/);
	assert.match(result.enrichedTasks[0].context, /reverseDeps=\[src\/baz\.ts\]/);
});

test("planning enrichment falls back gracefully without usable cache", () => {
	const cwd = tempRepo();
	const result = enrichPlanningContext([task()], "Improve foo module", cwd);
	assert.equal(result.cache.status, "missing");
	assert.equal(result.enrichedTasks[0].context, task().context);
	assert.match(result.summary, /codebase\(operation="scan"\)/);
});

test("verification impact checks use transitive reverse dependencies", () => {
	const cwd = tempRepo();
	writeIndex(cwd);
	const loaded = loadCodebaseIndex(cwd);
	assert.equal(loaded.status, "ok");
	if (loaded.status !== "ok") return;

	assert.deepEqual(impactCodebaseFile(loaded.index, "src/bar.ts"), ["src/foo.ts", "src/baz.ts"]);
	const context = buildVerificationImpactContext(cwd, "Changed src/bar.ts while fixing imports");
	assert.match(context, /codebase\(operation="impact"/);
	assert.match(context, /src\/bar\.ts: src\/foo\.ts, src\/baz\.ts/);
});

// ── Ranking: BM25 + idf + tokenization + exact-match + graph expansion ─────────

const NO_EXPANSION = {
	...CODEBASE_RANKING,
	graphExpansion: { ...CODEBASE_RANKING.graphExpansion, enabled: false },
};

test("ranking: a rare (high-idf) term outranks common-term-only matches", () => {
	// "render" is in every file (low idf); "widget" is unique (high idf).
	const index = makeIndex({
		"src/widget.ts": { symbols: ["renderWidget"], exports: ["renderWidget"] },
		"src/render-a.ts": { symbols: ["renderA"] },
		"src/render-b.ts": { symbols: ["renderB"] },
		"src/render-c.ts": { symbols: ["renderC"] },
	});
	// Combined evidence: widget.ts matches both "render" and the rare "widget".
	const ranked = queryCodebaseIndex(index, "render widget").map((f) => f.relativePath);
	assert.equal(ranked[0], "src/widget.ts");
	// The unique term alone resolves to exactly the one file.
	assert.deepEqual(
		queryCodebaseIndex(index, "widget").map((f) => f.relativePath),
		["src/widget.ts"],
	);
});

test("ranking: tokenization respects word boundaries (no substring bleed)", () => {
	const index = makeIndex({
		"src/mapper.ts": { symbols: ["mapper"] },
		"src/foo.ts": { symbols: ["fooFn"] },
	});
	// "app" must NOT match "mapper" (old substring ranker did).
	assert.deepEqual(queryCodebaseIndex(index, "app"), []);
	// camelCase symbol "fooFn" is tokenized, so "foo" matches it.
	assert.deepEqual(
		queryCodebaseIndex(index, "foo").map((f) => f.relativePath),
		["src/foo.ts"],
	);
});

test("ranking: exact identifier match wins over higher raw term frequency", () => {
	const index = makeIndex({
		// base name is exactly "config" → earns the exact-match bonus.
		"src/config.ts": { symbols: ["loadConfig"], exports: ["loadConfig"] },
		// has the token "config" twice, but no exact "config" identifier/base name.
		"src/config-helpers.ts": { symbols: ["configHelperA", "configHelperB"] },
	});
	const ranked = queryCodebaseIndex(index, "config").map((f) => f.relativePath);
	assert.equal(ranked[0], "src/config.ts");
});

test("ranking: graph expansion surfaces neighbours the query never names", () => {
	const index = makeIndex(
		{
			"src/core.ts": { symbols: ["coreThing"] },
			"src/consumer.ts": { symbols: ["unrelatedName"] },
		},
		{ reverseDependencies: { "src/core.ts": ["src/consumer.ts"] } },
	);
	// Lexically, only core.ts matches "core"; consumer.ts shares no tokens.
	assert.deepEqual(
		queryCodebaseIndex(index, "core").map((f) => f.relativePath),
		["src/core.ts"],
	);
	// With expansion on (default), the dependent is folded in as a decayed hit.
	const expanded = rankFilesForQuery(index, "core").map((f) => f.relativePath);
	assert.deepEqual(expanded, ["src/core.ts", "src/consumer.ts"]);
	// With expansion off, it is not.
	const lexicalOnly = rankFilesForQuery(index, "core", 8, NO_EXPANSION).map((f) => f.relativePath);
	assert.deepEqual(lexicalOnly, ["src/core.ts"]);
});

test("ranking: the corpus is memoized per index (built once, reused)", () => {
	const index = makeIndex({ "src/a.ts": { symbols: ["alpha"] } });
	// Same config → same corpus object reference (no rebuild).
	assert.equal(corpusFor(index), corpusFor(index));
	// A different config forces a rebuild (distinct reference).
	assert.notEqual(corpusFor(index), corpusFor(index, NO_EXPANSION));
});

// ── Semantic co-occurrence expansion (opt-in; default OFF) ────────────────────

const SEMANTIC_ON = {
	...CODEBASE_RANKING,
	graphExpansion: { ...CODEBASE_RANKING.graphExpansion, enabled: false }, // isolate the semantic effect
	semantic: { ...CODEBASE_RANKING.semantic, enabled: true },
};

// A corpus where "billing" and "payment" co-occur strongly enough for a positive
// PMI, plus a payment-only file the lexical query never names, and an unrelated
// file to give the co-occurrence discriminating power (raises N).
const SEM_INDEX = makeIndex({
	"src/pay/charge.ts": { symbols: ["charge", "payment", "billing"] },
	"src/pay/cycle.ts": { symbols: ["cycle", "payment", "billing"] },
	"src/pay/refund.ts": { symbols: ["refund", "payment"] },
	"src/ui/button.ts": { symbols: ["render", "button"] },
});

test("semantic: expandQuery surfaces a distinctively co-occurring term", () => {
	const corpus = corpusFor(SEM_INDEX, SEMANTIC_ON);
	const expansions = [...expandQuery(corpus, ["billing"], SEMANTIC_ON).keys()];
	assert.ok(expansions.includes("payment"), `expected "payment", got: ${expansions.join(", ")}`);
});

test("semantic: expansion reaches a file the lexical query never names", () => {
	// "billing" lexically matches only the two files that contain it.
	const lexical = rankFilesForQuery(SEM_INDEX, "billing", 10, NO_EXPANSION).map(
		(f) => f.relativePath,
	);
	assert.ok(!lexical.includes("src/pay/refund.ts"));
	// With semantic expansion, "payment" is added, surfacing the payment-only file.
	const semantic = rankFilesForQuery(SEM_INDEX, "billing", 10, SEMANTIC_ON).map(
		(f) => f.relativePath,
	);
	assert.ok(semantic.includes("src/pay/refund.ts"));
});

test("semantic: is inert when disabled (the shipped default)", () => {
	const withDefault = rankFilesForQuery(SEM_INDEX, "billing", 10).map((f) => f.relativePath);
	const explicitOff = rankFilesForQuery(SEM_INDEX, "billing", 10, NO_EXPANSION).map(
		(f) => f.relativePath,
	);
	assert.deepEqual(withDefault, explicitOff);
});
