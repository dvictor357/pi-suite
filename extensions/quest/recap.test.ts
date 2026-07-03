import assert from "node:assert/strict";
import test from "node:test";
import { buildQuestRecap } from "./recap";
import type { Quest, QuestStep } from "./types";

function step(overrides: Partial<QuestStep>): QuestStep {
	return {
		content: "Do thing",
		status: "done",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 1,
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

function quest(overrides: Partial<Quest> = {}): Quest {
	return {
		version: 1,
		name: "Demo Quest",
		goal: "Make the terminal flow feel good",
		status: "done",
		steps: [step({ content: "Add recap", result: "Built a compact completion recap." })],
		stepsSincePause: 0,
		lastFiredStepIndex: -1,
		sameStepCount: 0,
		pauseReason: null,
		conventions: [],
		planningMode: "auto",
		planApproved: true,
		verifyOnComplete: true,
		commits: [],
		createdAt: 1_000,
		completedAt: 62_000,
		updatedAt: 62_000,
		...overrides,
	};
}

test("buildQuestRecap renders a completion scorecard and step results", () => {
	const text = buildQuestRecap(
		quest({
			steps: [
				step({ content: "Add recap", result: "Built it.\nExtra detail", verified: true }),
				step({ content: "Skip dashboard", status: "skipped" }),
			],
		}),
	);

	assert.match(text, /## Quest Recap: Demo Quest ✅/);
	assert.match(text, /1\/2 done, 1 skipped, 1 verified, 0 commit\(s\), 1m 1s elapsed/);
	assert.match(text, /✅ #1 \*\*Add recap\*\* — Built it\./);
	assert.match(text, /⏭️ #2 \*\*Skip dashboard\*\*/);
});

test("buildQuestRecap includes compact git and Auto-PR hints", () => {
	const text = buildQuestRecap(
		quest({
			gitIntegration: {
				autoCommit: true,
				autoBranch: true,
				autoPR: true,
				branchPrefix: "quest/",
			},
			commits: [
				{
					stepIndex: 0,
					hash: "abcdef123456",
					message: "feat: add quest recap",
					timestamp: 62_000,
				},
			],
		}),
	);

	assert.match(text, /### Git/);
	assert.match(text, /`abcdef12` feat: add quest recap/);
	assert.match(text, /Auto-PR enabled/);
});
