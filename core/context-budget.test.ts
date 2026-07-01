import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CONTEXT_BUDGET, budgetForModel, isSmallModel, clampToBudget } from "./context-budget";

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
