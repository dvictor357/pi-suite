import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemory } from "../../core";
import { reconcileProfile } from "./profile";

function stored(): ProjectMemory {
	return {
		name: "my-proj",
		packageManager: "npm",
		language: "JavaScript", // stale — should be overwritten by detection
		framework: null,
		designSystem: null,
		buildTool: null,
		testRunner: null,
		linter: null,
		formatter: null,
		monorepo: false,
		directoryPattern: null,
		conventions: ["use tabs", "no default exports"],
		facts: [{ scope: "project", text: "deploys on Fly.io", createdAt: 1, updatedAt: 1 }],
		lastScanned: 1000,
		fingerprint: { "package.json": 111 },
		// Written by pi-quest — pi-memory must preserve these across a rescan.
		research: {
			"auth-flow": { value: "OAuth via Auth0", category: "security", timestamp: 5000 },
		},
		lastModified: 9000,
	};
}

function fresh(): ProjectMemory {
	return {
		name: "my-proj",
		packageManager: "pnpm", // detection found a new lock file
		language: "TypeScript", // detection corrected the language
		framework: "Next.js",
		designSystem: null,
		buildTool: "vite",
		testRunner: "vitest",
		linter: "eslint",
		formatter: "prettier",
		monorepo: true,
		directoryPattern: "src/",
		conventions: [], // detectProject always returns empty here
		facts: [],
		lastScanned: 2000,
		fingerprint: { "package.json": 222, "pnpm-lock.yaml": 333 },
	};
}

test("reconcileProfile preserves quest's research and lastModified across a rescan", () => {
	const merged = reconcileProfile(stored(), fresh());
	assert.deepEqual(merged.research, stored().research, "research must survive a rescan");
	assert.equal(merged.lastModified, 9000, "lastModified must survive a rescan");
});

test("reconcileProfile preserves manually-set conventions and facts", () => {
	const merged = reconcileProfile(stored(), fresh());
	assert.deepEqual(merged.conventions, ["use tabs", "no default exports"]);
	assert.deepEqual(merged.facts, stored().facts);
});

test("reconcileProfile overwrites detected tech-stack fields with the fresh scan", () => {
	const merged = reconcileProfile(stored(), fresh());
	assert.equal(merged.language, "TypeScript");
	assert.equal(merged.packageManager, "pnpm");
	assert.equal(merged.framework, "Next.js");
	assert.equal(merged.monorepo, true);
	assert.equal(merged.directoryPattern, "src/");
	assert.deepEqual(merged.fingerprint, { "package.json": 222, "pnpm-lock.yaml": 333 });
	assert.equal(merged.lastScanned, 2000, "scan timestamp advances to the fresh scan");
});

test("reconcileProfile does not mutate its inputs", () => {
	const s = stored();
	const f = fresh();
	reconcileProfile(s, f);
	assert.equal(s.language, "JavaScript", "stored input untouched");
	assert.equal(f.conventions.length, 0, "fresh input untouched");
});
