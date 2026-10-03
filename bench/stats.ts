/**
 * Pure aggregation over bench results: pass rates with Wilson intervals,
 * cost per pass, and a paired per-task comparison between two arms.
 */
import { BENCH } from "./config";
import type { BenchResult } from "./types";

/** Wilson score interval for k successes in n trials. [0, 0] when n is 0. */
export function wilson(k: number, n: number, z: number = BENCH.z): [number, number] {
	if (n <= 0) return [0, 0];
	const p = k / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Runs the harness itself broke on say nothing about the agent; drop them. */
export function scoredResults(results: readonly BenchResult[]): BenchResult[] {
	return results.filter((r) => !r.harnessError);
}

/** Aggregate over one slice of runs (an arm, or an arm × task cell). */
export interface Aggregate {
	runs: number;
	passes: number;
	passRate: number;
	ci: [number, number];
	totalCost: number;
	/** Total spend divided by passes; null when nothing passed. */
	costPerPass: number | null;
	medianTokens: number;
	medianDurationMs: number;
	timeouts: number;
}

export function aggregate(results: readonly BenchResult[]): Aggregate {
	const runs = results.length;
	const passes = results.filter((r) => r.grade.passed).length;
	const totalCost = results.reduce((s, r) => s + r.usage.cost, 0);
	return {
		runs,
		passes,
		passRate: runs ? passes / runs : 0,
		ci: wilson(passes, runs),
		totalCost,
		costPerPass: passes ? totalCost / passes : null,
		medianTokens: median(results.map((r) => r.usage.input + r.usage.output + r.usage.cacheRead)),
		medianDurationMs: median(results.map((r) => r.durationMs)),
		timeouts: results.filter((r) => r.timedOut).length,
	};
}

/** Group key for an arm on a model — the unit two configurations are compared on. */
export function armKey(r: Pick<BenchResult, "arm" | "model" | "thinking">): string {
	return `${r.arm} · ${r.model}:${r.thinking}`;
}

export function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k);
		if (list) list.push(item);
		else out.set(k, [item]);
	}
	return out;
}

/** Per-task pass rates of two arms, and how many tasks each one wins. */
export interface PairedComparison {
	a: string;
	b: string;
	/** Tasks both arms ran. */
	tasks: number;
	aWins: number;
	bWins: number;
	ties: number;
	/** Mean of (passRate_b − passRate_a) over shared tasks. */
	meanDelta: number;
}

/**
 * Compare arms on the tasks both ran. Task difficulty dominates pass-rate
 * variance, so comparing per task is fairer than comparing pooled rates when
 * the arms didn't run identical task sets.
 */
export function pairedCompare(
	results: readonly BenchResult[],
	a: string,
	b: string,
): PairedComparison {
	const byTask = groupBy(results, (r) => r.taskId);
	let tasks = 0;
	let aWins = 0;
	let bWins = 0;
	let deltaSum = 0;
	for (const runs of byTask.values()) {
		const ra = runs.filter((r) => armKey(r) === a);
		const rb = runs.filter((r) => armKey(r) === b);
		if (ra.length === 0 || rb.length === 0) continue;
		tasks++;
		const pa = aggregate(ra).passRate;
		const pb = aggregate(rb).passRate;
		deltaSum += pb - pa;
		if (pb > pa) bWins++;
		else if (pa > pb) aWins++;
	}
	return {
		a,
		b,
		tasks,
		aWins,
		bWins,
		ties: tasks - aWins - bWins,
		meanDelta: tasks ? deltaSum / tasks : 0,
	};
}
