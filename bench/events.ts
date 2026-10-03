/**
 * Fold a `pi --mode json` event stream into one {@link RunUsage}.
 *
 * Main-agent spend comes from assistant `message_end` records. Sub-agent spend
 * is invisible there (each sub-agent is its own child process), so it is read
 * from the `details.results[].usage` that pi-minions puts on every `subagent`
 * tool result, and from `details.usage` on `quest_delegate` results.
 */
import type { RunUsage } from "./types";

export function emptyRunUsage(): RunUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		subagentRuns: 0,
		subagentCost: 0,
		toolCalls: {},
	};
}

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Cost may be a bare number (pi-minions UsageStats) or pi's `{ total }` breakdown. */
const costOf = (v: unknown): number => (typeof v === "number" ? num(v) : num(rec(v).total));

function addTokens(usage: RunUsage, raw: unknown): number {
	const u = rec(raw);
	usage.input += num(u.input);
	usage.output += num(u.output);
	usage.cacheRead += num(u.cacheRead);
	usage.cacheWrite += num(u.cacheWrite);
	const cost = costOf(u.cost);
	usage.cost += cost;
	return cost;
}

/** Apply one parsed event to the running totals. Unknown events are ignored. */
export function foldEvent(usage: RunUsage, event: unknown): void {
	const e = rec(event);
	if (e.type === "message_end") {
		const msg = rec(e.message);
		if (msg.role !== "assistant") return;
		usage.turns++;
		addTokens(usage, msg.usage);
		const content = Array.isArray(msg.content) ? msg.content : [];
		for (const part of content) {
			const p = rec(part);
			if (p.type === "toolCall" && typeof p.name === "string") {
				usage.toolCalls[p.name] = (usage.toolCalls[p.name] ?? 0) + 1;
			}
		}
		return;
	}
	// quest_delegate runs its sub-agent in-process and reports one `details.usage`.
	if (e.type === "tool_execution_end" && e.toolName === "quest_delegate") {
		const u = rec(rec(e.result).details).usage;
		if (u) {
			usage.subagentRuns++;
			usage.subagentCost += addTokens(usage, u);
		}
		return;
	}
	if (e.type === "tool_execution_end" && e.toolName === "subagent") {
		const results = rec(rec(e.result).details).results;
		if (!Array.isArray(results)) return;
		for (const r of results) {
			usage.subagentRuns++;
			usage.subagentCost += addTokens(usage, rec(r).usage);
		}
	}
}

/**
 * Parse a whole JSONL stream. Splits on LF only — pi's JSON strings may contain
 * U+2028/U+2029, which are not record boundaries. Malformed lines are skipped.
 */
export function usageFromJsonl(text: string): RunUsage {
	const usage = emptyRunUsage();
	for (const raw of text.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		foldEvent(usage, event);
	}
	return usage;
}
