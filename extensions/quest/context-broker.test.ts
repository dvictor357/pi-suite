import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONTEXT_BUDGET, stepContextBudgetForModel } from "../../core";
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

describe("buildStepContext unified multi-block budget", () => {
	const longFailure = [
		"**Prior failed attempts — address these specifically:**",
		"- " + "x".repeat(200),
		"- " + "y".repeat(200),
	].join("\n");
	const longDeps = [
		{
			content: "Scout auth",
			handoff: {
				version: 1 as const,
				summary: "use AuthService with refresh tokens and " + "z".repeat(180),
				filesChanged: ["src/auth.ts"],
				verification: ["npm test: passed"],
			},
		},
	];

	test("keeps all sections under a large-model budget", () => {
		const output = buildStepContext({
			role: "worker",
			content: "Implement auth",
			context: "Preserve refresh tokens",
			dependencyResults: longDeps,
			failureBriefBlock: longFailure,
			modelInfo: { id: "claude-opus-4-8", contextWindow: 200000 },
			// Skip cwd so awareness is empty (no disk dependency).
		});
		assert.match(output, /Implement auth/);
		assert.match(output, /Prior failed attempts/);
		assert.match(output, /use AuthService/);
		assert.match(output, /Completion schema/);
		assert.ok(
			output.length <= stepContextBudgetForModel({ id: "claude-opus-4-8", contextWindow: 200000 }),
		);
	});

	test("with tiny contextWindow drops format then awareness before task", () => {
		// Force a very small multi-block budget so lower-priority sections must go.
		const tiny = {
			id: "tiny-local",
			contextWindow: 1, // triggers low-context scale
		};
		// Override via model scale alone is still floored at minBudget (400). Build
		// sections larger than that so drops are forced. Inject long optional blocks.
		const fatFailure = "**Prior failed attempts:**\n" + "line of failure detail\n".repeat(40);
		const fatDeps = [
			{
				content: "Prior step",
				handoff: {
					version: 1 as const,
					summary: "dependency handoff line\n".repeat(40).trim(),
					filesChanged: [] as string[],
					verification: [] as string[],
				},
			},
		];
		const output = buildStepContext({
			role: "worker",
			content: "MUST_KEEP_TASK_TITLE",
			context: "MUST_KEEP_TASK_CONTEXT",
			dependencyResults: fatDeps,
			failureBriefBlock: fatFailure,
			modelInfo: tiny,
		});
		const budget = stepContextBudgetForModel(tiny);
		assert.ok(budget < CONTEXT_BUDGET.stepContextBudget, `expected scaled budget, got ${budget}`);
		assert.ok(output.length <= budget, `len ${output.length} > budget ${budget}`);
		// Task is highest priority — always retained (or clamped line-safe).
		assert.match(output, /MUST_KEEP_TASK_TITLE/);
		// Format directive is lowest priority — dropped first on a tiny window.
		assert.doesNotMatch(output, /Before marking a code step done|run the formatter|FORMAT/i);
	});

	test("priority order under a fixed tiny budget string fixture", () => {
		// nano + low window → 0.5 * 0.6 scale → 1800 chars. Fat optional blocks each
		// exceed that alone so format, then awareness, then deps, then failure drop
		// until the assembly fits; task always remains.
		const modelInfo = { id: "nano-test", contextWindow: 512 };
		const fat = (tag: string) => tag + "_MARKER\n" + "padding line of context data\n".repeat(80);
		const output = buildStepContext({
			role: "worker",
			content: "KEEP_ME",
			context: "ctx",
			dependencyResults: [
				{
					content: "Dep",
					handoff: {
						version: 1,
						summary: fat("DROP_DEPS"),
						filesChanged: [],
						verification: [],
					},
				},
			],
			failureBriefBlock: fat("DROP_FAIL"),
			modelInfo,
		});
		const budget = stepContextBudgetForModel(modelInfo);
		assert.equal(budget, Math.round(CONTEXT_BUDGET.stepContextBudget * 0.5 * 0.6));
		assert.ok(output.length <= budget, `len ${output.length} > budget ${budget}`);
		assert.match(output, /KEEP_ME/);
		// Fat optional blocks cannot both fit; lowest-priority of the fat pair (deps)
		// drops first. Failure may survive if task+failure+schema still fit.
		assert.doesNotMatch(output, /DROP_DEPS_MARKER/);
	});
});
