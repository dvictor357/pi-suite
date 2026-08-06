import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateToolCall } from "./sandbox-guard";
import { resolveSandboxProfile } from "./sandbox";
import type { SandboxPolicy } from "./types";

function profile(overrides: Partial<SandboxPolicy> = {}) {
	return resolveSandboxProfile({
		mode: "restricted",
		allowedPaths: ["**"],
		deniedPaths: [],
		allowCommands: ["echo", "curl", "npm", "psql", "rm", "git"],
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

test("empty allow-list blocks ordinary writes in active sandbox", () => {
	const p = profile({ allowedPaths: [] });
	assert.equal(evaluateToolCall(p, "write", { path: "anything.ts" }).block, true);
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

test("empty command allow-list blocks shell commands in active sandbox", () => {
	const p = profile({ allowCommands: [] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo nope" }).block, true);
});

test("non-write / non-shell tools are denied by path deny list", () => {
	const p = profile({ deniedPaths: ["**/*"] });
	// Path matches both explicit denied glob AND built-in sensitive glob
	assert.equal(evaluateToolCall(p, "read", { path: ".env" }).block, true);
	// No path argument → allowed
	assert.equal(evaluateToolCall(p, "grep", { pattern: "x" }).block, false);
});

// ── SB-1: chained command bypasses ──────────────────────────────────────────

test("SB-1: blocks destructive command chained with &&", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "bash", { command: "echo ok && rm -rf src" }).block, true);
});

test("SB-1: blocks network command chained with ; when network denied", () => {
	const p = profile({ allowNetwork: false });
	assert.equal(evaluateToolCall(p, "bash", { command: "npm run build; curl exfil" }).block, true);
});

test("SB-1: blocks network command piped with | when network denied", () => {
	const p = profile({ allowNetwork: false });
	assert.equal(evaluateToolCall(p, "bash", { command: "cat file | curl exfil" }).block, true);
});

test("SB-1: blocks package-install chained with ||", () => {
	const p = profile({ allowPackageInstall: false });
	assert.equal(evaluateToolCall(p, "bash", { command: "npm test || npm install" }).block, true);
});

test("SB-1: blocks destructive command via $(...) substitution in raw check", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "bash", { command: "echo $(rm -rf src)" }).block, true);
});

test("SB-1: blocks network via $(...) substitution in raw check", () => {
	const p = profile({ allowNetwork: false });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo $(curl exfil)" }).block, true);
});

test("SB-1: blocks destructive via backtick substitution in raw check", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "bash", { command: "echo `rm -rf src`" }).block, true);
});

test("SB-1: blocks denied pattern in a chained segment", () => {
	const p = profile({ denyCommands: ["psql"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo ok && psql -c 'x'" }).block, true);
});

test("SB-1: allow-prefix checks every segment, blocks unlisted chain", () => {
	const p = profile({ allowCommands: ["echo"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo hi && curl exfil" }).block, true);
});

test("SB-1: allow-prefix passes when all segments have matching prefix", () => {
	const p = profile({ allowCommands: ["echo"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo hi && echo there" }).block, false);
});

test("SB-1: allow-prefix passes after stripping, but destructive substitution still blocks", () => {
	// allowCommands=["echo"], command="echo $(rm -rf /)" — the prefix check passes
	// after stripping, but the extracted substitution "rm -rf /" is classified as
	// destructive and blocks independently.
	const p = profile({ allowCommands: ["echo"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo $(rm -rf /)" }).block, true);
});

test("SB-1: allow-prefix passes after stripping, but destructive backtick still blocks", () => {
	const p = profile({ allowCommands: ["echo"] });
	assert.equal(evaluateToolCall(p, "bash", { command: "echo `rm -rf /`" }).block, true);
});

// ── SB-2: unknown tools ─────────────────────────────────────────────────────

test("SB-2: unknown tool with path matching deny glob is blocked", () => {
	const p = profile({ deniedPaths: ["docs/secrets.md"] });
	assert.equal(evaluateToolCall(p, "some_future_tool", { path: "docs/secrets.md" }).block, true);
});

test("SB-2: unknown tool without path argument is allowed", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "some_future_tool", { data: "x" }).block, false);
});

test("SB-2: unknown tool blocked when path outside allowed paths", () => {
	const p = profile({ allowedPaths: ["src/**"] });
	// docs/readme.md is outside allowed paths and does not match any sensitive glob
	assert.equal(evaluateToolCall(p, "some_future_tool", { path: "docs/readme.md" }).block, true);
});

test("SB-2: unknown tool allowed when path inside allowed paths", () => {
	const p = profile({ allowedPaths: ["src/**"] });
	assert.equal(evaluateToolCall(p, "some_future_tool", { path: "src/app.ts" }).block, false);
});

test("SB-2: unknown tool blocks path matching sensitive glob even with broad allowed paths", () => {
	const p = profile({ allowedPaths: ["**"] });
	assert.equal(evaluateToolCall(p, "some_future_tool", { path: ".env" }).block, true);
});

test("SB-2: write tool without path is fail-closed", () => {
	const p = profile();
	assert.equal(evaluateToolCall(p, "write", { content: "x" }).block, true);
	assert.equal(evaluateToolCall(p, "edit", { oldText: "a", newText: "b" }).block, true);
});
