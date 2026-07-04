import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	computeEvalStats,
	computeEvalTimeSeries,
	coerceEvalStat,
	readAllEvalEntries,
	statsFor,
} from "./eval-stats";
import { createEvalLog, evalsDir, type EvalEntry } from "./eval-logging";
import { setErrorSink } from "./fs";

function entry(overrides: Partial<EvalEntry>): EvalEntry {
	return {
		quest: "q",
		questSlug: "q",
		taskIndex: 0,
		taskContent: "t",
		agent: "worker",
		model: "ornith-1.0",
		status: "done",
		verified: true,
		verifyEvidence: null,
		durationMs: 0,
		tokensIn: 0,
		tokensOut: 0,
		attempts: 0,
		timestamp: 0,
		...overrides,
	};
}

describe("eval-stats", () => {
	describe("computeEvalStats", () => {
		it("aggregates verified-pass rates per (agent, model)", () => {
			const index = computeEvalStats([
				entry({ status: "done", verified: true }),
				entry({ status: "done", verified: true }),
				entry({ status: "failed", verified: false }),
				entry({ agent: "scout", model: "mythos-5", status: "done", verified: true }),
			]);
			const worker = statsFor(index, "worker", "ornith-1.0");
			assert.ok(worker);
			assert.equal(worker.samples, 3);
			assert.equal(worker.verifiedPasses, 2);
			assert.ok(Math.abs(worker.passRate - 2 / 3) < 1e-9);
			assert.equal(statsFor(index, "scout", "mythos-5")?.passRate, 1);
		});

		it("done-but-unverified does not count as a pass", () => {
			const index = computeEvalStats([entry({ status: "done", verified: false })]);
			const stats = statsFor(index, "worker", "ornith-1.0");
			assert.equal(stats?.samples, 1);
			assert.equal(stats?.verifiedPasses, 0);
		});

		it("skipped outcomes carry no signal and are excluded from samples", () => {
			const index = computeEvalStats([entry({ status: "skipped" })]);
			assert.equal(statsFor(index, "worker", "ornith-1.0"), undefined);
		});

		it("entries without a model are skipped (pre-ladder history)", () => {
			const index = computeEvalStats([entry({ model: undefined })]);
			assert.equal(index.size, 0);
		});

		it("malformed rows are skipped without throwing", () => {
			const index = computeEvalStats([null, 42, "junk", [], { agent: 7 }, entry({})]);
			assert.equal(index.size, 1);
		});
	});

	describe("coerceEvalStat", () => {
		it("narrows a valid row", () => {
			assert.deepEqual(coerceEvalStat(entry({})), {
				agent: "worker",
				model: "ornith-1.0",
				status: "done",
				verified: true,
			});
		});

		it("returns null for garbage and for rows missing agent/model/status", () => {
			assert.equal(coerceEvalStat(null), null);
			assert.equal(coerceEvalStat("x"), null);
			assert.equal(coerceEvalStat({ agent: "worker", status: "done" }), null);
			assert.equal(coerceEvalStat({ agent: "worker", model: "  ", status: "done" }), null);
		});

		it("defaults a missing verified flag to false", () => {
			const row = { agent: "worker", model: "m", status: "done" };
			assert.equal(coerceEvalStat(row)?.verified, false);
		});
	});

	describe("readAllEvalEntries", () => {
		// Eval paths are keyed by cwdHash under AGENT_DIR, so a unique fake cwd
		// isolates this test; the hashed dir is removed afterwards (mirrors
		// eval-logging.test.ts).
		const fakeCwd = join(tmpdir(), `pi-suite-eval-stats-${process.pid}`);

		before(() => setErrorSink(() => {}));

		after(() => {
			try {
				rmSync(join(evalsDir(fakeCwd), ".."), { recursive: true, force: true });
			} catch {
				/* cleanup */
			}
		});

		it("returns [] when no evals were ever recorded", () => {
			assert.deepEqual(readAllEvalEntries(join(fakeCwd, "never-used")), []);
		});

		it("reads entries across quests and skips corrupt lines without throwing", () => {
			createEvalLog(fakeCwd, "quest-a")(entry({}));
			createEvalLog(fakeCwd, "quest-b")(entry({ agent: "scout" }));
			// Corrupt line injected next to valid ones.
			const dir = join(evalsDir(fakeCwd), "quest-c");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "evals.jsonl"), '{"agent":"worker"\nnot json\n');

			const all = readAllEvalEntries(fakeCwd);
			assert.equal(all.length, 2, "two valid entries, corrupt file contributes none");
			const index = computeEvalStats(all);
			assert.ok(statsFor(index, "worker", "ornith-1.0"));
			assert.ok(statsFor(index, "scout", "ornith-1.0"));
		});
	});

	describe("computeEvalTimeSeries", () => {
		const DAY_1 = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC
		const DAY_2 = DAY_1 + 86_400_000; // 2023-11-15 (+1 day)

		it("returns empty buckets for no entries", () => {
			const ts = computeEvalTimeSeries([]);
			assert.deepEqual(ts.buckets, []);
		});

		it("groups entries by day with pass rate and duration", () => {
			const ts = computeEvalTimeSeries([
				entry({ timestamp: DAY_1, status: "done", verified: true, durationMs: 2000 }),
				entry({ timestamp: DAY_1, status: "done", verified: false, durationMs: 1000 }),
				entry({ timestamp: DAY_1, status: "failed", verified: false, durationMs: 500 }),
				entry({ timestamp: DAY_2, status: "done", verified: true, durationMs: 3000 }),
			]);

			assert.equal(ts.buckets.length, 2);
			// newest first
			assert.equal(ts.buckets[0].date, "2023-11-15");
			assert.equal(ts.buckets[0].samples, 1);
			assert.equal(ts.buckets[0].passRate, 1);
			assert.equal(ts.buckets[0].avgDurationMs, 3000);

			assert.equal(ts.buckets[1].date, "2023-11-14");
			assert.equal(ts.buckets[1].samples, 3);
			assert.ok(Math.abs(ts.buckets[1].passRate - 1 / 3) < 1e-9);
			// avgDuration = (2000 + 1000 + 500) / 3 ≈ 1167
			assert.equal(ts.buckets[1].avgDurationMs, 1167);
		});

		it("counts escalations", () => {
			const ts = computeEvalTimeSeries([
				entry({ timestamp: DAY_1, escalations: 2 }),
				entry({ timestamp: DAY_1, escalations: 0 }),
				entry({ timestamp: DAY_1, escalations: 1 }),
			]);
			assert.equal(ts.buckets.length, 1);
			assert.equal(ts.buckets[0].escalations, 3);
		});

		it("skips entries without model, timestamp, or with skipped status", () => {
			const ts = computeEvalTimeSeries([
				entry({ model: undefined, timestamp: DAY_1 }),
				entry({ status: "skipped", timestamp: DAY_1 }),
				entry({ timestamp: 0 }), // invalid timestamp
				entry({ timestamp: DAY_1 }),
			]);
			assert.equal(ts.buckets.length, 1);
			assert.equal(ts.buckets[0].samples, 1);
		});

		it("handles zero-duration entries (returns 0 avg)", () => {
			const ts = computeEvalTimeSeries([entry({ timestamp: DAY_1, durationMs: 0 })]);
			assert.equal(ts.buckets[0].avgDurationMs, 0);
		});

		it("malformed rows are skipped without throwing", () => {
			const ts = computeEvalTimeSeries([null, 42, "junk", [], entry({ timestamp: DAY_1 })]);
			assert.equal(ts.buckets.length, 1);
			assert.equal(ts.buckets[0].samples, 1);
		});
	});
});
