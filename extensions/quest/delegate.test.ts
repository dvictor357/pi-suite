import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	toolsForRole,
	resolveTaskModel,
	extractFinalText,
	buildSubAgentPrompt,
	buildSandboxConstraintBlock,
} from "./delegate";
import type { SandboxProfile } from "./sandbox";

test("toolsForRole gives read-only scopes exploratory/judging roles", () => {
	for (const role of ["scout", "verifier", "reviewer", "planner", "SCOUT", " Reviewer "]) {
		const tools = toolsForRole(role);
		assert.ok(!tools.includes("edit"), `${role} should not edit`);
		assert.ok(!tools.includes("write"), `${role} should not write`);
		assert.ok(!tools.includes("bash"), `${role} should not run bash`);
		assert.ok(tools.includes("read"), `${role} should read`);
	}
});

test("toolsForRole gives a full scope to implementing roles", () => {
	const tools = toolsForRole("worker");
	for (const t of ["read", "bash", "edit", "write"]) {
		assert.ok(tools.includes(t), `worker should have ${t}`);
	}
});

test("toolsForRole returns a fresh array (no shared mutable state)", () => {
	const a = toolsForRole("worker");
	a.push("danger");
	assert.ok(!toolsForRole("worker").includes("danger"));
});

test("resolveTaskModel precedence: task model wins", () => {
	assert.deepEqual(resolveTaskModel({ taskModel: "gpt-5", rememberedModel: "claude-opus-4-5" }), {
		model: "gpt-5",
		needsPrompt: false,
	});
});

test("resolveTaskModel precedence: remembered model when task has none", () => {
	assert.deepEqual(resolveTaskModel({ rememberedModel: "claude-opus-4-5" }), {
		model: "claude-opus-4-5",
		needsPrompt: false,
	});
});

test("resolveTaskModel needs a prompt when nothing is known", () => {
	assert.deepEqual(resolveTaskModel({}), { needsPrompt: true });
	assert.deepEqual(resolveTaskModel({ taskModel: "  ", rememberedModel: "" }), {
		needsPrompt: true,
	});
});

test("extractFinalText reads the last assistant message's text blocks", () => {
	const messages = [
		{ role: "user", content: "do the thing" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Part one. " },
				{ type: "text", text: "Part two." },
			],
		},
	];
	assert.equal(extractFinalText(messages), "Part one. Part two.");
});

test("extractFinalText ignores tool-result messages after the assistant turn", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
	];
	assert.equal(extractFinalText(messages), "final answer");
});

test("extractFinalText handles string content and empty input", () => {
	assert.equal(extractFinalText([{ role: "assistant", content: "plain string" }]), "plain string");
	assert.equal(extractFinalText([]), "");
	assert.equal(extractFinalText([{ role: "user", content: "no assistant here" }]), "");
});

test("buildSubAgentPrompt includes role, task, and context", () => {
	const prompt = buildSubAgentPrompt({
		role: "scout",
		content: "Map the auth module",
		context: "Focus on token refresh",
	});
	assert.match(prompt, /"scout" sub-agent/);
	assert.match(prompt, /Map the auth module/);
	assert.match(prompt, /Focus on token refresh/);
});

