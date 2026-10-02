/**
 * Codebase index cache — read/write .pi/codebase-index.json
 *
 * Manages the sidecar cache file with contract-version checks
 * and per-file staleness detection.
 *
 * Dependencies: Node built-ins only (fs, path, crypto).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSourceFiles } from "./file-discovery.js";
import { type IndexData, CODEBASE_CONTRACT_VERSION } from "./types.js";

import { CODEBASE_CACHE_PATH } from "../../../core";

// ── Paths ───────────────────────────────────────────────────────────────────

function cachePath(rootDir: string): string {
	return path.join(rootDir, CODEBASE_CACHE_PATH);
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface CacheResult {
	/** The cached index data, or null if missing/invalid. */
	data: IndexData | null;
	/** If data is null, why. */
	reason?: string;
}

/**
 * Read the cache file from disk. Returns null if the file is missing,
 * unreadable, has an incompatible contractVersion, or is malformed.
 */
export function readCache(rootDir: string = process.cwd()): CacheResult {
	const file = cachePath(rootDir);

	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return { data: null, reason: "no cache file" };
	}

	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { data: null, reason: "cache parse error" };
	}

	if (
		!parsed ||
		typeof parsed.contractVersion !== "number" ||
		parsed.contractVersion > CODEBASE_CONTRACT_VERSION
	) {
		return {
			data: null,
			reason: `incompatible contractVersion: ${parsed?.contractVersion}`,
		};
	}

	if (typeof parsed.rootDir !== "string" || parsed.rootDir !== rootDir) {
		return { data: null, reason: "rootDir mismatch" };
	}

	if (!parsed.files || typeof parsed.files !== "object") {
		return { data: null, reason: "missing or invalid files map" };
	}

	return { data: parsed as IndexData };
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Write the index to .pi/codebase-index.json. Creates the .pi directory
 * if needed.
 */
export function writeCache(data: IndexData, rootDir: string = process.cwd()): void {
	const file = cachePath(rootDir);
	const dir = path.dirname(file);

	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── Staleness ───────────────────────────────────────────────────────────────

export interface StalenessResult {
	/** True if the cache is fresh for all files. */
	fresh: boolean;
	/** Relative paths of files that have changed since the last scan. */
	changedFiles: string[];
	/** Relative paths of new files not in the cache. */
	newFiles: string[];
	/** Relative paths of deleted files that are in the cache but not on disk. */
	deletedFiles: string[];
}

/**
 * Quick staleness check: compare mtime + hash of cached files against
 * what's on disk. Does NOT re-parse — just detects changes.
 *
 * Also reports files that exist on disk but not in the cache (newFiles)
 * and files in the cache but not on disk (deletedFiles).
 */
export function checkStaleness(
	data: IndexData,
	rootDir: string = process.cwd(),
	extraExcludes: string[] = [],
): StalenessResult {
	const changedFiles: string[] = [];
	const newFiles: string[] = [];
	const deletedFiles: string[] = [];

	// Build set of current source files on disk (quick, no content read yet)
	const onDisk = new Set<string>();
	for (const fullPath of discoverSourceFiles({
		rootDir,
		extraExcludes,
		maxFiles: Number.MAX_SAFE_INTEGER,
	})) {
		const rel = path.posix.relative(rootDir.replace(/\\/g, "/"), fullPath.replace(/\\/g, "/"));
		onDisk.add(rel);
	}

	// Files in cache but not on disk → deleted
	for (const rel of Object.keys(data.files)) {
		if (!onDisk.has(rel)) {
			deletedFiles.push(rel);
		}
	}

	// Files on disk: check staleness
	for (const rel of onDisk) {
		const cached = data.files[rel];
		if (!cached) {
			newFiles.push(rel);
			continue;
		}

		const absPath = path.join(rootDir, rel);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(absPath);
		} catch {
			deletedFiles.push(rel);
			continue;
		}

		if (stat.mtimeMs !== cached.mtime) {
			// Mtime changed — verify with hash
			let content: string;
			try {
				content = fs.readFileSync(absPath, "utf8");
			} catch {
				changedFiles.push(rel);
				continue;
			}
			const h = crypto.createHash("sha256").update(content.slice(0, 16384), "utf8").digest("hex");
			if (h !== cached.hash) {
				changedFiles.push(rel);
			}
		}
	}

	return {
		fresh: changedFiles.length === 0 && newFiles.length === 0 && deletedFiles.length === 0,
		changedFiles,
		newFiles,
		deletedFiles,
	};
}
