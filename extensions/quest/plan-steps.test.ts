import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePlannedSteps } from "./plan-steps";

type Step = { content: string; agent: string; context: string };
const isStep = (v: unknown): v is Step =>
	!!v &&
	typeof (v as Step).content === "string" &&
	typeof (v as Step).agent === "string" &&
	typeof (v as Step).context === "string";
const step = (content: string): Step => ({ content, agent: "worker", context: "c" });

test("steps is canonical and wins over the legacy alias", () => {
	assert.deepEqual(resolvePlannedSteps({ steps: [step("a")], tasks: [step("b")] }, isStep), {
		steps: [step("a")],
	});
	assert.deepEqual(resolvePlannedSteps({}, isStep), { steps: [] });
});

test("the legacy tasks alias is still accepted, validated item by item", () => {
	assert.deepEqual(resolvePlannedSteps({ tasks: [step("a"), step("b")] }, isStep), {
		steps: [step("a"), step("b")],
	});
	const bad = resolvePlannedSteps({ tasks: [step("a"), { content: "no agent" }] }, isStep);
	assert.ok("error" in bad);
	assert.match(bad.error, /Invalid step #2 in tasks/);
});