test("buildSubAgentPrompt leads with the persona when provided", () => {
	const prompt = buildSubAgentPrompt({
		role: "scout",
		content: "Map the auth module",
		persona: "# Scout\nYou recon code without mutating it.",
	});
	assert.match(prompt, /^# Scout\nYou recon code without mutating it\.\n\n---/);
	// persona precedes the role/task framing
	assert.ok(prompt.indexOf("# Scout") < prompt.indexOf('"scout" sub-agent'));
});

test("buildSubAgentPrompt omits the persona block when persona is blank", () => {
	const prompt = buildSubAgentPrompt({ role: "worker", content: "Do it", persona: "   " });
	assert.doesNotMatch(prompt, /---/);
	assert.match(prompt, /^You are a "worker" sub-agent/);
});

test("buildSubAgentPrompt omits empty optional sections", () => {
	const prompt = buildSubAgentPrompt({ role: "worker", content: "Do it" });
	assert.doesNotMatch(prompt, /## Context/);
	assert.doesNotMatch(prompt, /Prior results/);
});

// ── buildSandboxConstraintBlock ────────────────────────────────────────────

describe("buildSandboxConstraintBlock", () => {
	test("returns empty string when sandbox is off (mode none)", () => {
		assert.equal(buildSandboxConstraintBlock({ mode: "none" } as SandboxProfile), "");
		assert.equal(buildSandboxConstraintBlock(undefined), "");
	});

	test("returns empty string when profile is undefined", () => {
		assert.equal(buildSandboxConstraintBlock(undefined), "");
	});

	test("includes allowed paths in restricted mode", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**", "tests/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /## Sandbox Constraints/);
		assert.match(block, /\`src\/\*\*\`/);
		assert.match(block, /\`tests\/\*\*\`/);
	});

	test("shows deny-all for empty allowed paths in restricted mode", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: [],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /no file access permitted/);
	});

	test("includes denied paths in restricted mode", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: ["src/secrets/**", "*.key"],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /\`src\/secrets\/\*\*\`/);
		assert.match(block, /\`\*\.key\`/);
	});

	test("truncates long denied path lists", () => {
		const manyDenied = Array.from({ length: 10 }, (_, i) => `secret/file-${i}.key`);
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: manyDenied,
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /… and 2 more/);
	});

	test("shows allowed commands when present", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: ["npm test", "npm run build"],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /\`npm test\`/);
		assert.match(block, /\`npm run build\`/);
	});

	test("shows shell-deny message when allowCommands is empty in restricted mode", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /shell access is denied/);
	});

	test("shows denied commands when present", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: ["npm test"],
			denyCommands: ["rm -rf", "sudo"],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /\`rm -rf\`/);
		assert.match(block, /\`sudo\`/);
	});

	test("marks network as denied when false", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: false,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /Network access:.*denied/);
	});

	test("does not mention network when allowed", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.doesNotMatch(block, /Network access/);
	});

	test("marks package install as denied when false", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: false,
			worktree: null,
		});
		assert.match(block, /Package install:.*denied/);
	});

	test("includes worktree metadata in isolated mode", () => {
		const block = buildSandboxConstraintBlock({
			mode: "isolated",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: {
				enabled: true,
				baseBranch: "main",
				path: ".pi/worktrees/my-quest",
				autoCleanup: true,
			},
		});
		assert.match(block, /Worktree isolation/);
		assert.match(block, /main/);
		assert.match(block, /\.pi\/worktrees\/my-quest/);
	});

	test("ends with policy violation warning", () => {
		const block = buildSandboxConstraintBlock({
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});
		assert.match(block, /policy violation/);
	});
});

// ── buildSubAgentPrompt with sandbox ───────────────────────────────────────

test("buildSubAgentPrompt injects sandbox block when profile is provided", () => {
	const prompt = buildSubAgentPrompt({
		role: "worker",
		content: "Add user auth",
		sandboxProfile: {
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: false,
			allowPackageInstall: true,
			worktree: null,
		},
	});
	assert.match(prompt, /## Sandbox Constraints/);
	assert.match(prompt, /\`src\/\*\*\`/);
	assert.match(prompt, /Network access:.*denied/);
});

test("buildSubAgentPrompt omits sandbox block when profile is none mode", () => {
	const prompt = buildSubAgentPrompt({
		role: "worker",
		content: "Add user auth",
		sandboxProfile: { mode: "none" } as SandboxProfile,
	});
	assert.doesNotMatch(prompt, /Sandbox Constraints/);
});

test("buildSubAgentPrompt sandbox block appears after deps, before format", () => {
	const prompt = buildSubAgentPrompt({
		role: "worker",
		content: "Add user auth",
		dependencyResults: [{ content: "scout report", result: "auth in src/auth.ts" }],
		formatDirective: "Run the formatter.",
		sandboxProfile: {
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		},
	});
	const sandboxIdx = prompt.indexOf("Sandbox Constraints");
	const priorIdx = prompt.indexOf("Prior results");
	const formatIdx = prompt.indexOf("Run the formatter.");
	assert.ok(priorIdx < sandboxIdx, "sandbox should appear after prior results");
	assert.ok(sandboxIdx < formatIdx, "sandbox should appear before format directive");
});

test("buildSubAgentPrompt lists only dependencies that produced a result", () => {
	const prompt = buildSubAgentPrompt({
		role: "worker",
		content: "Wire it up",
		dependencyResults: [
			{ content: "design api", result: "REST with JWT" },
			{ content: "unfinished", result: null },
		],
		formatDirective: "Run the formatter.",
	});
	assert.match(prompt, /design api: REST with JWT/);
	assert.doesNotMatch(prompt, /unfinished/);
	assert.match(prompt, /Run the formatter\./);
});
