import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyQuest, loadQuest, saveQuest } from "./storage";
import type { SandboxPolicy } from "./types";
import { questActivePath, writeJSON } from "./utils";

const tempCwd = (): string => mkdtempSync(join(tmpdir(), "pi-suite-quest-storage-"));

test("loadQuest defaults sandboxed network/package install permissions to false", () => {
	const cwd = tempCwd();
	const sandbox = {
		mode: "restricted",
		allowedPaths: ["extensions/**"],
		deniedPaths: [],
		allowCommands: [],
		denyCommands: [],
		worktree: null,
	} as unknown as SandboxPolicy;

	const quest = emptyQuest(
		"Sandbox defaults",
		"check defaults",
		undefined,
		"auto",
		true,
		undefined,
		sandbox,
	);
	saveQuest(quest, cwd);

	const loaded = loadQuest(cwd);
	assert.equal(loaded?.sandbox?.mode, "restricted");
	assert.equal(loaded?.sandbox?.allowNetwork, false);
	assert.equal(loaded?.sandbox?.allowPackageInstall, false);
});

test("loadQuest defaults non-sandbox network/package install permissions to true", () => {
	const cwd = tempCwd();
	const sandbox = {
		mode: "none",
		allowedPaths: [],
		deniedPaths: [],
		allowCommands: [],
		denyCommands: [],
		worktree: null,
	} as unknown as SandboxPolicy;

	const quest = emptyQuest(
		"No sandbox",
		"check defaults",
		undefined,
		"auto",
		true,
		undefined,
		sandbox,
	);
	// Force a legacy-ish stored policy through the active file so loadQuest normalizes it.
	quest.sandbox = sandbox;
	saveQuest(quest, cwd);

	const loaded = loadQuest(cwd);
	assert.equal(loaded?.sandbox?.mode, "none");
	assert.equal(loaded?.sandbox?.allowNetwork, true);
	assert.equal(loaded?.sandbox?.allowPackageInstall, true);
});

test("loadQuest migrates legacy tasks to steps and saveQuest writes a legacy tasks mirror", () => {
	const cwd = tempCwd();
	writeJSON(questActivePath(cwd), {
		version: 1,
		name: "Legacy quest",
		goal: "load old shape",
		status: "active",
		tasks: [
			{
				content: "Legacy step",
				status: "pending",
				agent: "worker",
				context: "legacy context",
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
			},
		],
		tasksSincePause: 2,
		lastFiredTaskIndex: 0,
		sameTaskCount: 1,
		conventions: [],
		commits: [{ taskIndex: 0, hash: "abc123", message: "legacy commit", timestamp: 1 }],
		planningMode: "auto",
		planApproved: true,
		verifyOnComplete: true,
		createdAt: 1,
		completedAt: null,
		updatedAt: 1,
	});

	const loaded = loadQuest(cwd);
	assert.equal(loaded?.steps.length, 1);
	assert.equal(loaded?.steps[0].content, "Legacy step");
	assert.equal(loaded?.stepsSincePause, 2);
	assert.equal(loaded?.lastFiredStepIndex, 0);
	assert.equal(loaded?.sameStepCount, 1);
	assert.equal(loaded?.commits[0].stepIndex, 0);

	loaded!.steps[0].content = "Canonical step";
	saveQuest(loaded!, cwd);
	const saved = JSON.parse(readFileSync(questActivePath(cwd), "utf8"));
	assert.equal(saved.steps[0].content, "Canonical step");
	assert.equal(saved.tasks[0].content, "Canonical step");
	assert.equal(saved.tasksSincePause, saved.stepsSincePause);
	assert.equal(saved.lastFiredTaskIndex, saved.lastFiredStepIndex);
	assert.equal(saved.sameTaskCount, saved.sameStepCount);
	assert.equal(saved.commits[0].taskIndex, saved.commits[0].stepIndex);
});
