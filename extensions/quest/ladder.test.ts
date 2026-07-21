import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeEvalStats,
	DEFAULT_RETRY_POLICY,
	type EvalStatsIndex,
	type ModelLadderConfig,
} from "../../core";
import {
	applyStepDispatchModel,
	briefBudgetForModel,
	buildFailureBrief,
	coerceFailureBrief,
	decideVerifyFailAction,
	ladderApplies,
	pickStartRung,
	prepareStepDispatchModel,
	renderFailureBriefs,
	rungModel,
	type FailureBrief,
	type LadderConfig,
} from "./ladder";

const CFG: LadderConfig = {
	roles: ["worker"],
	minSamples: 5,
	passRateFloor: 0.55,
	briefBudget: 700,
	maxBriefs: 3,
};

function ladder(rungs: string[], roles?: string[]): ModelLadderConfig {
	return { rungs, roles, approvedAt: 0 };
}

function evalRow(model: string, verified: boolean, agent = "worker") {
	return {
		agent,
		model,
		status: verified ? "done" : "failed",
		verified,
	};
}

function statsWith(rows: unknown[]): EvalStatsIndex {
	return computeEvalStats(rows);
}

describe("ladderApplies", () => {
	const l = ladder(["ornith-1.0", "mythos-5"]);

	it("applies to default execution roles without an explicit model", () => {
		assert.equal(ladderApplies(l, "worker", undefined, CFG), true);
		assert.equal(
			ladderApplies(l, "quick-worker", undefined, { ...CFG, roles: ["worker", "quick-worker"] }),
			true,
		);
	});

	it("explicit step model bypasses the ladder", () => {
		assert.equal(ladderApplies(l, "worker", "claude-opus", CFG), false);
		assert.equal(ladderApplies(l, "worker", "  ", CFG), true, "blank model is not explicit");
	});

	it("judge/exploration roles are never laddered by default", () => {
		for (const role of ["verifier", "reviewer", "scout", "planner"]) {
			assert.equal(ladderApplies(l, role, undefined, CFG), false, role);
		}
	});

	it("a ladder's own roles override the config default without allowing judge roles", () => {
		const custom = ladder(["a", "b"], ["writer", "verifier"]);
		assert.equal(ladderApplies(custom, "writer", undefined, CFG), true);
		assert.equal(ladderApplies(custom, "worker", undefined, CFG), false);
		assert.equal(ladderApplies(custom, "verifier", undefined, CFG), false);
	});

	it("no ladder or empty rungs never applies", () => {
		assert.equal(ladderApplies(null, "worker", undefined, CFG), false);
		assert.equal(ladderApplies(ladder([]), "worker", undefined, CFG), false);
	});
});

describe("pickStartRung", () => {
	const l = ladder(["ornith-1.0", "opus-4.8", "mythos-5"]);

	it("no history → rung 0 (trust the cheap model until proven otherwise)", () => {
		assert.equal(pickStartRung(l, "worker", statsWith([]), CFG), 0);
	});

	it("a proven-bad rung 0 is skipped", () => {
		const rows = Array.from({ length: 5 }, () => evalRow("ornith-1.0", false));
		assert.equal(pickStartRung(l, "worker", statsWith(rows), CFG), 1);
	});

	it("thin history never disqualifies a rung", () => {
		const rows = Array.from({ length: 4 }, () => evalRow("ornith-1.0", false));
		assert.equal(pickStartRung(l, "worker", statsWith(rows), CFG), 0);
	});

	it("a passing history keeps rung 0", () => {
		const rows = [
			...Array.from({ length: 4 }, () => evalRow("ornith-1.0", true)),
			...Array.from({ length: 2 }, () => evalRow("ornith-1.0", false)),
		]; // 4/6 ≈ 0.67 ≥ 0.55
		assert.equal(pickStartRung(l, "worker", statsWith(rows), CFG), 0);
	});

	it("history for another role does not affect this role", () => {
		const rows = Array.from({ length: 6 }, () => evalRow("ornith-1.0", false, "scout"));
		assert.equal(pickStartRung(l, "worker", statsWith(rows), CFG), 0);
	});

	it("all rungs disqualified → last rung as the floor", () => {
		const rows = [
			...Array.from({ length: 5 }, () => evalRow("ornith-1.0", false)),
			...Array.from({ length: 5 }, () => evalRow("opus-4.8", false)),
			...Array.from({ length: 5 }, () => evalRow("mythos-5", false)),
		];
		assert.equal(pickStartRung(l, "worker", statsWith(rows), CFG), 2);
	});
});

