import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FailureCode } from "../../core";
import { ROUTING } from "./constants";
import { buildFailureBrief, type FailureBrief } from "./ladder";
import {
	asThinkingLevel,
	enforceSubagentRuntime,
	qualityFailuresOnRung,
	routeStep,
	routeThinking,
	stepModel,
	type RoutingConfig,
} from "./routing";

function brief(rung: number | undefined, failureCode?: FailureCode): FailureBrief {
	return buildFailureBrief({
		attempt: 1,
		rung,
		evidence: "failed",
		attempted: null,
		inferred: false,
		failureCode,
	});
}

function step(briefs: FailureBrief[] = [], extra: { agent?: string; rung?: number } = {}) {
	return {
		agent: extra.agent ?? "worker",
		content: "Implement the thing",
		rung: extra.rung,
		failureBriefs: briefs,
	};
}

describe("routeThinking", () => {
	test("no failures: exactly the approved baseline (first attempt unchanged)", () => {
		assert.deepEqual(routeThinking(step(), "medium", ROUTING), { thinking: "medium" });
		assert.deepEqual(routeThinking(step(), undefined, ROUTING), { thinking: undefined });
	});

	test("a quality failure on the current rung bumps one level, with a reason", () => {
		const r = routeThinking(step([brief(0, "MODEL_QUALITY")], { rung: 0 }), "low", ROUTING);
		assert.equal(r.thinking, "medium");
		assert.match(r.reason ?? "", /low → medium after 1 quality failure/);
	});

	test("a plain verifier FAIL (no code) counts as quality", () => {
		const r = routeThinking(step([brief(undefined)]), "low", ROUTING);
		assert.equal(r.thinking, "medium");
	});

	test("mechanical and non-model failures do not bump", () => {
		for (const code of [
			"TYPECHECK_FAILURE",
			"LINT_FAILURE",
			"FORMAT_FAILURE",
			"TOOL_FAILURE",
			"POLICY_BLOCKED",
			"HUMAN_DECISION_REQUIRED",
		] as const) {
			assert.equal(
				routeThinking(step([brief(0, code)], { rung: 0 }), "low", ROUTING).thinking,
				"low",
			);
		}
	});

	test("failures on an earlier rung don't carry over after escalation", () => {
		const s = step([brief(0, "MODEL_QUALITY"), brief(0, "MODEL_QUALITY")], { rung: 1 });
		assert.equal(qualityFailuresOnRung(s, ROUTING), 0);
		assert.equal(routeThinking(s, "medium", ROUTING).thinking, "medium");
	});

	test("bumps are capped at maxThinking; a higher approved baseline is never lowered", () => {
		const two = step([brief(0, "MODEL_QUALITY"), brief(0, "TEST_FAILURE")], { rung: 0 });
		assert.equal(routeThinking(two, "medium", ROUTING).thinking, "high");
		const three = step(
			[brief(0, "MODEL_QUALITY"), brief(0, "MODEL_QUALITY"), brief(0, "MODEL_QUALITY")],
			{ rung: 0 },
		);
		assert.equal(routeThinking(three, "medium", ROUTING).thinking, "high");
		assert.equal(routeThinking(three, "xhigh", ROUTING).thinking, "xhigh");
	});

	test("no baseline: a bump starts from defaultThinking", () => {
		const r = routeThinking(step([brief(undefined, "MODEL_QUALITY")]), undefined, ROUTING);
		assert.equal(r.thinking, "high");
	});

	test("judge/exploration roles are never adjusted", () => {
		for (const agent of ["scout", "verifier", "reviewer", "planner"]) {
			const s = step([brief(undefined, "MODEL_QUALITY")], { agent });
			assert.equal(routeThinking(s, "low", ROUTING).thinking, "low");
		}
	});

	test("downshift is off by default", () => {
		assert.equal(ROUTING.downshift.enabled, false);
		assert.equal(routeThinking(step(), "medium", ROUTING).thinking, "medium");
	});

	test("downshift, when enabled, lowers only small first attempts", () => {
		const cfg: RoutingConfig = {
			...ROUTING,
			downshift: { enabled: true, maxStepChars: 50, thinking: "low" },
		};
		const small = routeThinking(step(), "medium", cfg);
		assert.equal(small.thinking, "low");
		assert.match(small.reason ?? "", /small step/);

		const big = { ...step(), content: "x".repeat(51) };
		assert.equal(routeThinking(big, "medium", cfg).thinking, "medium");

		// Already at/below the downshift level: untouched.
		assert.equal(routeThinking(step(), "minimal", cfg).thinking, "minimal");
		// After a quality failure the bump wins over the downshift.
		const failed = step([brief(undefined, "MODEL_QUALITY")]);
		assert.equal(routeThinking(failed, "medium", cfg).thinking, "high");
	});
});

describe("stepModel / routeStep", () => {
	const ladder = { rungs: ["cheap", "strong", "frontier"], approvedAt: 1 };

	test("explicit model > ladder rung > remembered", () => {
		assert.equal(stepModel({ model: "pinned", rung: 1 }, ladder, "mem"), "pinned");
		assert.equal(stepModel({ rung: 1 }, ladder, "mem"), "strong");
		assert.equal(stepModel({}, ladder, "mem"), "mem");
		assert.equal(stepModel({}, null, undefined), undefined);
	});

	test("routeStep combines model and thinking", () => {
		const d = routeStep(step([brief(0, "MODEL_QUALITY")], { rung: 0 }), {
			ladder,
			baselineThinking: "low",
			cfg: ROUTING,
		});
		assert.equal(d.model, "cheap");
		assert.equal(d.thinking, "medium");
		assert.equal(d.reasons.length, 1);
	});
});

describe("asThinkingLevel", () => {
	test("accepts known levels only", () => {
		assert.equal(asThinkingLevel("high"), "high");
		assert.equal(asThinkingLevel("turbo"), undefined);
		assert.equal(asThinkingLevel(3), undefined);
	});
});

describe("enforceSubagentRuntime", () => {
	const decide = (i: number) =>
		i === 0
			? { model: "cheap", thinking: "high" as const, reasons: [] }
			: { model: "strong", reasons: [] };

	test("single form: fills omitted fields and overrides deviations in place", () => {
		const input: Record<string, unknown> = { agent: "worker", task: "go", model: "other" };
		const rewrites = enforceSubagentRuntime(input, [0], decide);
		assert.equal(input.model, "cheap");
		assert.equal(input.thinking, "high");
		assert.deepEqual(rewrites, [
			{ stepIndex: 0, field: "model", from: "other", to: "cheap" },
			{ stepIndex: 0, field: "thinking", from: undefined, to: "high" },
		]);
	});

	test("already-correct args produce no rewrites", () => {
		const input = { agent: "worker", model: "cheap", thinking: "high" };
		assert.deepEqual(enforceSubagentRuntime(input, [0], decide), []);
	});

	test("tasks form: rewrites index-aligned entries, leaves unmatched and undecided fields", () => {
		const input = {
			tasks: [
				{ agent: "worker", thinking: "low" },
				{ agent: "scout", model: "mine" },
				{ agent: "worker", thinking: "minimal" },
			],
		};
		enforceSubagentRuntime(input, [0, null, 1], decide);
		assert.deepEqual(input.tasks[0], { agent: "worker", thinking: "high", model: "cheap" });
		assert.deepEqual(input.tasks[1], { agent: "scout", model: "mine" });
		// Step 1 has no thinking decision: the orchestrator's choice stays.
		assert.deepEqual(input.tasks[2], { agent: "worker", thinking: "minimal", model: "strong" });
	});
});
