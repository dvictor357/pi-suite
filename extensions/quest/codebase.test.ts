import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildVerificationImpactContext,
	CODEBASE_CACHE_PATH,
	enrichPlanningContext,
	hasCodebaseCache,
	hasCodebaseTool,
	impactCodebaseFile,
	loadCodebaseIndex,
	mapCodebaseFile,
	queryCodebaseIndex,
} from "./codebase";
import type { QuestTask } from "./types";

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

function task(overrides: Partial<QuestTask> = {}): QuestTask {
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

	const tasks = [task()];
	const result = enrichPlanningContext(tasks, "improve foo", cwd);
	// Tasks are returned untouched (no enrichment from an unreadable cache)...
	assert.equal(result.cache.status, "future");
	assert.deepEqual(result.enrichedTasks, tasks);
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