describe("decideVerifyFailAction", () => {
	const max = DEFAULT_RETRY_POLICY.maxVerifyRetries;

	it("retries on the same rung while retries remain", () => {
		const d = decideVerifyFailAction({
			verifyRetries: 1,
			rung: 0,
			escalations: 0,
			ladderLength: 2,
		});
		assert.equal(d.action, "retry");
		assert.equal(d.retriesLeft, max - 1);
	});

	it("escalates exactly when per-rung retries are exhausted and rungs remain", () => {
		const d = decideVerifyFailAction({
			verifyRetries: max,
			rung: 0,
			escalations: 0,
			ladderLength: 2,
		});
		assert.equal(d.action, "escalate");
		assert.equal(d.nextRung, 1);
	});

	it("fails on the top rung", () => {
		const d = decideVerifyFailAction({
			verifyRetries: max,
			rung: 1,
			escalations: 1,
			ladderLength: 2,
		});
		assert.equal(d.action, "fail");
	});

	it("fails once the escalation cap is spent, even with rungs above", () => {
		const d = decideVerifyFailAction({
			verifyRetries: max,
			rung: 2,
			escalations: DEFAULT_RETRY_POLICY.maxEscalations,
			ladderLength: 9,
		});
		assert.equal(d.action, "fail");
	});

	it("a one-rung ladder never escalates (today's behaviour)", () => {
		const d = decideVerifyFailAction({
			verifyRetries: max,
			rung: 0,
			escalations: 0,
			ladderLength: 1,
		});
		assert.equal(d.action, "fail");
	});

	it("un-laddered steps (rung undefined) keep pure legacy retry/fail", () => {
		assert.equal(
			decideVerifyFailAction({ verifyRetries: 1, rung: undefined, escalations: 0, ladderLength: 0 })
				.action,
			"retry",
		);
		assert.equal(
			decideVerifyFailAction({
				verifyRetries: max,
				rung: undefined,
				escalations: 0,
				ladderLength: 3,
			}).action,
			"fail",
		);
	});
});

describe("briefBudgetForModel", () => {
	it("gives large models the full budget and scales constrained models down", () => {
		assert.equal(briefBudgetForModel({ id: "mythos-5" }, CFG), CFG.briefBudget);
		const small = briefBudgetForModel({ id: "ornith-mini" }, CFG);
		assert.ok(small < CFG.briefBudget, "small models get a leaner brief block");
		assert.ok(small > 0);
	});
});

describe("rungModel", () => {
	it("clamps a stale rung index into the ladder", () => {
		const l = ladder(["a", "b"]);
		assert.equal(rungModel(l, 0), "a");
		assert.equal(rungModel(l, 5), "b");
		assert.equal(rungModel(l, -1), "a");
	});
});

describe("prepareStepDispatchModel", () => {
	const l = ladder(["ornith-1.0", "opus-4.8", "mythos-5"]);
	const emptyStats = statsWith([]);

	it("empty history → starts rung 0 with the cheap model as lastModel", () => {
		const prepared = prepareStepDispatchModel(
			{ agent: "worker" },
			{ ladder: l, evalStats: emptyStats, cfg: CFG },
		);
		assert.equal(prepared.rung, 0);
		assert.equal(prepared.rungInitialized, true);
		assert.equal(prepared.model, "ornith-1.0");
		assert.equal(prepared.lastModel, "ornith-1.0");
		assert.equal(prepared.source, "ladder");
	});

	it("proven-bad cheap rung → higher start", () => {
		const rows = Array.from({ length: 5 }, () => evalRow("ornith-1.0", false));
		const prepared = prepareStepDispatchModel(
			{ agent: "worker" },
			{ ladder: l, evalStats: statsWith(rows), cfg: CFG },
		);
		assert.equal(prepared.rung, 1);
		assert.equal(prepared.model, "opus-4.8");
		assert.equal(prepared.lastModel, "opus-4.8");
		assert.equal(prepared.rungInitialized, true);
	});

	it("preserves an already-stamped rung (no re-pick)", () => {
		const rows = Array.from({ length: 5 }, () => evalRow("ornith-1.0", false));
		const prepared = prepareStepDispatchModel(
			{ agent: "worker", rung: 0 },
			{ ladder: l, evalStats: statsWith(rows), cfg: CFG },
		);
		assert.equal(prepared.rung, 0);
		assert.equal(prepared.rungInitialized, false);
		assert.equal(prepared.model, "ornith-1.0");
	});

	it("explicit step.model bypasses the ladder", () => {
		const prepared = prepareStepDispatchModel(
			{ agent: "worker", model: "claude-opus" },
			{
				ladder: l,
				evalStats: emptyStats,
				rememberedModel: "remembered-model",
				cfg: CFG,
			},
		);
		assert.equal(prepared.rung, undefined);
		assert.equal(prepared.rungInitialized, false);
		assert.equal(prepared.model, "claude-opus");
		assert.equal(prepared.lastModel, "claude-opus");
		assert.equal(prepared.source, "task");
	});

	it("scout/verifier (judge roles) are not laddered", () => {
		for (const agent of ["scout", "verifier", "reviewer", "planner"]) {
			const prepared = prepareStepDispatchModel(
				{ agent },
				{
					ladder: l,
					evalStats: emptyStats,
					rememberedModel: "judge-model",
					cfg: CFG,
				},
			);
			assert.equal(prepared.rung, undefined, agent);
			assert.equal(prepared.source, "memory", agent);
			assert.equal(prepared.lastModel, "judge-model", agent);
		}
	});

	it("falls back to remembered model when ladder does not apply", () => {
		const prepared = prepareStepDispatchModel(
			{ agent: "worker" },
			{
				ladder: null,
				evalStats: emptyStats,
				rememberedModel: "mem-model",
				cfg: CFG,
			},
		);
		assert.equal(prepared.source, "memory");
		assert.equal(prepared.model, "mem-model");
		assert.equal(prepared.lastModel, "mem-model");
		assert.equal(prepared.rung, undefined);
	});

	it("returns empty when nothing is known", () => {
		const prepared = prepareStepDispatchModel(
			{ agent: "worker" },
			{ ladder: null, evalStats: emptyStats, cfg: CFG },
		);
		assert.equal(prepared.model, undefined);
		assert.equal(prepared.lastModel, undefined);
		assert.equal(prepared.rungInitialized, false);
	});

	it("applyStepDispatchModel stamps rung and lastModel", () => {
		const step: { rung?: number; lastModel?: string } = {};
		const prepared = prepareStepDispatchModel(
			{ agent: "worker" },
			{ ladder: l, evalStats: emptyStats, cfg: CFG },
		);
		assert.equal(applyStepDispatchModel(step, prepared), true);
		assert.equal(step.rung, 0);
		assert.equal(step.lastModel, "ornith-1.0");
		assert.equal(applyStepDispatchModel(step, prepared), false, "idempotent second apply");
	});
});

