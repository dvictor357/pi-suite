/**
 * Markdown report over a results file. Pure: takes rows, returns text.
 */
import { BENCH } from "./config";
import { aggregate, armKey, groupBy, pairedCompare, scoredResults, type Aggregate } from "./stats";
import type { BenchResult } from "./types";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number | null) => (x == null ? "—" : `$${x.toFixed(4)}`);
const ktok = (x: number) => `${(x / 1000).toFixed(1)}k`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

function armRow(key: string, a: Aggregate): string {
	return `| ${key} | ${a.passes}/${a.runs} | ${pct(a.passRate)} | ${pct(a.ci[0])}–${pct(a.ci[1])} | ${usd(a.costPerPass)} | ${usd(a.totalCost)} | ${ktok(a.medianTokens)} | ${secs(a.medianDurationMs)} | ${a.timeouts} |`;
}

export function formatReport(all: readonly BenchResult[]): string {
	const results = scoredResults(all);
	const broken = all.length - results.length;
	if (results.length === 0) {
		return broken ? `No scored runs — all ${broken} runs hit harness errors.` : "No runs recorded.";
	}

	const byArm = groupBy(results, armKey);
	const armKeys = [...byArm.keys()].sort();
	const out: string[] = [
		`# Bench report`,
		"",
		`${results.length} scored runs over ${new Set(results.map((r) => r.taskId)).size} tasks` +
			(broken ? ` (${broken} harness errors excluded)` : "") +
			`. Pass = every hidden test passes. CI = Wilson ${Math.round(normalConfidence(BENCH.z) * 100)}%.`,
		"",
		"## By arm",
		"",
		"| Arm | Passes | Pass % | CI | Cost / pass | Total cost | Median tokens | Median time | Timeouts |",
		"|-----|--------|--------|----|-------------|------------|---------------|-------------|----------|",
		...armKeys.map((k) => armRow(k, aggregate(byArm.get(k)!))),
	];

	const taskIds = [...new Set(results.map((r) => r.taskId))].sort();
	out.push(
		"",
		"## By task",
		"",
		`| Task | ${armKeys.join(" | ")} |`,
		`|------|${armKeys.map(() => "---").join("|")}|`,
	);
	for (const task of taskIds) {
		const cells = armKeys.map((k) => {
			const runs = byArm.get(k)!.filter((r) => r.taskId === task);
			if (runs.length === 0) return "—";
			const a = aggregate(runs);
			return `${a.passes}/${a.runs} ${usd(a.costPerPass)}`;
		});
		out.push(`| ${task} | ${cells.join(" | ")} |`);
	}

	if (armKeys.length >= 2) {
		out.push("", "## Paired (per task)", "");
		for (let i = 0; i < armKeys.length; i++) {
			for (let j = i + 1; j < armKeys.length; j++) {
				const c = pairedCompare(results, armKeys[i], armKeys[j]);
				if (c.tasks === 0) continue;
				const sign = c.meanDelta >= 0 ? "+" : "";
				out.push(
					`- **${c.b}** vs **${c.a}**: wins ${c.bWins}, loses ${c.aWins}, ties ${c.ties} ` +
						`over ${c.tasks} tasks; mean pass-rate delta ${sign}${Math.round(c.meanDelta * 100)} pts`,
				);
			}
		}
	}

	out.push(
		"",
		"Read with care: overlapping CIs mean the data does not yet separate the arms.",
		"Add trials or tasks before drawing conclusions.",
	);
	return out.join("\n");
}

/** Two-sided confidence level for a z score (enough precision for a label). */
function normalConfidence(z: number): number {
	// Abramowitz–Stegun erf approximation, |error| < 1.5e-7.
	const x = z / Math.SQRT2;
	const t = 1 / (1 + 0.3275911 * x);
	const y =
		1 -
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
			t *
			Math.exp(-x * x);
	return y;
}
