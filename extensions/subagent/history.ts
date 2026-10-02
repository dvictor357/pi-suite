/**
 * Run history for the subagent tool.
 *
 * Every tool call that ran at least one agent is saved as one JSON file under
 * <agent dir>/subagent-runs/<cwdHash>/ (agent dir = ~/.pi/agent unless
 * PI_CODING_AGENT_DIR is set) — outside the repo, so transcripts
 * (which may contain file contents) never end up in commits. The newest
 * MAX_RUNS_PER_PROJECT runs are kept.
 *
 * Also plans re-runs: given a stored run, build the params that redo only its
 * failed work.
 */

import { cwdHash } from "../../core";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BudgetSnapshot } from "./budget.js";
import { formatStructured, substitutePrevious } from "./contract.js";

export const RUN_RECORD_VERSION = 1;
export const MAX_RUNS_PER_PROJECT = 50;
/** Longest text part kept per message; larger tool outputs are truncated. */
const MAX_PART_CHARS = 16 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;

export type RunMode = "single" | "parallel" | "chain" | "pipeline";
export type RunStatus = "succeeded" | "partial" | "failed" | "aborted";

/** Minimal result shape history needs; SingleResult satisfies it. */
export interface RecordedResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: { cost: number; input: number; output: number; turns: number };
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	model?: string;
	worktree?: { branch?: string; diffStat: string; error?: string };
	structured?: unknown;
}

export interface RunRecord {
	version: number;
	id: string;
	cwd: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	mode: RunMode;
	status: RunStatus;
	/** Tool params exactly as called (after any rerun expansion). */
	params: Record<string, unknown>;
	outputText: string;
	results: RecordedResult[];
	budget?: BudgetSnapshot;
	rerunOf?: string;
}

export function historyRoot(): string {
	return path.join(getAgentDir(), "subagent-runs");
}

export function projectHistoryDir(cwd: string, root = historyRoot()): string {
	return path.join(root, cwdHash(cwd));
}

