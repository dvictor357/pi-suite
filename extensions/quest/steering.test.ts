import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSteeringMessage, wasTurnAborted } from "./steering";
import { emptyQuest, rememberAgentModel } from "./storage";
import type { QuestStep } from "./types";
import { projectMemoryPath } from "./utils";

describe("wasTurnAborted", () => {
	test("true when the final assistant turn was aborted (Esc)", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", stopReason: "aborted", content: [] },
		];
		assert.equal(wasTurnAborted(messages), true);
	});

	test("false for a normally completed turn", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", stopReason: "stop", content: [] },
		];
		assert.equal(wasTurnAborted(messages), false);
	});

	test("false for a turn that ended on tool use", () => {
		assert.equal(wasTurnAborted([{ role: "assistant", stopReason: "toolUse" }]), false);
	});

	test("inspects the last assistant message, not trailing tool results", () => {
		const messages = [
			{ role: "assistant", stopReason: "aborted" },
			{ role: "toolResult", content: "…" },
		];
		assert.equal(wasTurnAborted(messages), true);
	});

	test("ignores non-assistant messages with no stopReason", () => {
		assert.equal(wasTurnAborted([{ role: "user", content: "hi" }]), false);
	});

	test("safe on empty / undefined input", () => {
		assert.equal(wasTurnAborted([]), false);
		assert.equal(wasTurnAborted(undefined), false);
	});
});

