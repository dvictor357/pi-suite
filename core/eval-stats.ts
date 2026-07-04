/**
 * Pure reader over the per-task eval audit trail (see ./eval-logging).
 *
 * The eval log is written on every terminal task outcome but until now nothing
 * read it back. This module closes that loop: it aggregates all eval JSONL
 * files for a project into per-(agent role, model) verified-pass rates, which
 * the quest model ladder uses to pick a starting rung ("has this cheap model
 * historically handled this role here?").
 *
 * It also produces daily time-series summaries (pass rates, durations,
 * escalations by role/model/day) for trend visibility and diagnostics.
 *
 * Everything is best-effort: the files are untrusted (older contracts,
 * partial writes, hand edits), so rows are coerced field-by-field and any
 * unreadable file or line is skipped. No function here throws.
 *
 * Pure Node.js — no pi-* imports.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evalsDir } from "./eval-logging";
import { asRecord, boolOr, numOr, optStr, strOr } from "./coerce";

// ── Types ────────────────────────────────────────────────────────────────────

/** Aggregated outcome history for one (agent role, model) pair. */
export interface RoleModelStats {
	agent: string;
	model: string;
	/** Terminal done/failed outcomes seen (skipped carries no capability signal). */
	samples: number;
	/** Outcomes that finished "done" with verifier approval. */
	verifiedPasses: number;
	/** verifiedPasses / samples. */
	passRate: number;
}

/** Index of stats keyed by (agent, model); see {@link statsKey}. */
export type EvalStatsIndex = Map<string, RoleModelStats>;

/** One daily aggregation bucket in the eval time series. */
export interface EvalTimeBucket {
	/** ISO date string (YYYY-MM-DD). */
	date: string;
	/** Terminal (done/failed) outcomes in this bucket. */
	samples: number;
	/** Verified passes / samples. */
	passRate: number;
	/** Average wall-clock duration in ms. 0 when no timing data. */
	avgDurationMs: number;
	/** Total model-ladder escalations across tasks in this bucket. */
	escalations: number;
}

/** Daily time-series summary of eval outcomes. */
export interface EvalTimeSeries {
	/** Per-day buckets, newest first. */
	buckets: EvalTimeBucket[];
}

/** The fields of an eval row that routing actually needs. */
interface EvalStatSample {
	agent: string;
	model: string;
	status: string;
	verified: boolean;
}

