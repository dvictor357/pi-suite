import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	CONTEXT_BUDGET,
	budgetForModel,
	stepContextBudgetForModel,
	fitSectionsToBudget,
	isSmallModel,
	isConstrainedModel,
	verbosityForModel,
	clampToBudget,
} from "./context-budget";

describe("budgetForModel", () => {
	test("unknown model gets the full base budget", () => {
		assert.equal(budgetForModel(undefined), CONTEXT_BUDGET.awarenessBudget);
		assert.equal(budgetForModel({}), CONTEXT_BUDGET.awarenessBudget);
	});

	test("large ample-context model is never scaled down", () => {
		assert.equal(
			budgetForModel({ id: "claude-opus-4-8", contextWindow: 200000 }),
			CONTEXT_BUDGET.awarenessBudget,
		);
	});

	test("low context window shrinks the budget", () => {
		const b = budgetForModel({ id: "local-model", contextWindow: 8192 });
		assert.ok(b < CONTEXT_BUDGET.awarenessBudget);
		assert.equal(b, Math.round(CONTEXT_BUDGET.awarenessBudget * CONTEXT_BUDGET.lowContextScale));
	});

	test("small-model marker shrinks the budget even with a large window", () => {
		// Haiku has a large window but is a small model → still tightened.
		const b = budgetForModel({ id: "claude-haiku-4-5", contextWindow: 200000 });
		assert.equal(b, Math.round(CONTEXT_BUDGET.awarenessBudget * CONTEXT_BUDGET.smallModelScale));
	});

	test("small AND low-context compounds, but never below the floor", () => {
		const b = budgetForModel({ id: "tiny-mini", contextWindow: 4096 });
		assert.ok(b >= CONTEXT_BUDGET.minBudget);
	});

	test("respects a custom config override", () => {
		const cfg = { ...CONTEXT_BUDGET, awarenessBudget: 800, smallModelScale: 0.5 };
		assert.equal(budgetForModel({ id: "haiku" }, cfg), 400);
	});
});

describe("isSmallModel", () => {
	test("matches markers case-insensitively", () => {
		assert.equal(isSmallModel({ id: "Claude-Haiku-4-5" }), true);
		assert.equal(isSmallModel({ id: "gpt-4o-mini" }), true);
		assert.equal(isSmallModel({ id: "claude-opus-4-8" }), false);
		assert.equal(isSmallModel(undefined), false);
	});
});

describe("verbosityForModel / isConstrainedModel", () => {
	test("large ample-context model is full / unconstrained", () => {
		const m = { id: "claude-opus-4-8", contextWindow: 200000 };
		assert.equal(isConstrainedModel(m), false);
		assert.equal(verbosityForModel(m), "full");
	});

	test("small model is constrained → compact, even with a large window", () => {
		const m = { id: "claude-haiku-4-5", contextWindow: 200000 };
		assert.equal(isConstrainedModel(m), true);
		assert.equal(verbosityForModel(m), "compact");
	});

	test("low-context window alone → compact", () => {
		const m = { id: "some-local-model", contextWindow: 8192 };
		assert.equal(isConstrainedModel(m), true);
		assert.equal(verbosityForModel(m), "compact");
	});

	test("unknown model defaults to full", () => {
		assert.equal(verbosityForModel(undefined), "full");
		assert.equal(isConstrainedModel({}), false);
	});
});