test("buildSteeringMessage delegates the current step through pi-minions", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-suite-minion-steering-"));
	try {
		rememberAgentModel(cwd, "worker", {
			model: "gpt-5.6-sol",
			thinkingLevel: "medium",
			timestamp: 1,
		});
		const quest = emptyQuest("Minion routing", "route work through pi-minions");
		const step: QuestStep = {
			content: "Implement the parser",
			status: "running",
			agent: "worker",
			model: "gpt-5.6-sol",
			context: "Preserve the public API",
			dependencies: [],
			result: null,
			attempts: 1,
			startedAt: Date.now(),
			completedAt: null,
			verified: false,
			verifyResult: null,
			verifyRetries: 0,
			commitHash: null,
			branchName: null,
		};
		quest.steps = [step];

		const message = buildSteeringMessage(quest, step, 0, cwd);

		assert.match(message, /subagent\(agent="worker"/);
		assert.match(message, /model="gpt-5\.6-sol"/);
		assert.match(message, /thinking="medium"/);
		assert.doesNotMatch(message, /quest_delegate\(index=0\)/);
	} finally {
		rmSync(projectMemoryPath(cwd), { force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("buildSteeringMessage keeps sandboxed steps on the guarded Quest fallback", () => {
	const quest = emptyQuest("Guarded routing", "preserve sandbox enforcement");
	quest.sandbox = {
		mode: "restricted",
		allowedPaths: ["extensions/**"],
		deniedPaths: [],
		allowCommands: ["npm test"],
		denyCommands: [],
		allowNetwork: false,
		allowPackageInstall: false,
		worktree: null,
	};
	const step: QuestStep = {
		content: "Implement safely",
		status: "running",
		agent: "worker",
		model: "gpt-5.6-sol",
		context: "Stay in extensions",
		dependencies: [],
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [step];

	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	assert.match(message, /quest_delegate\(index=0\)/);
	assert.match(message, /pi-minions does not enforce this policy yet/);
	assert.doesNotMatch(message, /subagent\(agent="worker"/);
});

test("buildSteeringMessage minionTask contains actual step content, not a generic reference", () => {
	const quest = emptyQuest("Content test", "verify minion task");
	const step: QuestStep = {
		content: "Write the authentication middleware",
		status: "running",
		agent: "worker",
		model: "claude-opus-4-5",
		context: "Use JWT tokens with refresh support",
		dependencies: [],
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [step];

	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	// The minion task must contain actual step content.
	assert.match(message, /Write the authentication middleware/);
	// The minion task must contain the step context.
	assert.match(message, /Use JWT tokens with refresh support/);
	// Must NOT contain the old generic reference.
	assert.doesNotMatch(message, /Execute the current Quest step using the full step, context/);
	// Must still include the subagent call suggestion.
	assert.match(message, /subagent\(agent="worker"/);
});

test("buildSteeringMessage minionTask includes dependency results, not unrelated step content", () => {
	const quest = emptyQuest("Dependency test", "verify dep handoffs");
	const scoutStep: QuestStep = {
		content: "Scout the codebase for auth patterns",
		status: "done",
		agent: "scout",
		context: "Look for existing auth modules",
		dependencies: [],
		result: "Found AuthService in src/auth/service.ts with JWT helpers",
		attempts: 1,
		startedAt: Date.now() - 10000,
		completedAt: Date.now(),
		verified: true,
		verifyResult: "pass",
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	const unrelatedStep: QuestStep = {
		content: "Update the README with contribution guide",
		status: "done",
		agent: "worker",
		context: "Add PR checklist",
		dependencies: [],
		result: "README updated with sections on setup, testing, and PR process",
		attempts: 1,
		startedAt: Date.now() - 5000,
		completedAt: Date.now() - 4000,
		verified: true,
		verifyResult: "pass",
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	const workerStep: QuestStep = {
		content: "Implement the new auth middleware",
		status: "running",
		agent: "worker",
		context: "Wire up the JWT helpers from the scout",
		dependencies: [0], // depends only on scoutStep (index 0)
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [scoutStep, unrelatedStep, workerStep];

	const message = buildSteeringMessage(quest, workerStep, 2, process.cwd());

	// Dependency result must be present — the sub-agent needs to build on prior work.
	assert.match(message, /Prior results you can build on/);
	assert.match(message, /Scout the codebase for auth patterns/);
	assert.match(message, /Found AuthService in src\/auth\/service\.ts with JWT helpers/);
	// Unrelated step content must NOT leak into the minion task — only deps should appear.
	assert.doesNotMatch(message, /Update the README/);
	assert.doesNotMatch(message, /contribution guide/);
	// Steering overview may mention unrelated deps in the Depends on line — but the
	// minion task (the subagent() task=...) must not carry unrelated results.
	// The Depends on line only lists dep names, not the unrelated step.
	assert.match(message, /Depends on.*#1 — Scout the codebase/);
	assert.doesNotMatch(message, /Depends on.*Update the README/);
});

test("buildSteeringMessage minionTask omits empty dependency result sections", () => {
	const quest = emptyQuest("No deps", "no prior results");
	const step: QuestStep = {
		content: "A standalone step",
		status: "running",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [step];

	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	// No dependencies → no Prior results section.
	assert.doesNotMatch(message, /Prior results you can build on/);
	// No context → no Context section in the minion task.
	// The steering message itself shows Context: but the minion task should not have a context block.
	// (We verify by absence of the ## Context header inside the task parameter.)
});

test("buildSteeringMessage minionTask includes sandbox constraints when active", () => {
	const quest = emptyQuest("Sandbox test", "verify constraints in minion task");
	quest.sandbox = {
		mode: "restricted",
		allowedPaths: ["src/**"],
		deniedPaths: ["src/secrets/**"],
		allowCommands: ["npm test", "npm run build"],
		denyCommands: ["rm -rf"],
		allowNetwork: false,
		allowPackageInstall: false,
		worktree: null,
	};
	const step: QuestStep = {
		content: "Add user auth",
		status: "running",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [step];

	// Sanboxed steps route through quest_delegate, so the minion task constraint
	// appears in the steering message context, not in a subagent() call.
	// But the buildSteeringMessage still computes the sandbox constraint block.
	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	// The steering message marks the sandbox and routes to quest_delegate.
	assert.match(message, /quest_delegate\(index=0\)/);
	assert.match(message, /pi-minions does not enforce this policy yet/);
});

test("buildSteeringMessage preserves legacy quest_delegate path for sandboxed steps", () => {
	const quest = emptyQuest("Legacy guard", "preserve sandbox enforcement");
	quest.sandbox = {
		mode: "restricted",
		allowedPaths: ["extensions/**"],
		deniedPaths: [],
		allowCommands: ["npm test"],
		denyCommands: [],
		allowNetwork: false,
		allowPackageInstall: false,
		worktree: null,
	};
	const step: QuestStep = {
		content: "Implement safely",
		status: "running",
		agent: "worker",
		model: "gpt-5.6-sol",
		context: "Stay in extensions",
		dependencies: [],
		result: null,
		attempts: 1,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
	};
	quest.steps = [step];

	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	assert.match(message, /quest_delegate\(index=0\)/);
	assert.match(message, /pi-minions does not enforce this policy yet/);
	assert.doesNotMatch(message, /subagent\(agent="worker"/);
});

test("buildSteeringMessage parent omits brief/awareness/format; minion task keeps them", () => {
	const quest = emptyQuest("Slim steer", "no double injection");
	const step: QuestStep = {
		content: "Fix the flaky parser",
		status: "running",
		agent: "worker",
		model: "claude-opus-4-5",
		context: "Keep public API stable",
		dependencies: [],
		result: null,
		attempts: 2,
		startedAt: Date.now(),
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
		failureBriefs: [
			{
				attempt: 1,
				model: "claude-haiku-4-5",
				evidence: "tests fail on empty input in parseTokens",
				attempted: "added null guard only",
				inferred: false,
				timestamp: Date.now() - 1000,
			},
		],
	};
	quest.steps = [step];

	const message = buildSteeringMessage(quest, step, 0, process.cwd());

	// Parent keeps progress / model / quest_update instructions.
	assert.match(message, /## Quest: Slim steer/);
	assert.match(message, /\*\*Current step:\*\* Fix the flaky parser/);
	assert.match(message, /quest_update/);
	assert.match(message, /subagent\(agent="worker"/);

	// Extract parent body vs the JSON-encoded minion task payload.
	const taskMatch = message.match(/task=("(?:\\.|[^"\\])*")/);
	assert.ok(taskMatch, "expected minion task= JSON in subagent call");
	const minionTask = JSON.parse(taskMatch![1]) as string;

	// Parent must NOT dump failure briefs, project awareness, or format directive.
	const parentOnly = message.slice(0, message.indexOf("task="));
	assert.doesNotMatch(parentOnly, /Prior failed attempts/);
	assert.doesNotMatch(parentOnly, /parseTokens/);
	assert.doesNotMatch(parentOnly, /## Project Awareness/);
	assert.doesNotMatch(parentOnly, /Before marking a code step done/);
	assert.doesNotMatch(parentOnly, /Before done:/);

	// Child minion task still carries full buildStepContext content.
	assert.match(minionTask, /Fix the flaky parser/);
	assert.match(minionTask, /Keep public API stable/);
	assert.match(minionTask, /Prior failed attempts/);
	assert.match(minionTask, /parseTokens/);
	assert.match(minionTask, /Completion schema/);
	// Format directive (full or compact) appears in the child task.
	assert.match(minionTask, /Before (marking a code step done|done):/);
});