/** The fields of an eval row that time-series aggregation needs. */
interface EvalTimeSample {
	timestamp: number;
	status: string;
	verified: boolean;
	durationMs: number;
	escalations: number;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Read every eval entry recorded for this project, across all quests, as raw
 * parsed JSON values. Missing dir, unreadable file, or corrupt line → skipped.
 */
export function readAllEvalEntries(cwd: string): unknown[] {
	const entries: unknown[] = [];
	let slugs: string[];
	try {
		slugs = readdirSync(evalsDir(cwd));
	} catch {
		return entries; // no evals recorded yet
	}
	for (const slug of slugs) {
		let raw: string;
		try {
			raw = readFileSync(join(evalsDir(cwd), slug, "evals.jsonl"), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* corrupt line — skip */
			}
		}
	}
	return entries;
}

/**
 * Narrow one untrusted eval row to the fields routing needs, or null when the
 * row can't inform routing (no model recorded — true for entries written
 * before the ladder stamped `lastModel`, which are deliberately ignored rather
 * than guessed at).
 */
export function coerceEvalStat(value: unknown): EvalStatSample | null {
	const rec = asRecord(value);
	const agent = strOr(rec.agent, "");
	const model = optStr(rec.model)?.trim() ?? "";
	const status = strOr(rec.status, "");
	if (!agent || !model || !status) return null;
	return { agent, model, status, verified: boolOr(rec.verified, false) };
}

/**
 * Narrow one untrusted eval row to the fields time-series aggregation needs.
 * Skips rows with missing timestamp, skipped outcomes, and entries without
 * a model (pre-ladder history), like {@link coerceEvalStat}.
 */
function coerceEvalTimeSample(value: unknown): EvalTimeSample | null {
	const rec = asRecord(value);
	const status = strOr(rec.status, "");
	if (status !== "done" && status !== "failed") return null;
	const model = optStr(rec.model)?.trim() ?? "";
	if (!model) return null;
	const timestamp = numOr(rec.timestamp, NaN);
	if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
	return {
		timestamp,
		status,
		verified: boolOr(rec.verified, false),
		durationMs: numOr(rec.durationMs, 0),
		escalations: numOr(rec.escalations, 0),
	};
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/** Index key for one (agent role, model) pair (NUL-joined so it cannot collide). */
export function statsKey(agent: string, model: string): string {
	return `${agent}\u0000${model}`;
}

/** Aggregate raw eval entries into per-(agent, model) verified-pass rates. */
export function computeEvalStats(entries: unknown[]): EvalStatsIndex {
	const index: EvalStatsIndex = new Map();
	for (const entry of entries) {
		const sample = coerceEvalStat(entry);
		// Skipped steps say nothing about whether the model could have done the
		// work, so they don't count toward the denominator.
		if (!sample || (sample.status !== "done" && sample.status !== "failed")) continue;
		const key = statsKey(sample.agent, sample.model);
		let stats = index.get(key);
		if (!stats) {
			stats = {
				agent: sample.agent,
				model: sample.model,
				samples: 0,
				verifiedPasses: 0,
				passRate: 0,
			};
			index.set(key, stats);
		}
		stats.samples++;
		if (sample.status === "done" && sample.verified) stats.verifiedPasses++;
		stats.passRate = stats.verifiedPasses / stats.samples;
	}
	return index;
}

/** Look up the history for one (agent role, model) pair, if any. */
export function statsFor(
	index: EvalStatsIndex,
	agent: string,
	model: string,
): RoleModelStats | undefined {
	return index.get(statsKey(agent, model));
}

// ── Time-series aggregation ──────────────────────────────────────────────────

/** Format a timestamp as YYYY-MM-DD (UTC, no external deps). */
function isoDate(ts: number): string {
	const d = new Date(ts);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Aggregate raw eval entries into daily time buckets with pass rates, average
 * duration, and total escalations. Buckets are sorted newest first.
 *
 * Like {@link computeEvalStats}, skipped outcomes and entries without a
 * model are excluded. Entries with no timestamp are skipped.
 */
export function computeEvalTimeSeries(entries: unknown[]): EvalTimeSeries {
	// ponytail: single-pass Map keyed by YYYY-MM-DD, sort at end
	const days = new Map<
		string,
		{ samples: number; passes: number; totalDurationMs: number; escalations: number }
	>();

	for (const entry of entries) {
		const s = coerceEvalTimeSample(entry);
		if (!s) continue;

		const date = isoDate(s.timestamp);
		let bucket = days.get(date);
		if (!bucket) {
			bucket = { samples: 0, passes: 0, totalDurationMs: 0, escalations: 0 };
			days.set(date, bucket);
		}
		bucket.samples++;
		if (s.status === "done" && s.verified) bucket.passes++;
		if (s.durationMs > 0) bucket.totalDurationMs += s.durationMs;
		bucket.escalations += s.escalations;
	}

	const buckets: EvalTimeBucket[] = [];
	for (const [date, b] of days) {
		buckets.push({
			date,
			samples: b.samples,
			passRate: b.samples > 0 ? b.passes / b.samples : 0,
			avgDurationMs: b.samples > 0 ? Math.round(b.totalDurationMs / b.samples) : 0,
			escalations: b.escalations,
		});
	}
	buckets.sort((a, b) => b.date.localeCompare(a.date)); // newest first

	return { buckets };
}