/** Sortable, short id: base36 timestamp + random suffix. */
export function newRunId(now = Date.now()): string {
	return `${now.toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}

export function isFailed(result: RecordedResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "budget" ||
		result.stopReason === "invalid_output"
	);
}

export function runStatus(results: RecordedResult[], aborted: boolean): RunStatus {
	if (aborted) return "aborted";
	const failed = results.filter(isFailed).length;
	if (failed === 0) return "succeeded";
	return failed === results.length ? "failed" : "partial";
}

function truncate(text: string, max: number): string {
	return text.length <= max
		? text
		: `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function compactMessages(messages: Message[]): Message[] {
	return messages.map((msg) => {
		if (!Array.isArray(msg.content)) return msg;
		return {
			...msg,
			content: msg.content.map((part) =>
				part.type === "text" && part.text.length > MAX_PART_CHARS
					? { ...part, text: truncate(part.text, MAX_PART_CHARS) }
					: part,
			),
		} as Message;
	});
}

export function saveRun(record: RunRecord, root = historyRoot()): string {
	const dir = projectHistoryDir(record.cwd, root);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const compacted: RunRecord = {
		...record,
		outputText: truncate(record.outputText, MAX_OUTPUT_CHARS),
		results: record.results.map((r) => ({
			...r,
			messages: compactMessages(r.messages),
		})),
	};
	const file = path.join(dir, `${record.id}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(compacted), { mode: 0o600 });
	fs.renameSync(tmp, file);
	pruneRuns(dir);
	return file;
}

function runFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
}

function pruneRuns(dir: string): void {
	const files = runFiles(dir);
	for (const f of files.slice(0, Math.max(0, files.length - MAX_RUNS_PER_PROJECT))) {
		try {
			fs.unlinkSync(path.join(dir, f));
		} catch {
			/* already gone */
		}
	}
}

function readRecord(file: string): RunRecord | null {
	try {
		const record = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
		return record?.version === RUN_RECORD_VERSION ? record : null;
	} catch {
		return null;
	}
}

/** Newest first. */
export function listRuns(cwd: string, limit = 20, root = historyRoot()): RunRecord[] {
	const dir = projectHistoryDir(cwd, root);
	return runFiles(dir)
		.reverse()
		.slice(0, limit)
		.map((f) => readRecord(path.join(dir, f)))
		.filter((r): r is RunRecord => r !== null);
}

/** Load by exact id or unique prefix. Throws with a helpful message otherwise. */
export function loadRun(cwd: string, idOrPrefix: string, root = historyRoot()): RunRecord {
	const dir = projectHistoryDir(cwd, root);
	const wanted = idOrPrefix.trim();
	const matches = runFiles(dir).filter((f) => f.startsWith(wanted));
	if (!wanted || matches.length === 0)
		throw new Error(
			`No subagent run matching ${JSON.stringify(idOrPrefix)} for ${cwd}. List runs with /subagent runs.`,
		);
	if (matches.length > 1)
		throw new Error(
			`Run id ${JSON.stringify(idOrPrefix)} is ambiguous (${matches.length} matches); use more characters.`,
		);
	const record = readRecord(path.join(dir, matches[0]));
	if (!record) throw new Error(`Run file ${matches[0]} is unreadable or from another version.`);
	return record;
}

function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) if (part.type === "text") return part.text;
	}
	return "";
}

const MODE_KEYS = ["agent", "task", "tasks", "chain", "items", "stages"];

/**
 * Params that redo a stored run. Scope "failed" keeps only failed or unfinished
 * work; "all" repeats the whole call. `overrides` (e.g. a new maxCost) win over
 * stored options but never over the mode fields. Returns an error string when
 * there is nothing to re-run.
 */
export function planRerun(
	record: RunRecord,
	scope: "failed" | "all",
	overrides: Record<string, unknown> = {},
): { params: Record<string, unknown>; summary: string } | { error: string } {
	const options = { ...record.params, ...overrides };
	for (const key of MODE_KEYS) delete options[key];
	delete options.rerun;
	delete options.rerunScope;
	const p = record.params as {
		agent?: string;
		task?: string;
		tasks?: Array<Record<string, unknown>>;
		chain?: Array<{ task: string } & Record<string, unknown>>;
		items?: string[];
		stages?: unknown[];
	};

	if (scope === "all") {
		const params = { ...options };
		for (const key of MODE_KEYS)
			if (p[key as keyof typeof p] !== undefined) params[key] = p[key as keyof typeof p];
		return { params, summary: `all of run ${record.id}` };
	}

	const nothing = {
		error: `Run ${record.id} has no failed work to re-run (status: ${record.status}). Use rerunScope "all" to repeat it.`,
	};

	switch (record.mode) {
		case "single": {
			if (record.results.length > 0 && !record.results.some(isFailed)) return nothing;
			return {
				params: { ...options, agent: p.agent, task: p.task },
				summary: `single task from run ${record.id}`,
			};
		}
		case "parallel": {
			const tasks = (p.tasks ?? []).filter((_, i) => {
				const r = record.results[i];
				return !r || isFailed(r);
			});
			if (tasks.length === 0) return nothing;
			return {
				params: { ...options, tasks },
				summary: `${tasks.length} of ${p.tasks?.length ?? 0} parallel tasks from run ${record.id}`,
			};
		}
		case "pipeline": {
			const items = (p.items ?? []).filter((_, i) => {
				const r = record.results[i];
				return !r || isFailed(r);
			});
			if (items.length === 0) return nothing;
			return {
				params: { ...options, items, stages: p.stages },
				summary: `${items.length} of ${p.items?.length ?? 0} pipeline items from run ${record.id}`,
			};
		}
		case "chain": {
			const chain = p.chain ?? [];
			let start = record.results.findIndex(isFailed);
			if (start === -1) start = record.results.length;
			if (start >= chain.length) return nothing;
			// Steps before `start` all succeeded, so start - 1 holds a real answer.
			const before = start > 0 ? record.results[start - 1] : undefined;
			const previousText =
				before?.structured !== undefined
					? formatStructured(before.structured)
					: before
						? finalText(before.messages)
						: "";
			const first = substitutePrevious(chain[start].task, previousText, before?.structured);
			if (!first.ok)
				return {
					error: `Cannot resume run ${record.id} at step ${start + 1}: ${first.error}`,
				};
			const resumed = chain
				.slice(start)
				.map((step, i) => (i === 0 ? { ...step, task: first.text } : step));
			return {
				params: { ...options, chain: resumed },
				summary: `chain from step ${start + 1} of ${chain.length} in run ${record.id}`,
			};
		}
	}
}

function formatAge(iso: string, now: number): string {
	const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
	return `${Math.round(sec / 86400)}d ago`;
}

function totalCost(record: RunRecord): number {
	return record.results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
}

export function formatRunList(runs: RunRecord[], now = Date.now()): string {
	if (runs.length === 0) return "No subagent runs recorded for this project yet.";
	const lines = ["Recent subagent runs (newest first):"];
	for (const r of runs) {
		const agents = [...new Set(r.results.map((x) => x.agent))].join(",");
		const failed = r.results.filter(isFailed).length;
		const counts =
			r.results.length > 1 ? ` ${r.results.length - failed}/${r.results.length} ok` : "";
		lines.push(
			`  ${r.id}  ${formatAge(r.startedAt, now).padEnd(8)} ${r.mode.padEnd(8)} ${r.status.padEnd(9)}${counts}  ${agents}  $${totalCost(r).toFixed(4)}${r.rerunOf ? `  (rerun of ${r.rerunOf})` : ""}`,
		);
	}
	lines.push("", "Details: /subagent show <id> · Re-run failed work: /subagent rerun <id>");
	return lines.join("\n");
}

export function formatRunDetail(record: RunRecord): string {
	const lines = [
		`Run ${record.id} · ${record.mode} · ${record.status} · ${Math.round(record.durationMs / 1000)}s · $${totalCost(record).toFixed(4)}`,
		`Started ${record.startedAt} in ${record.cwd}`,
	];
	if (record.rerunOf) lines.push(`Re-run of ${record.rerunOf}`);
	if (record.budget?.exceeded) lines.push("Budget exceeded during this run.");
	record.results.forEach((r, i) => {
		const status = isFailed(r)
			? `failed${r.stopReason && r.stopReason !== "stop" ? ` (${r.stopReason})` : ""}`
			: "ok";
		const label = r.step !== undefined ? `step ${r.step}` : `#${i + 1}`;
		lines.push(
			"",
			`── ${label} ${r.agent} · ${status} · ${r.usage?.turns ?? 0} turns${r.model ? ` · ${r.model}` : ""}`,
			`Task: ${truncate(r.task, 300)}`,
		);
		const output = isFailed(r)
			? r.errorMessage || r.stderr || finalText(r.messages)
			: finalText(r.messages);
		lines.push(truncate(output || "(no output)", 1500));
		if (r.worktree?.branch)
			lines.push(`Worktree branch: ${r.worktree.branch} (${r.worktree.diffStat})`);
		else if (r.worktree?.error) lines.push(`Worktree error: ${r.worktree.error}`);
	});
	return lines.join("\n");
}
