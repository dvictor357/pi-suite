import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateToolCall } from "./sandbox-guard";
import { resolveSandboxProfile } from "./sandbox";
import type { SandboxPolicy } from "./types";

function profile(overrides: Partial<SandboxPolicy> = {}) {
	return resolveSandboxProfile({
		mode: "restricted",
		allowedPaths: [],
		deniedPaths: [],
		allowCommands: [],
		denyCommands: [],
		allowNetwork: true,
		allowPackageInstall: true,
		worktree: null,
		...overrides,
	});
}

test("sandbox off (mode none) never blocks", () => {
	const p = resolveSandboxProfile(); // DEFAULT = mode none
	assert.equal(evaluateToolCall(p, "bash", { command: "rm -rf /" }).block, false);
	assert.equal(evaluateToolCall(p, "write", { path: ".env" }).block, false);
});

test("blocks writes to built-in sensitive globs (.env, keys)", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "write", { path: ".env" }).block, true);
	assert.equal(evaluateToolCall(p, "edit", { path: "config/.env.local" }).block, true);
	assert.equal(evaluateToolCall(p, "write", { path: "deploy/id_rsa" }).block, true);
	assert.equal(evaluateToolCall(p, "write", { file_path: "secrets.json" }).block, true);
});

test("blocks writes to explicit denied globs", () => {
	const p = profile({ deniedPaths: ["src/generated/**"] });
	assert.equal(evaluateToolCall(p, "edit", { path: "src/generated/api.ts" }).block, true);
	assert.equal(evaluateToolCall(p, "edit", { path: "src/app.ts" }).block, false);
});

test("blocks writes outside a non-empty allow-list", () => {
	const p = profile({ allowedPaths: ["src/**", "test/**"] });
	assert.equal(evaluateToolCall(p, "write", { path: "src/a.ts" }).block, false);
	assert.equal(evaluateToolCall(p, "write", { path: "docs/readme.md" }).block, true);
});

test("empty allow-list does not block ordinary writes (only denies do)", () => {
	const p = profile({ allowedPaths: [] });
	assert.equal(evaluateToolCall(p, "write", { path: "anything.ts" }).block, false);
});

test("blocks destructive bash commands", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "bash", { command: "rm -rf build" }).block, true);
	assert.equal(evaluateToolCall(p, "bash", { command: "git reset --hard HEAD~1" }).block, true);
});

test("network / package-install gated by policy flags", () => {
	assert.equal(
		evaluateToolCall(profile({ allowNetwork: false }), "bash", { command: "curl https://x" }).block,
		true,
	);
	assert.equal(
		evaluateToolCall(profile({ allowNetwork: true }), "bash", { command: "curl https://x" }).block,
		false,
	);
	assert.equal(
		evaluateToolCall(profile({ allowPackageInstall: false }), "bash", { command: "npm install" })
			.block,
		true,
	);
});

test("denyCommands substring patterns block", () => {
	const p = profile({ denyCommands: ["psql"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "psql -c 'drop table'" }).block, true);
	assert.equal(evaluateToolCall(p, "bash", { command: "echo hi" }).block, false);
});

test("allowCommands allow-list blocks commands with no matching prefix", () => {
	const p = profile({ allowCommands: ["npm test", "ls"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "npm test --watch" }).block, false);
	assert.equal(evaluateToolCall(p, "bash", { command: "ls -la" }).block, false);
	assert.equal(evaluateToolCall(p, "bash", { command: "echo nope" }).block, true);
});

test("non-write / non-shell tools are never blocked", () => {
	const p = profile({ deniedPaths: ["**/*"] });
	assert.equal(evaluateToolCall(p, "read", { path: ".env" }).block, false);
	assert.equal(evaluateToolCall(p, "grep", { pattern: "x" }).block, false);
});
