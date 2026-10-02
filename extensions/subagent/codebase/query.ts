/**
 * Codebase query API — scan, query, map, impact
 *
 * Pure functions that combine the indexer and cache layers.
 * All functions are synchronous and operate on in-memory IndexData.
 *
 * Dependencies: Node built-ins only.
 */

import * as path from "node:path";
import { type FileEntry, type IndexData, type QueryOptions, type ScanOptions } from "./types.js";
import { readCache, writeCache, checkStaleness } from "./cache.js";
import { scanRepo } from "./indexer.js";

// ── Scan ────────────────────────────────────────────────────────────────────

export interface ScanResult {
	index: IndexData;
	/** True if a full re-scan was performed. */
	rescanned: boolean;
	/** Why a re-scan was triggered (if rescanned). */
	reason?: string;
}

/**
 * Get the codebase index, using the cache when fresh.
 *
 * 1. Try reading the cache.
 * 2. If cache is missing/invalid, scan.
 * 3. If cache exists, check staleness.
 * 4. If stale, re-scan.
 * 5. Write new cache when rescanned.
 */
export function scanIndex(opts: ScanOptions = {}): ScanResult {
	const rootDir = path.resolve(opts.rootDir ?? process.cwd());
	const force = opts.force ?? false;

	if (force) {
		const index = scanRepo({ ...opts, rootDir });
		writeCache(index, rootDir);
		return { index, rescanned: true, reason: "forced" };
	}

	const cached = readCache(rootDir);

	if (!cached.data) {
		const index = scanRepo({ ...opts, rootDir });
		writeCache(index, rootDir);
		return { index, rescanned: true, reason: cached.reason ?? "no cache" };
	}

	const stale = checkStaleness(cached.data, rootDir, opts.extraExcludes);

	if (!stale.fresh) {
		const index = scanRepo({ ...opts, rootDir });
		writeCache(index, rootDir);
		return {
			index,
			rescanned: true,
			reason: `${stale.changedFiles.length} changed, ${stale.newFiles.length} new, ${stale.deletedFiles.length} deleted`,
		};
	}

	return { index: cached.data, rescanned: false };
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Find files whose path or exports match a pattern.
 *
 * `pattern` is matched case-insensitively against:
 * - file relative path
 * - file name
 * - symbol names
 * - export names
 */
export function queryFiles(
	index: IndexData,
	pattern: string,
	opts: QueryOptions = {},
): FileEntry[] {
	const lower = pattern.toLowerCase();
	const results: FileEntry[] = [];

	for (const entry of Object.values(index.files)) {
		// Match against relative path
		if (entry.relativePath.toLowerCase().includes(lower)) {
			results.push(entry);
			continue;
		}

		// Match against file name
		if (entry.name.toLowerCase().includes(lower)) {
			results.push(entry);
			continue;
		}

		// Match against symbols
		if (entry.symbols.some((s) => s.name.toLowerCase().includes(lower))) {
			results.push(entry);
			continue;
		}

		// Match against exports
		if (entry.exports.some((e) => e.name.toLowerCase().includes(lower))) {
			results.push(entry);
			continue;
		}
	}

	return results;
}

/**
 * Return a file entry by relative path.
 */
export function getFile(index: IndexData, relativePath: string): FileEntry | null {
	return index.files[relativePath] ?? null;
}

// ── Dependency maps ─────────────────────────────────────────────────────────

export interface DepResult {
	/** The file entry, or null if not in the index. */
	file: FileEntry | null;
	/** Direct dependencies (files this file imports). */
	dependencies: FileEntry[];
	/** Direct reverse dependencies (files that import this file). */
	reverseDependencies: FileEntry[];
}

/**
 * Get the dependency and reverse-dependency information for a file.
 */
export function depMap(index: IndexData, relativePath: string): DepResult {
	const file = index.files[relativePath] ?? null;

	const deps = (index.dependencies[relativePath] ?? [])
		.map((rel) => index.files[rel])
		.filter((f): f is FileEntry => f !== undefined);

	const revDeps = (index.reverseDependencies[relativePath] ?? [])
		.map((rel) => index.files[rel])
		.filter((f): f is FileEntry => f !== undefined);

	return { file, dependencies: deps, reverseDependencies: revDeps };
}

/**
 * Get the direct dependencies of a file.
 */
export function getDependencies(index: IndexData, relativePath: string): FileEntry[] {
	return depMap(index, relativePath).dependencies;
}

/**
 * Get the direct reverse dependencies of a file
 * (files that import this file).
 */
export function getReverseDependencies(index: IndexData, relativePath: string): FileEntry[] {
	return depMap(index, relativePath).reverseDependencies;
}

/**
 * Get the full transitive impact of a file: all files that depend on it,
 * directly or transitively.
 *
 * Uses BFS through the reverse-dependency graph.
 */
export function getImpact(index: IndexData, relativePath: string): FileEntry[] {
	const visited = new Set<string>();
	const queue = [relativePath];
	const result: FileEntry[] = [];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);

		const revDeps = index.reverseDependencies[current] ?? [];
		for (const dep of revDeps) {
			if (!visited.has(dep)) {
				queue.push(dep);
				const entry = index.files[dep];
				if (entry) result.push(entry);
			}
		}
	}

	return result;
}

// ── Bulk info ───────────────────────────────────────────────────────────────

/**
 * Get all files in the index.
 */
export function allFiles(index: IndexData): FileEntry[] {
	return Object.values(index.files);
}

/**
 * Get a summary of the index: counts and top-level stats.
 */
export function indexSummary(index: IndexData) {
	return {
		rootDir: index.rootDir,
		scannedAt: index.scannedAt,
		fileCount: index.fileCount,
		contractVersion: index.contractVersion,
	};
}
