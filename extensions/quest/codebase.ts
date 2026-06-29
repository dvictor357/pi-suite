import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { QuestTask } from "./types";

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
	enrichedTasks: QuestTask[];
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

export function queryCodebaseIndex(
	index: CodebaseIndexV1,
	pattern: string,
	limit = 8,
): CodebaseQueryResult[] {
	const needle = pattern.trim().toLowerCase();
	if (!needle) return [];

	const scored = Object.values(index.files)
		.map((file) => {
			const rel = file.relativePath.toLowerCase();
			const name = (file.name || "").toLowerCase();
			const symbols = (file.symbols || []).map((s) => (s.name || "").toLowerCase());
			const exports = (file.exports || []).map((e) => (e.name || "").toLowerCase());
			let score = 0;
			if (rel === needle || name === needle) score += 100;
			if (rel.includes(needle)) score += 40;
			if (name.includes(needle)) score += 30;
			if (symbols.some((s) => s.includes(needle))) score += 20;
			if (exports.some((e) => e.includes(needle))) score += 20;
			return { file, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));

	return scored.slice(0, limit).map((entry) => fileToQueryResult(entry.file));
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

export function deriveCodebasePatterns(text: string, limit = 5): string[] {
	const pathParts = extractFilePaths(text).map(
		(p) =>
			p
				.replace(/\.[cm]?[jt]sx?$/, "")
				.split("/")
				.pop() || p,
	);
	const words =
		text
			.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g)
			?.map((word) => word.toLowerCase())
			.filter((word) => !COMMON_WORDS.has(word)) ?? [];
	return [...new Set([...pathParts, ...words])].slice(0, limit);
}

export function enrichPlanningContext(
	tasks: QuestTask[],
	goal: string,
	cwd: string,
): PlanningEnrichmentResult {
	const cache = loadCodebaseIndex(cwd);
	if (cache.status !== "ok") {
		return { cache, enrichedTasks: tasks, summary: codebaseStatusSummary(cache) };
	}

	const enrichedTasks = tasks.map((task) => {
		const patterns = deriveCodebasePatterns(`${task.content}\n${task.context}\n${goal}`, 4);
		const relevant = uniqueByPath(
			patterns.flatMap((pattern) => queryCodebaseIndex(cache.index, pattern, 3)),
		).slice(0, 5);
		if (!relevant.length) return task;

		const maps = relevant
			.slice(0, 3)
			.map((file) => mapCodebaseFile(cache.index, file.relativePath))
			.filter((map): map is CodebaseMapResult => Boolean(map));
		const block = formatPlanningBlock(relevant, maps);
		if (task.context.includes("[Codebase intelligence]")) return task;
		return { ...task, context: `${task.context}\n\n${block}` };
	});

	const enrichedCount = enrichedTasks.filter((task, i) => task.context !== tasks[i].context).length;
	return {
		cache,
		enrichedTasks,
		summary: `Codebase intelligence: enriched ${enrichedCount}/${tasks.length} task contexts from ${CODEBASE_CACHE_PATH} (${cache.index.fileCount} indexed files).`,
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
		return 'Codebase impact: no changed file paths detected in the task result. If files changed, run codebase(operation="impact", file=...) for each changed file.';
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
			return `Codebase cache missing at ${CODEBASE_CACHE_PATH}. If available, run codebase(operation=\"scan\") before planning large code tasks.`;
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

function uniqueByPath(files: CodebaseQueryResult[]): CodebaseQueryResult[] {
	const seen = new Set<string>();
	return files.filter((file) => {
		if (seen.has(file.relativePath)) return false;
		seen.add(file.relativePath);
		return true;
	});
}
