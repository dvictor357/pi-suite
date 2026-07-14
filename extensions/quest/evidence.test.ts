import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	captureBaseline,
	parseChangedFiles,
	buildStepEvidence,
	renderEvidenceBlock,
	type StepEvidence,
} from "./evidence";
import type { CheckResult } from "./checks";

describe("parseChangedFiles", () => {
	test("null / empty → empty list", () => {
		assert.deepEqual(parseChangedFiles(null), []);
		assert.deepEqual(parseChangedFiles(""), []);
	});

	test("trims and drops blank lines", () => {
		assert.deepEqual(parseChangedFiles("a.ts\n  b/c.ts  \n\n d.ts \n"), ["a.ts", "b/c.ts", "d.ts"]);
	});
});

describe("captureBaseline", () => {
	test("never throws; returns a well-typed baseline", () => {
		const b = captureBaseline(process.cwd());
		assert.equal(typeof b.dirty, "boolean");
		assert.ok(b.sha === null || typeof b.sha === "string");
	});
});

describe("buildStepEvidence", () => {
	test("assembles evidence with the provided checks and a timestamp", () => {
		const checks: CheckResult[] = [
			{ kind: "typecheck", command: "tsc", status: "pass", exitCode: 0, summary: "" },
		];
		const ev = buildStepEvidence(process.cwd(), null, checks);
		assert.equal(ev.baselineSha, null);
		assert.deepEqual(ev.checks, checks);
		assert.ok(Array.isArray(ev.changedFiles));
		assert.equal(typeof ev.diffStat, "string");
		assert.ok(ev.capturedAt > 0);
	});
});

describe("renderEvidenceBlock", () => {
	function evidence(overrides: Partial<StepEvidence>): StepEvidence {
		return {
			changedFiles: [],
			diffStat: "",
			baselineSha: null,
			checks: [],
			capturedAt: Date.now(),
			...overrides,
		};
	}

	test("lists changed files and passing checks, and forbids re-litigating them", () => {
		const block = renderEvidenceBlock(
			evidence({
				changedFiles: ["src/a.ts", "src/b.ts"],
				diffStat: " src/a.ts | 3 +++",
				checks: [
					{
						kind: "typecheck",
						command: "npm run typecheck",
						status: "pass",
						exitCode: 0,
						summary: "",
					},
					{ kind: "lint", command: "biome", status: "skipped", exitCode: -1, summary: "" },
				],
			}),
		);
		assert.match(block, /Changed files \(2\)/);
		assert.match(block, /src\/a\.ts/);
		assert.match(block, /typecheck: pass/);
		assert.doesNotMatch(block, /lint: skipped/); // skipped checks are omitted
		assert.match(block, /do NOT re-litigate/);
	});

	test("flags when nothing changed", () => {
		const block = renderEvidenceBlock(evidence({ changedFiles: [] }));
		assert.match(block, /none detected/);
	});
});
