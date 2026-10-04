import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult } from "./checks";
import { TIERING } from "./constants";
import {
	autoPassDecision,
	diffLines,
	isQuestTier,
	planningGuidance,
	resolvePlanTier,
	runsInline,
	tierOf,
} from "./tiering";

const check = (
	kind: CheckResult["kind"],
	status: CheckResult["status"],
	preexisting?: boolean,
): CheckResult => ({
	kind,
	command: `npm run ${kind}`,
	status,
	exitCode: status === "fail" ? 1 : 0,
	summary: "",
	...(preexisting ? { preexisting } : {}),
});

const stat = (ins: number, del: number) =>
	` src/a.ts | ${ins + del} ++--\n 1 file changed, ${ins} insertions(+), ${del} deletions(-)`;

describe("tier basics", () => {
	test("legacy quests run at the configured default", () => {
		assert.equal(tierOf({}), TIERING.defaultTier);
		assert.equal(tierOf({ tier: "simple" }), "simple");
		assert.equal(isQuestTier("medium"), true);
		assert.equal(isQuestTier("huge"), false);
	});

	test("simple and medium run inline; never sandboxed, parallel, or complex", () => {
		assert.equal(runsInline({ tier: "simple" }, false), true);
		assert.equal(runsInline({ tier: "medium" }, false), true);
		assert.equal(runsInline({ tier: "simple" }, true), false, "sandboxed");
		assert.equal(runsInline({ tier: "medium", parallel: { enabled: true } }, false), false);
		assert.equal(runsInline({ tier: "medium", parallel: { enabled: false } }, false), true);
		assert.equal(runsInline({ tier: "complex" }, false), false);
		assert.equal(runsInline({}, false), false, "legacy quests keep delegating");
	});

	test("guidance skips research sub-agents below complex", () => {
		const simple = planningGuidance("simple").join("\n");
		assert.match(simple, /Skip quest_enhance, scout\/planner/);
		assert.match(simple, /implement that step yourself/);
		assert.match(planningGuidance("medium").join("\n"), /skip scout\/planner/);
		const complex = planningGuidance("complex").join("\n");
		assert.match(complex, /subagent\(agent="scout"\)/);
		assert.match(complex, /web_search/);
	});

	test("light tiers are nudged toward acceptance commands without requiring them", () => {
		for (const tier of ["simple", "medium"] as const) {
			assert.match(planningGuidance(tier).join("\n"), /acceptanceCommands/, tier);
		}
		assert.doesNotMatch(
			planningGuidance("complex").join("\n"),
			/acceptanceCommands/,
			"complex already declares acceptance at quest_create",
		);
	});
});

describe("resolvePlanTier", () => {
	const worker = (writeClaim?: string[]) => ({ agent: "worker", writeClaim });

	test("a plan within its declared tier keeps it", () => {
		assert.deepEqual(resolvePlanTier("simple", [worker(["src/a.ts"])]), { tier: "simple" });
		assert.deepEqual(resolvePlanTier("complex", [worker(), worker(), worker()]), {
			tier: "complex",
		});
	});

	test("too many steps raises the tier, with a reason", () => {
		const r = resolvePlanTier("simple", [worker(["a.ts"]), worker(["b.ts"])]);
		assert.equal(r.tier, "medium");
		assert.match(r.reason!, /2 steps > 1/);
	});

	test("too many write-claimed files raises the tier", () => {
		const r = resolvePlanTier("simple", [worker(["a.ts", "b.ts", "c.ts", "d.ts"])]);
		assert.equal(r.tier, "medium");
		assert.match(r.reason!, /4 write-claimed files > 3/);
	});

	test("skips straight to complex when medium can't hold it either", () => {
		const steps = Array.from({ length: 6 }, (_, i) => worker([`f${i}.ts`]));
		assert.equal(resolvePlanTier("simple", steps).tier, "complex");
	});

	test("never lowers a declared tier", () => {
		assert.equal(resolvePlanTier("complex", [worker(["a.ts"])]).tier, "complex");
		assert.equal(resolvePlanTier("medium", [worker(["a.ts"])]).tier, "medium");
	});

	test("duplicate claims across steps count once", () => {
		const r = resolvePlanTier("medium", [worker(["a.ts"]), worker(["a.ts"])]);
		assert.deepEqual(r, { tier: "medium" });
	});
});

describe("diffLines", () => {
	test("sums insertions and deletions from a diff --stat summary", () => {
		assert.equal(diffLines(stat(10, 4)), 14);
		assert.equal(diffLines(" 1 file changed, 1 insertion(+)"), 1);
		assert.equal(diffLines(" 1 file changed, 3 deletions(-)"), 3);
		assert.equal(diffLines(""), null);
	});
});

describe("autoPassDecision", () => {
	const ev = (checks: CheckResult[], ins = 10, del = 2) => ({
		checks,
		diffStat: stat(ins, del),
		changedFiles: ["src/a.ts"],
	});

	test("simple: green checks and a small diff auto-pass", () => {
		const d = autoPassDecision("simple", ev([check("typecheck", "pass")]));
		assert.equal(d.pass, true);
		assert.match(d.reason, /auto-verified \(tier simple\): checks typecheck:pass; diff 12 lines/);
	});

	test("pre-existing failures don't block, but at least one real pass is required", () => {
		assert.equal(
			autoPassDecision("simple", ev([check("typecheck", "fail", true), check("test", "pass")]))
				.pass,
			true,
		);
		const none = autoPassDecision("simple", ev([check("typecheck", "fail", true)]));
		assert.equal(none.pass, false);
		assert.match(none.reason, /no deterministic check passed/);
		assert.equal(autoPassDecision("simple", ev([check("test", "skipped")])).pass, false);
	});

	test("medium needs a passing test check, not just typecheck", () => {
		const d = autoPassDecision("medium", ev([check("typecheck", "pass")]));
		assert.equal(d.pass, false);
		assert.match(d.reason, /no test check passed/);
		assert.equal(
			autoPassDecision("medium", ev([check("typecheck", "pass"), check("test", "pass")])).pass,
			true,
		);
	});

	test("large diffs and unknown diff sizes go to the verifier", () => {
		const big = autoPassDecision("medium", ev([check("test", "pass")], 200, 50));
		assert.equal(big.pass, false);
		assert.match(big.reason, /diff 250 lines > 120/);
		assert.equal(
			autoPassDecision("simple", {
				checks: [check("test", "pass")],
				diffStat: "",
				changedFiles: ["a"],
			}).pass,
			false,
		);
	});

	test("no changed files never auto-passes", () => {
		assert.equal(
			autoPassDecision("simple", { ...ev([check("test", "pass")]), changedFiles: [] }).pass,
			false,
		);
	});

	test("complex always uses the LLM verifier", () => {
		const d = autoPassDecision("complex", ev([check("typecheck", "pass"), check("test", "pass")]));
		assert.equal(d.pass, false);
		assert.match(d.reason, /always uses the verifier/);
	});
});