describe("clampToBudget", () => {
	test("returns text unchanged when under budget", () => {
		const t = "line one\nline two";
		assert.equal(clampToBudget(t, 1000), t);
	});

	test("never cuts a line in half and stays within budget", () => {
		const t = ["## Header", "alpha alpha alpha", "beta beta beta", "gamma gamma gamma"].join("\n");
		const out = clampToBudget(t, 30);
		assert.ok(out.length <= 30, `len ${out.length}`);
		// Every retained line (minus the trailing marker) is a whole original line.
		const body = out.replace(/\n…$/, "");
		for (const line of body.split("\n")) {
			assert.ok(t.split("\n").includes(line), `partial line leaked: ${JSON.stringify(line)}`);
		}
	});

	test("keeps the header line and appends the marker", () => {
		const t = ["## Project Awareness", "a".repeat(50), "b".repeat(50)].join("\n");
		const out = clampToBudget(t, 40);
		assert.match(out, /^## Project Awareness/);
		assert.match(out, /…$/);
	});

	test("hard-cuts a single oversized line as a last resort", () => {
		const out = clampToBudget("x".repeat(500), 50);
		assert.ok(out.length <= 50);
		assert.match(out, /…$/);
	});
});

describe("stepContextBudgetForModel", () => {
	test("unknown model gets the full step-context base", () => {
		assert.equal(stepContextBudgetForModel(undefined), CONTEXT_BUDGET.stepContextBudget);
		assert.equal(stepContextBudgetForModel({}), CONTEXT_BUDGET.stepContextBudget);
	});

	test("large ample-context model is never scaled down", () => {
		assert.equal(
			stepContextBudgetForModel({ id: "claude-opus-4-8", contextWindow: 200000 }),
			CONTEXT_BUDGET.stepContextBudget,
		);
	});

	test("tiny contextWindow shrinks the multi-block budget", () => {
		const b = stepContextBudgetForModel({ id: "local-model", contextWindow: 8192 });
		assert.ok(b < CONTEXT_BUDGET.stepContextBudget);
		assert.equal(b, Math.round(CONTEXT_BUDGET.stepContextBudget * CONTEXT_BUDGET.lowContextScale));
	});

	test("respects a custom config override", () => {
		const cfg = {
			...CONTEXT_BUDGET,
			stepContextBudget: 1000,
			smallModelScale: 0.5,
			minBudget: 100,
		};
		assert.equal(stepContextBudgetForModel({ id: "haiku" }, cfg), 500);
	});
});

describe("fitSectionsToBudget", () => {
	const task = "## Task\nimplement auth";
	const failure = "## Failure\ntests failed on login";
	const deps = "## Prior results\nuse AuthService";
	const awareness = "## Project Awareness\nstack: ts";
	const format = "## Format\nrun the formatter";

	test("returns all sections when under budget", () => {
		const out = fitSectionsToBudget(
			[
				{ text: task, priority: 0 },
				{ text: failure, priority: 1 },
				{ text: deps, priority: 2 },
				{ text: awareness, priority: 3 },
				{ text: format, priority: 4 },
			],
			10_000,
		);
		assert.match(out, /implement auth/);
		assert.match(out, /tests failed/);
		assert.match(out, /AuthService/);
		assert.match(out, /stack: ts/);
		assert.match(out, /formatter/);
	});

	test("drops whole low-priority sections first (format before awareness before deps)", () => {
		// Budget that fits task + failure + deps but not awareness/format.
		const core = [task, failure, deps].join("\n\n");
		const budget = core.length + 5; // tiny headroom, not enough for more sections
		const out = fitSectionsToBudget(
			[
				{ text: task, priority: 0 },
				{ text: failure, priority: 1 },
				{ text: deps, priority: 2 },
				{ text: awareness, priority: 3 },
				{ text: format, priority: 4 },
			],
			budget,
		);
		assert.match(out, /implement auth/);
		assert.match(out, /tests failed/);
		assert.match(out, /AuthService/);
		assert.doesNotMatch(out, /Project Awareness/);
		assert.doesNotMatch(out, /formatter/);
		assert.ok(out.length <= budget);
	});

	test("priority order: drops format first, then awareness, keeps task", () => {
		const sections = [
			{ text: task, priority: 0 },
			{ text: failure, priority: 1 },
			{ text: deps, priority: 2 },
			{ text: awareness, priority: 3 },
			{ text: format, priority: 4 },
		];
		// Fit only task + failure.
		const budget = [task, failure].join("\n\n").length + 2;
		const out = fitSectionsToBudget(sections, budget);
		assert.match(out, /implement auth/);
		assert.match(out, /tests failed/);
		assert.doesNotMatch(out, /AuthService/);
		assert.doesNotMatch(out, /Project Awareness/);
		assert.doesNotMatch(out, /formatter/);
	});

	test("never mid-line cuts when clamping residual priority-0 text", () => {
		const longTask = [
			"## Task",
			"alpha line of work",
			"beta line of work",
			"gamma line of work",
		].join("\n");
		const out = fitSectionsToBudget([{ text: longTask, priority: 0 }], 40);
		assert.ok(out.length <= 40);
		const body = out.replace(/\n…$/, "");
		for (const line of body.split("\n")) {
			assert.ok(
				longTask.split("\n").includes(line) || line === "",
				`partial line leaked: ${JSON.stringify(line)}`,
			);
		}
	});

	test("skips empty sections", () => {
		const out = fitSectionsToBudget(
			[
				{ text: task, priority: 0 },
				{ text: "", priority: 1 },
				{ text: "   ", priority: 2 },
				{ text: format, priority: 4 },
			],
			10_000,
		);
		assert.equal(out, `${task}\n\n${format}`);
	});
});
