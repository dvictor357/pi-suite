/**
 * quest/write-claim.ts — write-claim ownership at orchestration boundaries.
 *
 * Steps may declare which files they intend to write (`writeClaim`) and read
 * (`readClaim`). Before a step is delegated, the system checks for
 * overlapping concurrent write claims and rejects with an actionable error. The
 * registry is process-local (in-memory) — it does not survive a restart, and
 * cancellation/abort always clears stale claims.
 *
 * Pure helpers (normalize, overlaps) are exported for testing. The registry
 * itself is instantiated per `QuestRuntime` so it can be fully reset per session.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

// ── Roles that must never hold write claims ──────────────────────────────────

/** Roles that explore/judge but must never declare write claims. */
const READ_ONLY_ROLES = new Set(["scout", "verifier", "reviewer", "planner"]);

/**
 * True when a role is read-only and therefore must not declare write claims.
 */
export function isReadOnlyRole(role: string): boolean {
	return READ_ONLY_ROLES.has(role.trim().toLowerCase());
}

// ── Path normalization ───────────────────────────────────────────────────────

/**
 * Normalize a filesystem path for claim comparison.
 *
 * Rules:
 * 1. Resolve relative paths against `cwd` (so claims are always absolute).
 * 2. Collapse `..` and `.` segments via `path.resolve`.
 * 3. Resolve symlinks via `realpathSync` when the path already exists on disk;
 *    otherwise trust `path.resolve` output as-is.
 * 4. When symlinks were resolved, also realpath the cwd for consistent
 *    traversal checks (macOS /var→/private/var).
 * 5. Return forward-slash normalised absolute paths for consistent matching.
 *
 * Returns null when the path normalises outside `cwd` (traversal attempt).
 */
export function normalizeClaimPath(raw: string, cwd: string): string | null {
	if (!raw || !raw.trim()) return null;
	const trimmed = raw.trim();

	// Resolve relative to cwd, collapse .. and .
	const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);

	// Resolve the nearest existing ancestor so a non-existent child beneath a
	// symlink aliases the same claim as its real path.
	let ancestor = absolute;
	while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
	let real = absolute;
	let didRealpath = false;
	try {
		const realAncestor = realpathSync(ancestor);
		real = resolve(realAncestor, relative(ancestor, absolute));
		didRealpath = true;
	} catch {
		// Validation below still confines the lexical path to cwd.
	}

	// Traversal guard: resolved path must not escape cwd.
	// When we used realpath on the file, also realpath the cwd so symlink
	// chains (e.g. macOS /var→/private/var) don't cause false positives.
	let baseCwd: string;
	if (didRealpath && existsSync(cwd)) {
		try {
			baseCwd = realpathSync(cwd);
		} catch {
			baseCwd = resolve(cwd);
		}
	} else {
		baseCwd = resolve(cwd);
	}
	if (!isWithin(real, baseCwd)) return null;

	return normalize(real).replace(/\\/g, "/");
}

/** True when `target` is within (or equal to) `dir`. */
function isWithin(target: string, dir: string): boolean {
	const rel = relative(dir, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── Overlap detection ────────────────────────────────────────────────────────

/**
 * Check whether two sets of normalized paths overlap.
 *
 * Two paths overlap when:
 * - They are identical.
 * - One is a parent directory of the other (a write to `src/` overlaps with a
 *   write to `src/foo.ts`).
 *
 * Returns the first overlapping path pair found, or null when disjoint.
 */
export function findOverlap(
	claimsA: string[],
	claimsB: string[],
): { pathA: string; pathB: string } | null {
	for (const a of claimsA) {
		for (const b of claimsB) {
			if (a === b) return { pathA: a, pathB: b };
			if (isAncestor(a, b)) return { pathA: a, pathB: b };
			if (isAncestor(b, a)) return { pathA: a, pathB: b };
		}
	}
	return null;
}

/** True when `parent` is an ancestor directory of `child`. */
function isAncestor(parent: string, child: string): boolean {
	return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

// ── Claim set utilities ──────────────────────────────────────────────────────

/**
 * Normalize and deduplicate raw claim paths. Invalid entries throw so callers
 * fail closed. Empty/undefined input remains backward-compatible.
 */
export function normalizeClaims(raw: string[] | undefined, cwd: string): string[] {
	if (!raw || raw.length === 0) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of raw) {
		const normalized = normalizeClaimPath(p, cwd);
		if (!normalized) {
			throw new Error(
				`Invalid claim path ${JSON.stringify(p)}: paths must be non-empty and stay within ${cwd}.`,
			);
		}
		if (!seen.has(normalized)) {
			seen.add(normalized);
			out.push(normalized);
		}
	}
	return out;
}

/**
 * Validate a step's declared claims against policy:
 * - Read-only roles must not declare write claims.
 * - Read claims are validated at the cwd boundary.
 *
 * Returns null when valid, or an error message string.
 */
export function validateClaims(
	role: string,
	writeClaims: string[] | undefined,
	readClaims: string[] | undefined,
): string | null {
	if (isReadOnlyRole(role)) {
		if (writeClaims && writeClaims.length > 0) {
			return `Role "${role}" is read-only and must not declare write claims. Remove writeClaim from this step's declaration or change its agent role.`;
		}
	}
	return null;
}

// ── Active claim registry ────────────────────────────────────────────────────

/** One registered active write-claim set. */
export interface ActiveClaim {
	/** Step index (0-based). */
	stepIndex: number;
	/** Step content (for error messages). */
	stepContent: string;
	/** Normalized absolute paths this step is writing to. */
	paths: string[];
	/** Epoch-ms when the claim was registered. */
	registeredAt: number;
}

/**
 * Process-local registry of active write claims.
 *
 * Scoped per cwd so different projects don't collide. Registration checks for
 * overlap and returns conflicting claims — the caller then rejects the
 * delegation with an actionable error.
 */
export class WriteClaimRegistry {
	private claims = new Map<string, Map<number, ActiveClaim>>();

	/**
	 * Try to register write claims for a step.
	 *
	 * Returns the conflicting active claim when an overlap is found, or null
	 * when registration succeeded. The caller should reject delegation on
	 * conflict and proceed on null.
	 */
	register(
		cwd: string,
		stepIndex: number,
		stepContent: string,
		paths: string[],
	): ActiveClaim | null {
		const cwdClaims = this.ensureCwd(cwd);
		const deduped = [...new Set(paths.filter(Boolean))];

		// Check against every other active step's claims.
		for (const [, existing] of cwdClaims) {
			if (existing.stepIndex === stepIndex) continue; // same step re-register
			const overlap = findOverlap(deduped, existing.paths);
			if (overlap) return existing;
		}

		cwdClaims.set(stepIndex, {
			stepIndex,
			stepContent,
			paths: deduped,
			registeredAt: Date.now(),
		});
		return null;
	}

	/** Unregister a step's claims (called on completion/abort). */
	unregister(cwd: string, stepIndex: number): void {
		this.claims.get(cwd)?.delete(stepIndex);
	}

	/** Get all active claims for a cwd (for display). */
	active(cwd: string): ActiveClaim[] {
		return [...(this.claims.get(cwd)?.values() ?? [])];
	}

	/** Clear all claims for a cwd (called on quest abort/session reset). */
	clear(cwd: string): void {
		this.claims.delete(cwd);
	}

	/** Reset everything (called on session_start). */
	reset(): void {
		this.claims.clear();
	}

	private ensureCwd(cwd: string): Map<number, ActiveClaim> {
		let m = this.claims.get(cwd);
		if (!m) {
			m = new Map();
			this.claims.set(cwd, m);
		}
		return m;
	}
}
