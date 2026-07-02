/**
 * Pure reader over the per-task eval audit trail (see ./eval-logging).
 *
 * The eval log is written on every terminal task outcome but until now nothing
 * read it back. This module closes that loop: it aggregates all eval JSONL
 * files for a project into per-(agent role, model) verified-pass rates, which
 * the quest model ladder uses to pick a starting rung ("has this cheap model
 * historically handled this role here?").
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
import { asRecord, boolOr, optStr, strOr } from "./coerce";

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

/** The fields of an eval row that routing actually needs. */
interface EvalStatSample {
	agent: string;
	model: string;
	status: string;
	verified: boolean;
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
