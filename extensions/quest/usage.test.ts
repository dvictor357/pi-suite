import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	addUsage,
	applyAttributedUsage,
	attributeSubagentUsage,
	coerceStepUsage,
	usageFromSessionStats,
	type StepUsage,
} from "./usage";

function minionUsage(overrides: Partial<StepUsage> = {}) {
	return {
		input: 1000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 0,
		cost: 0.01,
		contextTokens: 1700,
		turns: 2,
		...overrides,
	};
}

describe("coerceStepUsage", () => {
	test("reads a pi-minions usage blob as one run", () => {
		assert.deepEqual(coerceStepUsage(minionUsage()), { ...minionUsage(), runs: 1 });
	});

	test("absent, garbage, or all-zero blobs are not a measurement", () => {
		assert.equal(coerceStepUsage(undefined), undefined);
		assert.equal(coerceStepUsage("nope"), undefined);
		assert.equal(
			coerceStepUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
			undefined,
		);
	});

	test("negative, NaN, and non-number fields fall back to 0", () => {
		const u = coerceStepUsage({ input: -5, output: NaN, cost: "1", turns: 1 });
		assert.deepEqual(u, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 1,
			runs: 1,
		});
	});

	test("round-trips a persisted multi-run total", () => {
		const total = addUsage(coerceStepUsage(minionUsage()), coerceStepUsage(minionUsage())!);
		assert.deepEqual(coerceStepUsage(JSON.parse(JSON.stringify(total))), total);
	});
});

describe("addUsage", () => {
	test("sums spend and runs; context is the peak, not the sum", () => {
		const a = coerceStepUsage(minionUsage({ contextTokens: 1700 }))!;
		const b = coerceStepUsage(minionUsage({ contextTokens: 900, cost: 0.02 }))!;
		const total = addUsage(a, b);
		assert.equal(total.input, 2000);
		assert.equal(total.turns, 4);
		assert.equal(total.runs, 2);
		assert.equal(total.contextTokens, 1700);
		assert.ok(Math.abs(total.cost - 0.03) < 1e-12);
	});

	test("starting from nothing copies instead of aliasing", () => {
		const run = coerceStepUsage(minionUsage())!;
		const total = addUsage(undefined, run);
		total.input = 0;
		assert.equal(run.input, 1000);
	});
});

describe("attributeSubagentUsage", () => {
	test("single mode credits the one targeted step, with its thinking level", () => {
		const out = attributeSubagentUsage([2], {
			mode: "single",
			results: [{ usage: minionUsage(), thinking: "high" }],
		});
		assert.deepEqual([...out.keys()], [2]);
		assert.equal(out.get(2)!.usage.input, 1000);
		assert.equal(out.get(2)!.thinking, "high");
	});

	test("parallel results are credited index-aligned with tasks[]", () => {
		const out = attributeSubagentUsage([0, null, 3], {
			mode: "parallel",
			results: [
				{ usage: minionUsage({ input: 10 }) },
				{ usage: minionUsage({ input: 20 }) },
				{ usage: minionUsage({ input: 30 }) },
			],
		});
		assert.deepEqual([...out.keys()].sort(), [0, 3]);
		assert.equal(out.get(0)!.usage.input, 10);
		assert.equal(out.get(3)!.usage.input, 30);
	});

	test("chain results sum onto a single targeted step", () => {
		const out = attributeSubagentUsage([1], {
			mode: "chain",
			results: [{ usage: minionUsage() }, { usage: minionUsage() }],
		});
		assert.equal(out.get(1)!.usage.input, 2000);
		assert.equal(out.get(1)!.usage.runs, 2);
	});

	test("ambiguous non-parallel calls credit nothing rather than guess", () => {
		const out = attributeSubagentUsage([0, 1], {
			mode: "chain",
			results: [{ usage: minionUsage() }],
		});
		assert.equal(out.size, 0);
	});

	test("missing details or usage-less results credit nothing", () => {
		assert.equal(attributeSubagentUsage([0], undefined).size, 0);
		assert.equal(attributeSubagentUsage([0], { mode: "single", results: [{}] }).size, 0);
	});
});

describe("applyAttributedUsage", () => {
	test("accumulates onto steps and ignores out-of-range indices", () => {
		const steps: { usage?: StepUsage; lastThinking?: string }[] = [{}];
		const attributed = attributeSubagentUsage([0], {
			mode: "single",
			results: [{ usage: minionUsage(), thinking: "low" }],
		});
		assert.equal(applyAttributedUsage(steps, attributed), true);
		assert.equal(applyAttributedUsage(steps, attributed), true);
		assert.equal(steps[0].usage!.runs, 2);
		assert.equal(steps[0].lastThinking, "low");
		assert.equal(applyAttributedUsage(steps, new Map([[5, attributed.get(0)!]])), false);
	});
});

describe("usageFromSessionStats", () => {
	test("maps legacy quest_delegate session stats", () => {
		const u = usageFromSessionStats({
			assistantMessages: 3,
			tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
			cost: 0.002,
			contextUsage: { tokens: 160 },
		});
		assert.deepEqual(u, {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: 0.002,
			contextTokens: 160,
			turns: 3,
			runs: 1,
		});
	});

	test("unknown context tokens (null) and missing stats are tolerated", () => {
		assert.equal(usageFromSessionStats(undefined), undefined);
		const u = usageFromSessionStats({
			assistantMessages: 1,
			tokens: { input: 1 },
			contextUsage: { tokens: null },
		});
		assert.equal(u!.contextTokens, 0);
	});
});
