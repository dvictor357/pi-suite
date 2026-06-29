import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyQuest, loadQuest, saveQuest } from "./storage";
import type { SandboxPolicy } from "./types";

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
