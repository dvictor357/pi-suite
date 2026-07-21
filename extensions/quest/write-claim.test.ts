import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	normalizeClaimPath,
	findOverlap,
	normalizeClaims,
	validateClaims,
	validateParallelWriteClaims,
	missingParallelWriteClaimIndices,
	hasNonEmptyWriteClaim,
	isReadOnlyRole,
	WriteClaimRegistry,
} from "./write-claim";

// ── Temporary test directory helpers ────────────────────────────────────────

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`pi-quest-write-claim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	try {
		rmdirSync(dir, { recursive: true });
	} catch {
		/* best-effort */
	}
}

// ── isReadOnlyRole ──────────────────────────────────────────────────────────

test("isReadOnlyRole identifies judge/exploration roles", () => {
	for (const role of ["scout", "verifier", "reviewer", "planner"]) {
		assert.equal(isReadOnlyRole(role), true, role);
		assert.equal(isReadOnlyRole(role.toUpperCase()), true, role.toUpperCase());
		assert.equal(isReadOnlyRole(` ${role} `), true, ` ${role} `);
	}
});

test("isReadOnlyRole returns false for execution roles", () => {
	for (const role of ["worker", "quick-worker", "developer", ""]) {
		assert.equal(isReadOnlyRole(role), false, role || "(empty)");
	}
});

// ── normalizeClaimPath ──────────────────────────────────────────────────────

describe("normalizeClaimPath", () => {
	test("resolves relative path against cwd", () => {
		const cwd = resolve("/project");
		const result = normalizeClaimPath("src/foo.ts", cwd);
		assert.equal(result, "/project/src/foo.ts");
	});

	test("resolves .. and . segments", () => {
		const cwd = resolve("/project");
		const result = normalizeClaimPath("src/../lib/./foo.ts", cwd);
		assert.equal(result, "/project/lib/foo.ts");
	});

	test("returns null for traversal outside cwd", () => {
		const cwd = resolve("/project");
		assert.equal(normalizeClaimPath("../etc/passwd", cwd), null);
		assert.equal(normalizeClaimPath("/etc/passwd", cwd), null);
	});

	test("handles absolute paths within cwd", () => {
		const cwd = resolve("/project");
		const result = normalizeClaimPath("/project/src/foo.ts", cwd);
		assert.equal(result, "/project/src/foo.ts");
	});

	test("returns null for empty or whitespace", () => {
		assert.equal(normalizeClaimPath("", "/project"), null);
		assert.equal(normalizeClaimPath("  ", "/project"), null);
	});

	test("normalizes backslashes to forward slashes (Windows-style paths)", () => {
		const cwd = resolve("/project");
		// On macOS, backslash is an ordinary character. The function normalizes
		// the output, replacing any literal backslashes with forward slashes.
		const result = normalizeClaimPath("src\\foo\\bar.ts", cwd);
		assert.equal(result, "/project/src/foo/bar.ts");
	});

	test("resolves symlinks to real path when the target exists", () => {
		const dir = makeTmpDir();
		try {
			const cwd = join(dir, "project");
			mkdirSync(cwd, { recursive: true });
			const realDir = join(cwd, "src");
			mkdirSync(realDir);
			const target = join(realDir, "foo.ts");
			writeFileSync(target, "");
			const linkDir = join(cwd, "link");
			symlinkSync("src", linkDir); // relative symlink
			// Claim through symlink; file exists, so realpath resolves it.
			const result = normalizeClaimPath("link/foo.ts", cwd);
			assert.equal(result, realpathSync(target).replace(/\\/g, "/"));
		} finally {
			cleanup(dir);
		}
	});

	test("resolves a non-existent child through a symlink ancestor", () => {
		const dir = makeTmpDir();
		try {
			const cwd = join(dir, "project");
			mkdirSync(join(cwd, "src"), { recursive: true });
			symlinkSync("src", join(cwd, "link"));
			assert.equal(
				normalizeClaimPath("link/new-file.ts", cwd),
				resolve(join(realpathSync(cwd), "src/new-file.ts")).replace(/\\/g, "/"),
			);
		} finally {
			cleanup(dir);
		}
	});

	test("allows claiming the cwd root", () => {
		assert.equal(normalizeClaimPath(".", "/project"), "/project");
	});
});

// ── findOverlap ─────────────────────────────────────────────────────────────

describe("findOverlap", () => {
	test("returns null for disjoint paths", () => {
		assert.equal(findOverlap(["/project/src"], ["/project/tests"]), null);
	});

	test("finds identical paths", () => {
		const result = findOverlap(["/project/src/foo.ts"], ["/project/src/foo.ts"]);
		assert.deepEqual(result, { pathA: "/project/src/foo.ts", pathB: "/project/src/foo.ts" });
	});

	test("finds ancestor/descendant overlap (A contains B)", () => {
		const result = findOverlap(["/project/src/"], ["/project/src/foo.ts"]);
		assert.ok(result !== null);
		assert.equal(result!.pathA, "/project/src/");
		assert.equal(result!.pathB, "/project/src/foo.ts");
	});

	test("finds ancestor/descendant overlap (B contains A)", () => {
		const result = findOverlap(["/project/src/foo.ts"], ["/project/src/"]);
		assert.ok(result !== null);
	});

	test("returns null for sibling directories", () => {
		assert.equal(findOverlap(["/project/src/"], ["/project/lib/"]), null);
	});

	test("empty arrays never overlap", () => {
		assert.equal(findOverlap([], ["/x"]), null);
		assert.equal(findOverlap(["/x"], []), null);
		assert.equal(findOverlap([], []), null);
	});
});

// ── normalizeClaims ─────────────────────────────────────────────────────────

describe("normalizeClaims", () => {
	test("returns empty for undefined input", () => {
		assert.deepEqual(normalizeClaims(undefined, "/project"), []);
	});

	test("returns empty for empty array", () => {
		assert.deepEqual(normalizeClaims([], "/project"), []);
	});

	test("deduplicates normalized paths", () => {
		const result = normalizeClaims(["src/foo.ts", "./src/foo.ts", "src/bar.ts"], "/project");
		assert.equal(result.length, 2);
		assert.ok(result.includes("/project/src/foo.ts"));
		assert.ok(result.includes("/project/src/bar.ts"));
	});

	test("rejects traversal instead of silently weakening the claim", () => {
		assert.throws(
			() => normalizeClaims(["src/foo.ts", "../outside.ts"], "/project"),
			/stay within/,
		);
	});

	test("rejects empty entries", () => {
		assert.throws(() => normalizeClaims(["src/foo.ts", "  "], "/project"), /non-empty/);
	});
});

// ── validateClaims ──────────────────────────────────────────────────────────

describe("validateClaims", () => {
	test("allows worker to declare write claims", () => {
		assert.equal(validateClaims("worker", ["src/foo.ts"], undefined), null);
	});

	test("rejects read-only role declaring write claims", () => {
		const err = validateClaims("scout", ["src/foo.ts"], undefined);
		assert.ok(err !== null);
		assert.match(err!, /read-only/);
	});

	test("allows read-only role with only read claims", () => {
		assert.equal(validateClaims("verifier", undefined, ["src/foo.ts"]), null);
	});

	test("allows empty claims for any role", () => {
		assert.equal(validateClaims("planner", [], []), null);
		assert.equal(validateClaims("scout", undefined, undefined), null);
	});
});

// ── Parallel write-claim requirement (R3) ───────────────────────────────────

describe("hasNonEmptyWriteClaim", () => {
	test("false for missing, empty, or undefined", () => {
		assert.equal(hasNonEmptyWriteClaim(undefined), false);
		assert.equal(hasNonEmptyWriteClaim([]), false);
	});

	test("true when at least one path is present", () => {
		assert.equal(hasNonEmptyWriteClaim(["src/a.ts"]), true);
	});
});

describe("missingParallelWriteClaimIndices", () => {
	test("flags execution roles without writeClaim", () => {
		const indices = missingParallelWriteClaimIndices([
			{ agent: "worker", writeClaim: ["src/a.ts"] },
			{ agent: "worker" },
			{ agent: "quick-worker", writeClaim: [] },
			{ agent: "scout" },
			{ agent: "verifier", writeClaim: [] },
		]);
		assert.deepEqual(indices, [1, 2]);
	});

	test("returns empty when all writers have claims", () => {
		assert.deepEqual(
			missingParallelWriteClaimIndices([
				{ agent: "worker", writeClaim: ["src/a.ts"] },
				{ agent: "scout" },
			]),
			[],
		);
	});
});

describe("validateParallelWriteClaims", () => {
	test("returns null when plan is valid", () => {
		assert.equal(
			validateParallelWriteClaims([
				{ agent: "worker", writeClaim: ["src/foo.ts"] },
				{ agent: "scout" },
				{ agent: "verifier" },
			]),
			null,
		);
	});

	test("lists 1-based step indices missing write claims", () => {
		const err = validateParallelWriteClaims([
			{ agent: "worker", writeClaim: ["src/a.ts"] },
			{ agent: "worker" },
			{ agent: "quick-worker", writeClaim: [] },
			{ agent: "planner" },
		]);
		assert.ok(err !== null);
		assert.match(err!, /#2/);
		assert.match(err!, /#3/);
		assert.doesNotMatch(err!, /#1/);
		assert.doesNotMatch(err!, /#4/);
		assert.match(err!, /Parallel mode requires/);
		assert.match(err!, /Read-only roles/);
	});

	test("allows empty claims for all read-only roles", () => {
		assert.equal(
			validateParallelWriteClaims([
				{ agent: "scout" },
				{ agent: "verifier" },
				{ agent: "reviewer" },
				{ agent: "planner" },
			]),
			null,
		);
	});
});

// ── WriteClaimRegistry ──────────────────────────────────────────────────────

describe("WriteClaimRegistry", () => {
	test("registers claims and returns null on success", () => {
		const reg = new WriteClaimRegistry();
		const conflict = reg.register("/project", 0, "Add auth", ["/project/src/auth.ts"]);
		assert.equal(conflict, null);
	});

	test("detects overlap with existing claims", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Add auth", ["/project/src/auth.ts"]);
		const conflict = reg.register("/project", 1, "Refactor auth", ["/project/src/auth.ts"]);
		assert.ok(conflict !== null);
		assert.equal(conflict!.stepIndex, 0);
		assert.equal(conflict!.stepContent, "Add auth");
	});

	test("detects ancestor overlap", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Refactor src", ["/project/src/"]);
		const conflict = reg.register("/project", 1, "Fix bug", ["/project/src/foo.ts"]);
		assert.ok(conflict !== null);
	});

	test("allows disjoint claims", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Add auth", ["/project/src/auth.ts"]);
		const conflict = reg.register("/project", 1, "Add tests", ["/project/tests/auth.test.ts"]);
		assert.equal(conflict, null);
	});

	test("re-registering same step overwrites (no self-conflict)", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Add auth", ["/project/src/auth.ts"]);
		const conflict = reg.register("/project", 0, "Add auth", ["/project/src/auth2.ts"]);
		assert.equal(conflict, null);
	});

	test("unregister removes claims", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Add auth", ["/project/src/auth.ts"]);
		reg.unregister("/project", 0);
		const conflict = reg.register("/project", 1, "Fix auth", ["/project/src/auth.ts"]);
		assert.equal(conflict, null);
	});

	test("active returns registered claims", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Step 1", ["/project/a.ts"]);
		reg.register("/project", 1, "Step 2", ["/project/b.ts"]);
		const active = reg.active("/project");
		assert.equal(active.length, 2);
	});

	test("active returns empty for unknown cwd", () => {
		const reg = new WriteClaimRegistry();
		assert.deepEqual(reg.active("/no-such-cwd"), []);
	});

	test("clear removes all claims for a cwd", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project", 0, "Step 1", ["/project/a.ts"]);
		reg.clear("/project");
		assert.deepEqual(reg.active("/project"), []);
	});

	test("reset clears everything", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/p1", 0, "S1", ["/p1/a.ts"]);
		reg.register("/p2", 0, "S1", ["/p2/a.ts"]);
		reg.reset();
		assert.deepEqual(reg.active("/p1"), []);
		assert.deepEqual(reg.active("/p2"), []);
	});

	test("different cwds don't conflict", () => {
		const reg = new WriteClaimRegistry();
		reg.register("/project-a", 0, "Step 1", ["/project-a/src/foo.ts"]);
		const conflict = reg.register("/project-b", 0, "Step 1", ["/project-b/src/foo.ts"]);
		assert.equal(conflict, null);
	});

	test("empty claims don't cause conflicts", () => {
		const reg = new WriteClaimRegistry();
		const conflict = reg.register("/project", 0, "Step 1", []);
		assert.equal(conflict, null);
	});

	test("filters falsy entries from claim paths", () => {
		const reg = new WriteClaimRegistry();
		const conflict = reg.register("/project", 0, "Step 1", [
			"/project/a.ts",
			"",
			"",
			"/project/b.ts",
		] as string[]);
		assert.equal(conflict, null);
		const active = reg.active("/project");
		assert.equal(active[0].paths.length, 2);
	});
});
