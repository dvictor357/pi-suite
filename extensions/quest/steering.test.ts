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
