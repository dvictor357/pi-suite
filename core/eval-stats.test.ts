import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	computeEvalStats,
	computeEvalTimeSeries,
	computeThinkingStats,
	coerceEvalStat,
	formatEvalStatsReport,
	readAllEvalEntries,
	sortRoleModelStats,
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
	describe("computeEvalStats usage", () => {
		it("prices a verified pass from tracked rows only", () => {
			const index = computeEvalStats([
				// Legacy row: tokensIn 0, no turns — counts for pass rate, not for cost.
				entry({ status: "done", verified: true }),
				entry({
					status: "failed",
					verified: false,
					tokensIn: 900,
					tokensOut: 100,
					cost: 0.01,
					turns: 2,
				}),
				entry({
					status: "done",
					verified: true,
					tokensIn: 1800,
					tokensOut: 200,
					cost: 0.02,
					turns: 3,
				}),
			]);
			const worker = statsFor(index, "worker", "ornith-1.0")!;
			assert.equal(worker.samples, 3);
			assert.ok(worker.usage);
			assert.equal(worker.usage.samples, 2);
			assert.equal(worker.usage.verifiedPasses, 1);
			assert.equal(worker.usage.tokens, 3000);
			// The failed attempt's spend is part of what the one success cost.
			assert.ok(Math.abs(worker.usage.costPerVerifiedPass! - 0.03) < 1e-12);
			assert.equal(worker.usage.tokensPerVerifiedPass, 3000);
		});

		it("omits usage when no row was tracked, and cost/pass when nothing passed", () => {
			const legacy = computeEvalStats([entry({})]);
			assert.equal(statsFor(legacy, "worker", "ornith-1.0")!.usage, undefined);

			const failing = computeEvalStats([
				entry({ status: "failed", verified: false, tokensIn: 10, cost: 0.001, turns: 1 }),
			]);
			const u = statsFor(failing, "worker", "ornith-1.0")!.usage!;
			assert.equal(u.samples, 1);
			assert.equal(u.costPerVerifiedPass, undefined);
			assert.match(formatEvalStatsReport(failing, { buckets: [] }), /no pass \(n=1\)/);
		});

		it("renders cost per verified pass in the report", () => {
			const index = computeEvalStats([
				entry({ tokensIn: 10, tokensOut: 5, cost: 0.0042, turns: 1 }),
			]);
			assert.match(formatEvalStatsReport(index, { buckets: [] }), /\$0\.0042 \(n=1\)/);
		});
	});

	describe("computeThinkingStats", () => {
		it("aggregates per (agent, thinking), skipping rows without a thinking level", () => {
			const rows = computeThinkingStats([
				entry({ thinking: "high", status: "done", verified: true, cost: 0.02, turns: 2 }),
				entry({ thinking: "high", status: "failed", verified: false, cost: 0.02, turns: 2 }),
				entry({ thinking: "low", status: "done", verified: true }),
				entry({ status: "done", verified: true }), // legacy: no thinking
				entry({ thinking: "low", status: "skipped", verified: false }),
				entry({ agent: "scout", thinking: "minimal" }),
			]);
			assert.deepEqual(
				rows.map((r) => [r.agent, r.thinking, r.samples, r.verifiedPasses]),
				[
					["scout", "minimal", 1, 1],
					["worker", "low", 1, 1],
					["worker", "high", 2, 1],
				],
			);
			const high = rows[2];
			assert.ok(Math.abs(high.usage!.costPerVerifiedPass! - 0.04) < 1e-12);
			assert.equal(rows[1].usage, undefined, "untracked rows carry no spend");
		});

		it("renders a Role / Thinking section only when there is data", () => {
			const index = computeEvalStats([entry({})]);
			assert.doesNotMatch(formatEvalStatsReport(index, { buckets: [] }), /Role \/ Thinking/);
			const text = formatEvalStatsReport(
				index,
				{ buckets: [] },
				computeThinkingStats([entry({ thinking: "medium" })]),
			);
			assert.match(text, /## Role \/ Thinking \(1 pairs\)/);
			assert.match(text, /\| worker \| medium \| 1 \| 100% \| — \|/);
		});
	});

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

	describe("formatEvalStatsReport", () => {
		const DAY_1 = 1_700_000_000_000; // 2023-11-14 UTC

		it("returns a clear empty-project message when no data", () => {
			const text = formatEvalStatsReport(new Map(), { buckets: [] });
			assert.match(text, /No eval data recorded yet/);
			assert.doesNotMatch(text, /## /);
		});

		it("renders role/model table with agent, model, samples, verified pass %", () => {
			const index = computeEvalStats([
				entry({ status: "done", verified: true }),
				entry({ status: "done", verified: true }),
				entry({ status: "failed", verified: false }),
				entry({ agent: "scout", model: "mythos-5", status: "done", verified: true }),
			]);
			const text = formatEvalStatsReport(index, { buckets: [] });

			assert.match(text, /## Role \/ Model Pass Rates \(2 pairs\)/);
			assert.match(
				text,
				/\| Agent \| Model \| Samples \| Verified Pass % \| Cost \/ Verified Pass \|/,
			);
			assert.match(text, /\| scout \| mythos-5 \| 1 \| 100% \|/);
			assert.match(text, /\| worker \| ornith-1\.0 \| 3 \| 67% \|/);
			// Daily series section omitted when empty
			assert.doesNotMatch(text, /Eval Time Series/);
		});

		it("retains daily time series alongside role/model table", () => {
			const rows = [
				entry({
					timestamp: DAY_1,
					status: "done",
					verified: true,
					durationMs: 2000,
					escalations: 1,
				}),
				entry({
					timestamp: DAY_1,
					status: "failed",
					verified: false,
					durationMs: 1000,
					escalations: 0,
				}),
			];
			const index = computeEvalStats(rows);
			const series = computeEvalTimeSeries(rows);
			const text = formatEvalStatsReport(index, series);

			assert.match(text, /## Role \/ Model Pass Rates/);
			assert.match(text, /## Eval Time Series \(1 days\)/);
			assert.match(text, /\| Date\s+\| Samples \| Pass % \| Avg Dur \| Escalations \|/);
			assert.match(text, /2023-11-14/);
			// avg of 2000ms + 1000ms = 1500ms → "1.5s"
			assert.match(text, /1\.5s/);
			assert.match(text, /\|\s*1\s*\|/); // 1 escalation total
		});

		it("sortRoleModelStats is stable: agent ASC, model ASC", () => {
			const index = computeEvalStats([
				entry({ agent: "worker", model: "z-model" }),
				entry({ agent: "scout", model: "a-model" }),
				entry({ agent: "worker", model: "a-model" }),
			]);
			const sorted = sortRoleModelStats(index);
			assert.deepEqual(
				sorted.map((r) => `${r.agent}/${r.model}`),
				["scout/a-model", "worker/a-model", "worker/z-model"],
			);
		});
	});
});
