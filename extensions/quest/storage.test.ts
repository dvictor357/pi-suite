import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	emptyQuest,
	listArchives,
	loadAgentModels,
	loadModelLadder,
	loadQuest,
	rememberAgentModel,
	rememberModelLadder,
	saveQuest,
} from "./storage";
import type { SandboxPolicy } from "./types";
import { projectMemoryPath, questActivePath, readJSON, writeJSON } from "./utils";

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

test("loadQuest archives and clears a stale finished active quest", () => {
	const cwd = tempCwd();
	const quest = emptyQuest("Finished quest", "archive stale completion");
	quest.status = "active";
	quest.steps = [
		{
			content: "done step",
			status: "done",
			agent: "worker",
			context: "",
			dependencies: [],
			result: "done",
			attempts: 1,
			startedAt: 1,
			completedAt: 2,
			verified: true,
			verifyResult: "PASS",
			verifyRetries: 0,
			commitHash: null,
			branchName: null,
		},
	];
	saveQuest(quest, cwd);

	assert.equal(loadQuest(cwd), null);
	assert.equal(existsSync(questActivePath(cwd)), false);
	assert.equal(listArchives(1, cwd)[0]?.name, "Finished quest");
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

test("loadQuest defaults ladder fields on legacy steps and round-trips populated ones", () => {
	const cwd = tempCwd();
	const quest = emptyQuest("Ladder fields", "round-trip", undefined, "auto", true);
	quest.steps = [
		{
			content: "Legacy step",
			status: "pending",
			agent: "worker",
			context: "",
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
		{
			content: "Laddered step",
			status: "running",
			agent: "worker",
			context: "",
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
			rung: 1,
			escalations: 1,
			lastModel: "ornith-1.0",
			failureBriefs: [
				{
					attempt: 1,
					model: "ornith-1.0",
					rung: 0,
					evidence: "tests fail",
					attempted: "edited foo.ts",
					inferred: true,
					timestamp: 42,
				},
				// Garbage entry a hand-edit could introduce — must be dropped, not crash.
				{ attempted: "no evidence" } as never,
			],
		},
	];
	saveQuest(quest, cwd);

	const loaded = loadQuest(cwd);
	const legacy = loaded!.steps[0];
	assert.equal(legacy.rung, undefined, "legacy step stays un-laddered");
	assert.equal(legacy.escalations, 0);
	assert.deepEqual(legacy.failureBriefs, []);
	assert.equal(legacy.lastModel, undefined);

	const laddered = loaded!.steps[1];
	assert.equal(laddered.rung, 1);
	assert.equal(laddered.escalations, 1);
	assert.equal(laddered.lastModel, "ornith-1.0");
	assert.equal(laddered.failureBriefs?.length, 1, "malformed brief dropped");
	assert.equal(laddered.failureBriefs?.[0].evidence, "tests fail");
	assert.equal(laddered.failureBriefs?.[0].inferred, true);
});

test("rememberModelLadder round-trips via loadModelLadder and preserves other memory fields", () => {
	const cwd = tempCwd();
	writeJSON(projectMemoryPath(cwd), {
		name: "proj",
		conventions: ["use tabs"],
		agentModels: { scout: { model: "flash", timestamp: 1 } },
	});

	assert.equal(loadModelLadder(cwd), null, "no ladder approved yet");

	rememberModelLadder(cwd, {
		rungs: ["ornith-1.0", "mythos-5"],
		roles: ["worker"],
		approvedAt: 123,
		reason: "cheap first",
	});

	const ladder = loadModelLadder(cwd);
	assert.deepEqual(ladder?.rungs, ["ornith-1.0", "mythos-5"]);
	assert.deepEqual(ladder?.roles, ["worker"]);
	assert.equal(ladder?.approvedAt, 123);

	const onDisk = readJSON<Record<string, unknown>>(projectMemoryPath(cwd), {});
	assert.deepEqual(onDisk.conventions, ["use tabs"], "read-merge-write keeps memory's fields");
	assert.ok(onDisk.agentModels, "agentModels untouched");
});

test("rememberAgentModel round-trips an optional thinking level and ignores invalid disk values", () => {
	const cwd = tempCwd();
	rememberAgentModel(cwd, "worker", {
		model: "gpt-5.6-sol",
		provider: "openai",
		thinkingLevel: "medium",
		timestamp: 123,
	});

	assert.deepEqual(loadAgentModels(cwd).worker, {
		model: "gpt-5.6-sol",
		provider: "openai",
		thinkingLevel: "medium",
		reason: undefined,
		timestamp: 123,
	});

	writeJSON(projectMemoryPath(cwd), {
		agentModels: {
			worker: { model: "gpt-5.6-sol", thinkingLevel: "extreme", timestamp: 124 },
		},
	});
	assert.equal(loadAgentModels(cwd).worker?.thinkingLevel, undefined);
});

test("loadModelLadder rejects malformed ladders and a future contract", () => {
	const cwd = tempCwd();
	writeJSON(projectMemoryPath(cwd), { modelLadder: { rungs: ["  ", 42], approvedAt: 1 } });
	assert.equal(loadModelLadder(cwd), null, "no usable rungs → no ladder");

	writeJSON(projectMemoryPath(cwd), {
		contractVersion: 999,
		modelLadder: { rungs: ["ornith-1.0"], approvedAt: 1 },
	});
	assert.equal(loadModelLadder(cwd), null, "future contract is refused, not misread");
});
