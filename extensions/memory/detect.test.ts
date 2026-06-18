import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectMemory } from "../../core";
import { detectProject, reconcile, sameFingerprint } from "./detect";

function fixtureProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-suite-detect-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fix-proj" }), "utf8");
	writeFileSync(join(dir, "package-lock.json"), "{}", "utf8"); // → npm
	writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n", "utf8"); // → TypeScript
	writeFileSync(join(dir, "b.ts"), "export const b = 2;\n", "utf8");
	return dir;
}

test("sameFingerprint compares records by key/value, missing → false", () => {
	assert.equal(sameFingerprint({ "package.json": 1 }, { "package.json": 1 }), true);
	assert.equal(sameFingerprint({ "package.json": 1 }, { "package.json": 2 }), false);
	assert.equal(sameFingerprint({ a: 1 }, { a: 1, b: 2 }), false);
	assert.equal(sameFingerprint(undefined, { a: 1 }), false);
	assert.equal(sameFingerprint({ a: 1 }, undefined), false);
});

test("detectProject reads the tech stack from project files", () => {
	const dir = fixtureProject();
	try {
		const p = detectProject(dir);
		assert.equal(p.name, "fix-proj", "name from package.json");
		assert.equal(p.packageManager, "npm", "package-lock.json → npm");
		assert.equal(p.language, "TypeScript", ".ts files → TypeScript");
		assert.deepEqual(p.conventions, [], "detection never invents conventions");
		assert.deepEqual(p.facts, []);
		assert.ok(p.lastScanned > 0, "stamps a scan time");
		assert.equal(typeof p.fingerprint, "object");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reconcile refreshes detected fields while preserving stored research/conventions", () => {
	const dir = fixtureProject();
	try {
		const stored: ProjectMemory = {
			...detectProject(dir),
			language: "JavaScript", // stale — reconcile should re-detect TypeScript
			conventions: ["use tabs"],
			facts: [{ scope: "project", text: "deploys on Fly.io", createdAt: 1, updatedAt: 1 }],
			research: { key: { value: "OAuth via Auth0", timestamp: 5 } },
			lastModified: 9,
		};
		const merged = reconcile(dir, stored);
		assert.equal(merged.language, "TypeScript", "detected field refreshed");
		assert.deepEqual(merged.conventions, ["use tabs"], "manual conventions preserved");
		assert.deepEqual(merged.research, stored.research, "quest research preserved");
		assert.equal(merged.lastModified, 9, "lastModified preserved");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