describe("failure briefs", () => {
	function brief(overrides: Partial<FailureBrief>): FailureBrief {
		return {
			attempt: 1,
			evidence: "tests fail",
			attempted: "edited foo.ts",
			inferred: false,
			timestamp: 0,
			...overrides,
		};
	}

	it("buildFailureBrief defaults empty evidence and trims fields", () => {
		const b = buildFailureBrief({
			attempt: 2,
			evidence: "  ",
			attempted: null,
			inferred: true,
		});
		assert.equal(b.evidence, "no details recorded");
		assert.equal(b.attempted, "");
		assert.equal(b.inferred, true);
	});

	it("renderFailureBriefs is empty for no briefs", () => {
		assert.equal(renderFailureBriefs([], 700, 3), "");
		assert.equal(renderFailureBriefs(undefined, 700, 3), "");
	});

	it("renders newest first, keeping at most maxBriefs", () => {
		const briefs = [1, 2, 3, 4].map((n) => brief({ attempt: n, evidence: `failure ${n}` }));
		const out = renderFailureBriefs(briefs, 700, 3);
		assert.ok(!out.includes("failure 1"), "oldest brief dropped");
		assert.ok(out.indexOf("failure 4") < out.indexOf("failure 2"), "newest first");
	});

	it("marks prose-inferred verdicts and the failing model", () => {
		const out = renderFailureBriefs(
			[brief({ model: "ornith-1.0", rung: 0, inferred: true })],
			700,
			3,
		);
		assert.ok(out.includes("ornith-1.0"));
		assert.ok(out.includes("verdict inferred from prose"));
	});

	it("clamps to the budget on line boundaries", () => {
		const briefs = [1, 2, 3].map((n) => brief({ attempt: n, evidence: "x".repeat(200) }));
		const full = renderFailureBriefs(briefs, 10_000, 3);
		const out = renderFailureBriefs(briefs, 260, 3);
		assert.ok(out.length <= 260);
		assert.ok(out.endsWith("…"), "truncation marker appended");
		for (const line of out.split("\n").slice(0, -1)) {
			assert.ok(full.includes(line), "kept lines are whole lines, never mid-line cuts");
		}
	});

	it("coerceFailureBrief round-trips a valid brief and rejects garbage", () => {
		const b = brief({ model: "m", rung: 1 });
		assert.deepEqual(coerceFailureBrief(JSON.parse(JSON.stringify(b))), b);
		assert.equal(coerceFailureBrief(null), null);
		assert.equal(coerceFailureBrief({ attempted: "x" }), null, "evidence is required");
		const partial = coerceFailureBrief({ evidence: "e" });
		assert.equal(partial?.attempt, 1);
		assert.equal(partial?.inferred, false);
	});
});
