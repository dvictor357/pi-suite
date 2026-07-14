import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	buildStepContext,
	coerceStepHandoff,
	collectDependencyHandoffs,
	completionSchemaBlock,
	parseStepHandoff,
	persistHandoff,
} from "./context-broker";
import type { Quest, QuestStep, StepHandoff } from "./types";

const handoff = (summary: string): StepHandoff => ({
	version: 1,
	summary,
	filesChanged: ["src/auth.ts"],
	verification: ["npm test: passed"],
});

describe("structured handoffs", () => {
	test("parses fenced JSON and bounds untrusted fields", () => {
		const parsed = parseStepHandoff(
			`Done.\n\n\`\`\`json\n${JSON.stringify({
				summary: "implemented auth",
				filesChanged: [...Array.from({ length: 60 }, (_, i) => `src/${i}.ts`), 42],
				verification: ["npm test: passed", null],
				notes: "ready",
			})}\n\`\`\``,
		);
		assert.equal(parsed.summary, "implemented auth");
		assert.equal(parsed.filesChanged.length, 50);
		assert.deepEqual(parsed.verification, ["npm test: passed"]);
		assert.equal(parsed.notes, "ready");
	});

	test("preserves plain-text output compatibility with a bounded summary", () => {
		const parsed = parseStepHandoff("legacy prose result");
		assert.deepEqual(parsed, {
			version: 1,
			summary: "legacy prose result",
			filesChanged: [],
			verification: [],
		});
	});

	test("defensively coerces persisted data", () => {
		assert.equal(coerceStepHandoff(null), undefined);
		assert.equal(coerceStepHandoff({ summary: 3 }), undefined);
		assert.deepEqual(coerceStepHandoff({ summary: "ok", filesChanged: ["a.ts", 2] }), {
			version: 1,
			summary: "ok",
			filesChanged: ["a.ts"],
			verification: [],
		});
	});

	test("persists parsed data on the step without replacing the legacy result", () => {
		const step = { result: "legacy stored result" } as QuestStep;
		const quest = { steps: [step] } as Quest;
		persistHandoff(
			quest,
			0,
			'```json\n{"summary":"focused","filesChanged":[],"verification":[]}\n```',
		);
		assert.equal(step.result, "legacy stored result");
		assert.equal(step.handoff?.summary, "focused");
	});
});

describe("dependency context", () => {
	test("includes complete step context and only direct dependency handoffs", () => {
		const quest = {
			steps: [
				{
					content: "Scout auth",
					result: "large raw scout output",
					handoff: handoff("use AuthService"),
				},
				{ content: "Unrelated docs", result: "SECRET BULK", handoff: handoff("updated docs") },
				{ content: "Implement auth", dependencies: [0] },
			],
		} as unknown as Quest;
		const dependencies = collectDependencyHandoffs(quest, quest.steps[2]);
		const output = buildStepContext({
			role: "worker",
			content: "Implement auth",
			context: "Preserve refresh tokens",
			dependencyResults: dependencies,
			failureBriefBlock: "**Prior failed attempts — address these specifically:**\n- tests failed",
			sandboxProfile: {
				mode: "restricted",
				allowedPaths: ["src/**"],
				deniedPaths: ["src/secrets/**"],
				allowCommands: ["npm test"],
				denyCommands: [],
				allowNetwork: false,
				allowPackageInstall: false,
				worktree: null,
			},
			cwd: process.cwd(),
		});

		for (const required of [
			"Implement auth",
			"Preserve refresh tokens",
			"use AuthService",
			"src/auth.ts",
			"npm test: passed",
			"Prior failed attempts",
			"Sandbox Constraints",
			"src/**",
			"Project Awareness",
			"Completion schema",
			"filesChanged",
		]) {
			assert.match(output, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		assert.doesNotMatch(output, /Unrelated docs|SECRET BULK|large raw scout output/);
	});

	test("legacy result-only dependencies receive the prose fallback", () => {
		const quest = {
			steps: [
				{ content: "Legacy", result: "old plain result" },
				{ content: "Next", dependencies: [0] },
			],
		} as unknown as Quest;
		assert.equal(
			collectDependencyHandoffs(quest, quest.steps[1])[0].handoff.summary,
			"old plain result",
		);
	});
});

test("completion schema requests structured output while documenting compatibility", () => {
	const output = completionSchemaBlock();
	assert.match(output, /summary/);
	assert.match(output, /filesChanged/);
	assert.match(output, /verification/);
	assert.match(output, /plain prose remains accepted/);
});
