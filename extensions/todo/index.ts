/**
 * todo.ts — persistent task ledger with sub-agent delegation for pi
 *
 * Structured progress ledger that survives crashes, compactions, and restarts.
 * Enhanced with sub-agent delegation: each item can carry focused context for
 * a sub-agent, so pipelines stay lean — sub-agents get only what they need.
 *
 *   • Tool `todo_write` — the agent submits the FULL list each time (replace,
 *     not append). Exactly one item may be "in_progress" at a time.
 *   • Delegation — items can be marked `delegated` with an agent assignment and
 *     focused context. The main agent farms them out via `subagent` and marks
 *     them completed when results come back.
 *   • Persisted per-project to ~/.pi/agent/tmp/todos/<cwd-hash>.json.
 *   • Archives completed lists so you can browse history.
 *   • Live status-bar badge: ▶ 3/8 (with ☑ when all done).
 *
 * Commands:
 *   /todo                  — show current list
 *   /todo clear            — archive current list and start fresh
 *   /todo history [N]      — browse past N lists (default 5)
 *   /todo delegate <idx>   — quick delegate an item
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import {
	AGENT_DIR,
	cwdHash,
	readJSON,
	writeJSON,
	writeSessionMeta,
	todoListPath,
	asRecord,
	numOr,
	optStr,
	optNum,
	strOr,
	oneOf,
} from "../../core";
import type { TodoItem, TodoList, TodoStatus as Status } from "../../core";
import { treePrefix, visibleOrder } from "./display";

const MAX_ITEMS = 30;
const TRUNCATE_AT = 10;
const PROGRESS_BAR_WIDTH = 20;
const CONTENT_MAX = 80;
const SECONDARY_MAX = 50;

const TODO_DIR = join(AGENT_DIR, "tmp", "todos");
const ARCHIVE_DIR = join(TODO_DIR, "archive");

// ── Storage ──────────────────────────────────────────────────────────────────

function archivePath(cwd: string, timestamp: number): string {
	return join(ARCHIVE_DIR, `${cwdHash(cwd)}-${timestamp}.json`);
}

/**
 * A cheap change-stamp for the store file: modification time AND size. Either
 * changing invalidates the in-memory cache, so an out-of-band write (e.g. when
 * pi-quest updates the todo file) is detected even if mtime resolution is too
 * coarse to distinguish two writes within the same tick.
 */
function storeStamp(cwd: string): string | null {
	try {
		const p = todoListPath(cwd);
		if (!existsSync(p)) return null;
		const s = statSync(p);
		return `${s.mtimeMs}:${s.size}`;
	} catch {
		return null;
	}
}

const TODO_STATUSES: Status[] = ["pending", "in_progress", "completed", "delegated"];

/** Narrow one untrusted disk value into a TodoItem, or null if it isn't a valid item. */
function coerceTodoItem(value: unknown): TodoItem | null {
	const i = asRecord(value);
	if (typeof i.content !== "string" || !oneOf(i.status, TODO_STATUSES)) return null;
	return {
		content: i.content,
		status: i.status,
		agent: optStr(i.agent),
		context: optStr(i.context),
		result: optStr(i.result),
		source: optStr(i.source),
		sourceId: optStr(i.sourceId),
		sourceIndex: optNum(i.sourceIndex),
		level: optNum(i.level),
		createdAt: numOr(i.createdAt, Date.now()),
		completedAt: optNum(i.completedAt) ?? null,
	};
}

function loadTodos(cwd: string): TodoList {
	try {
		const p = todoListPath(cwd);
		if (!existsSync(p)) return { cwd, items: [], version: 1 };
		const raw = asRecord(JSON.parse(readFileSync(p, "utf8")));
		if (Array.isArray(raw.items)) {
			const items = raw.items.map(coerceTodoItem).filter((i): i is TodoItem => i !== null);
			return { cwd: optStr(raw.cwd) ?? cwd, title: optStr(raw.title), items, version: 1 };
		}
	} catch {
		/* corrupt */
	}
	return { cwd, items: [], version: 1 };
}

function saveTodos(list: TodoList): void {
	writeJSON(todoListPath(list.cwd), list);
}

function writeTodoSessionMeta(cwd: string, list: TodoList): void {
	const counts = {
		pending: list.items.filter((i) => i.status === "pending").length,
		inProgress: list.items.filter((i) => i.status === "in_progress").length,
		delegated: list.items.filter((i) => i.status === "delegated").length,
		completed: list.items.filter((i) => i.status === "completed").length,
	};
	writeSessionMeta("todo", cwd, {
		title: list.title ?? null,
		total: list.items.length,
		...counts,
	});
}

const TODO_ARCHIVE_INDEX_PATH = join(ARCHIVE_DIR, "archive-index.json");

/** One row of the archive index: enough to list a past list without opening it. */
interface ArchiveEntry {
	path: string;
	title: string | null;
	items: number;
	completed: number;
	archivedAt: number;
	cwdHash: string;
}

/** Narrow one untrusted index row into an ArchiveEntry, or null if it has no path. */
function coerceArchiveEntry(value: unknown): ArchiveEntry | null {
	const e = asRecord(value);
	if (typeof e.path !== "string") return null;
	const title = optStr(e.title);
	return {
		path: e.path,
		title: title && title.length > 0 ? title : null,
		items: numOr(e.items, 0),
		completed: numOr(e.completed, 0),
		archivedAt: numOr(e.archivedAt, 0),
		cwdHash: strOr(e.cwdHash, ""),
	};
}

/** Read the archive index off disk as typed entries (drops malformed rows). */
function readArchiveIndex(): ArchiveEntry[] {
	const raw = asRecord(readJSON<unknown>(TODO_ARCHIVE_INDEX_PATH, { version: 1, entries: [] }));
	return Array.isArray(raw.entries)
		? raw.entries.map(coerceArchiveEntry).filter((e): e is ArchiveEntry => e !== null)
		: [];
}

const byArchivedAtDesc = (a: ArchiveEntry, b: ArchiveEntry): number => b.archivedAt - a.archivedAt;

function updateTodoArchiveIndex(entry: ArchiveEntry): void {
	try {
		const entries = readArchiveIndex().filter((e) => e.path !== entry.path);
		entries.push(entry);
		entries.sort(byArchivedAtDesc);
		writeJSON(TODO_ARCHIVE_INDEX_PATH, { version: 1, entries });
	} catch {
		/* best-effort */
	}
}

function rebuildTodoArchiveIndex(): void {
	try {
		if (!existsSync(ARCHIVE_DIR)) return;
		const entries: ArchiveEntry[] = [];
		const files = readdirSync(ARCHIVE_DIR).filter(
			(f) => f.endsWith(".json") && f !== "archive-index.json",
		);
		for (const f of files) {
			try {
				const raw = asRecord(JSON.parse(readFileSync(join(ARCHIVE_DIR, f), "utf8")));
				const cwd = optStr(raw.cwd) ?? "";
				const items = Array.isArray(raw.items) ? raw.items : [];
				entries.push({
					path: join(ARCHIVE_DIR, f),
					title: optStr(raw.title) ?? null,
					items: items.length,
					completed: items.filter((i) => asRecord(i).status === "completed").length,
					archivedAt: numOr(raw.archivedAt, 0),
					cwdHash: cwd ? cwdHash(cwd) : "",
				});
			} catch {
				/* skip corrupt */
			}
		}
		entries.sort(byArchivedAtDesc);
		writeJSON(TODO_ARCHIVE_INDEX_PATH, { version: 1, entries });
	} catch {
		/* best-effort */
	}
}

/** Archive the current list and return its path. */
function archiveList(list: TodoList): string | null {
	if (list.items.length === 0) return null;
	try {
		const ts = Date.now();
		const path = archivePath(list.cwd, ts);
		const archived = { ...list, archivedAt: ts };
		writeJSON(path, archived);
		updateTodoArchiveIndex({
			path,
			title: list.title ?? null,
			items: list.items.length,
			completed: list.items.filter((i) => i.status === "completed").length,
			archivedAt: ts,
			cwdHash: cwdHash(list.cwd),
		});
		return path;
	} catch {
		return null;
	}
}

interface ArchiveListing {
	path: string;
	title?: string;
	items: number;
	completed: number;
	archivedAt: number;
}

const toListing = (e: ArchiveEntry): ArchiveListing => ({
	path: e.path,
	title: e.title ?? undefined,
	items: e.items,
	completed: e.completed,
	archivedAt: e.archivedAt,
});

function listArchives(cwd: string): ArchiveListing[] {
	try {
		if (!existsSync(ARCHIVE_DIR)) return [];
		const hash = cwdHash(cwd);
		// Try index first
		if (existsSync(TODO_ARCHIVE_INDEX_PATH)) {
			const matches = readArchiveIndex().filter((e) => e.cwdHash === hash);
			if (matches.length > 0) return matches.map(toListing);
			// No index matches — quick check if files exist for this cwd before rebuilding
			const prefix = `${hash}-`;
			if (!readdirSync(ARCHIVE_DIR).some((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
				return [];
			}
		}
		// Fallback: rebuild index from archive files
		rebuildTodoArchiveIndex();
		return readArchiveIndex()
			.filter((e) => e.cwdHash === hash)
			.map(toListing);
	} catch {
		return [];
	}
}

// ── Display ──────────────────────────────────────────────────────────────────

const ICON: Record<Status, string> = {
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
	delegated: "⇢",
};

function usesTree(items: TodoItem[]): boolean {
	return items.some((i) => (i.level ?? 0) > 0);
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function progressBar(done: number, total: number): string {
	if (total === 0) return "";
	const ratio = done / total;
	const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
	const bar = "█".repeat(filled) + "░".repeat(PROGRESS_BAR_WIDTH - filled);
	return `[${bar}] ${done}/${total}`;
}

function formatItems(items: TodoItem[], truncate = false): string {
	const sorted = visibleOrder(items);
	const treeMode = usesTree(items);
	let lines = sorted.map((i, idx) => {
		const content = clip(i.content, CONTENT_MAX);
		const extras: string[] = [];
		if (i.agent) extras.push(`→ ${i.agent}`);
		if (i.result) extras.push(`✓ ${clip(i.result, SECONDARY_MAX)}`);
		const extra = extras.length ? `  ${extras.join(" · ")}` : "";
		const prefix = treeMode ? treePrefix(sorted, idx) : "";
		return `${idx}. ${ICON[i.status]} ${prefix}${content}${extra}`;
	});
	if (truncate && lines.length > TRUNCATE_AT) {
		const shown = lines.slice(0, 8);
		shown.push(`  … and ${lines.length - 8} more items`);
		return shown.join("\n");
	}
	return lines.join("\n");
}

function buildOutput(list: TodoList, warnings: string[] = []): string {
	const done = list.items.filter((i) => i.status === "completed").length;
	const total = list.items.length;

	const header = list.title ? `## ${list.title}\n` : "";
	const bar = progressBar(done, total);
	const warningText = warnings.length ? `\n⚠ ${warnings.join(" · ")}` : "";
	const items = formatItems(list.items, true);

	return `${header}${bar}${warningText}\n${items}`;
}

function formatTodoDetail(item: TodoItem, idx: number): string {
	return [
		`[${idx}] ${item.status.toUpperCase()}: ${item.content}`,
		item.agent ? `  Agent: ${item.agent}` : "",
		item.context ? `  Context: ${item.context}` : "",
		item.result ? `  Result: ${item.result}` : "",
		item.createdAt ? `  Created: ${new Date(item.createdAt).toISOString()}` : "",
		item.completedAt ? `  Done: ${new Date(item.completedAt).toISOString()}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

// ── Status badge ─────────────────────────────────────────────────────────────

function renderStatus(ctx: ExtensionContext, list: TodoList) {
	const theme = (ctx.ui as any).theme;
	if (list.items.length === 0) {
		ctx.ui.setStatus?.("todo", "");
		return;
	}
	const done = list.items.filter((i) => i.status === "completed").length;
	const active = list.items.some((i) => i.status === "in_progress");
	const delegated = list.items.some((i) => i.status === "delegated");
	const icon = active ? "▶" : delegated ? "⇢" : "☑";
	const label = `${icon} ${done}/${list.items.length}`;
	const color = done === list.items.length ? "success" : active ? "warning" : "dim";
	ctx.ui.setStatus?.("todo", theme?.fg ? theme.fg(color, label) : label);
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const TodoItemSchema = Type.Object({
	content: Type.String({ description: "Short imperative description of the step" }),
	status: StringEnum(["pending", "in_progress", "completed", "delegated"] as const, {
		description:
			"pending | in_progress | completed | delegated. Keep at most ONE item in_progress.",
		default: "pending",
	}),
	agent: Type.Optional(
		Type.String({
			description: "Sub-agent type for delegated items (e.g. 'librarian', 'solana-dev')",
		}),
	),
	context: Type.Optional(
		Type.String({ description: "Focused context/instructions for the sub-agent — keep it lean" }),
	),
	result: Type.Optional(
		Type.String({
			description: "Brief summary of what the sub-agent did (set when marking completed)",
		}),
	),
	source: Type.Optional(
		Type.String({ description: "Optional source extension marker (e.g. quest)" }),
	),
	sourceId: Type.Optional(Type.String({ description: "Optional external source id" })),
	sourceIndex: Type.Optional(Type.Number({ description: "Optional source-local task index" })),
	level: Type.Optional(
		Type.Number({ description: "Nesting level for tree display: 0 = root, 1+ = indented child" }),
	),
});

const TodoWriteParams = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description: `The COMPLETE todo list. Max ${MAX_ITEMS} items. Replaces previous list entirely. Include finished items.`,
	}),
	title: Type.Optional(
		Type.String({ description: "Optional title for this task (e.g. 'Build memory system')" }),
	),
});

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// In-memory cache so status badge doesn't re-read disk on model_select,
	// while still reloading when another extension writes the todo file.
	let cachedList: TodoList | null = null;
	let cachedCwd: string | null = null;
	let cachedStamp: string | null = null;

	function refreshCacheMetadata(cwd: string, list: TodoList): TodoList {
		cachedList = list;
		cachedCwd = cwd;
		cachedStamp = storeStamp(cwd);
		return list;
	}

	function getCached(cwd: string): TodoList {
		const currentStamp = storeStamp(cwd);
		if (!cachedList || cachedCwd !== cwd || cachedStamp !== currentStamp) {
			return refreshCacheMetadata(cwd, loadTodos(cwd));
		}
		return cachedList;
	}

	// ── Tool: todo_write ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "todo_write",
		label: "Todo",
		description: [
			"Maintain a structured task ledger for the current multi-step task.",
			"Submit the FULL list every call — it REPLACES the stored list (not append).",
			"Use it when a task has 3+ non-trivial steps or the user gives multiple requirements:",
			"write the plan up front, mark exactly one item in_progress as you start it,",
			"and flip it to completed the moment it's done. Skip it for trivial single-step tasks.",
			"",
			"Delegation workflow:",
			"1. Mark items as 'delegated' with agent + context for sub-agent processing",
			"2. Call subagent tool with the focused context (not full history)",
			"3. When sub-agent returns, update item to 'completed' with result summary",
		].join(" "),
		promptSnippet:
			"Structured task list: mark one in_progress, delegate to sub-agents, track completion",
		promptGuidelines: [
			"Use todo_write to plan and track multi-step tasks. Mark exactly ONE item in_progress at a time.",
			"For parallelizable items, set status 'delegated' with an agent type and focused context. Then use the subagent tool to farm them out. When a sub-agent finishes, update the item to 'completed'.",
			"Keep delegated context lean — sub-agents get only what they need, not the full conversation.",
		],
		parameters: TodoWriteParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rawItems = params.todos as any[];
			const warnings: string[] = [];

			// Cap check
			if (rawItems.length > MAX_ITEMS) {
				warnings.push(`trimmed from ${rawItems.length} to ${MAX_ITEMS} items`);
				rawItems.length = MAX_ITEMS;
			}

			// Dedup check
			const seen = new Set<string>();
			const dupes = new Set<string>();
			for (const item of rawItems) {
				const key = item.content.toLowerCase().trim();
				if (seen.has(key)) dupes.add(key);
				seen.add(key);
			}
			if (dupes.size > 0) {
				warnings.push(`${dupes.size} duplicate item(s) detected`);
			}

			// In-progress count check (allow multiple delegated)
			const inProgress = rawItems.filter((i: any) => i.status === "in_progress").length;
			if (inProgress > 1) {
				warnings.push(`${inProgress} items in_progress — keep to one`);
			}

			// Build items with timestamps, merging with existing
			const existing = getCached(ctx.cwd);
			const existingMap = new Map(existing.items.map((i, idx) => [i.content, { item: i, idx }]));

			const now = Date.now();
			const items: TodoItem[] = rawItems.map((raw: any) => {
				const prev = existingMap.get(raw.content);
				return {
					content: raw.content,
					status: raw.status as Status,
					agent: raw.agent,
					context: raw.context,
					result: raw.result,
					source: typeof raw.source === "string" ? raw.source : prev?.item.source,
					sourceId: typeof raw.sourceId === "string" ? raw.sourceId : prev?.item.sourceId,
					sourceIndex:
						typeof raw.sourceIndex === "number" ? raw.sourceIndex : prev?.item.sourceIndex,
					level: typeof raw.level === "number" ? raw.level : prev?.item.level,
					createdAt: prev?.item.createdAt ?? now,
					completedAt: raw.status === "completed" ? (prev?.item.completedAt ?? now) : null,
				};
			});

			const list: TodoList = {
				cwd: ctx.cwd,
				title: params.title ?? existing.title,
				items,
				version: 1,
			};

			// Auto-archive if all items completed, then clear the active list
			if (list.items.length > 0 && list.items.every((i) => i.status === "completed")) {
				archiveList(list);
				list.items = [];
				list.title = undefined;
				warnings.push("all done — list archived");
			}

			saveTodos(list);
			refreshCacheMetadata(ctx.cwd, list);
			renderStatus(ctx, list);
			writeTodoSessionMeta(ctx.cwd, list);

			const output = buildOutput(list, warnings);
			return {
				content: [{ type: "text", text: output }],
				details: { items: list.items, title: list.title },
			};
		},

		renderCall(args, theme) {
			const n = Array.isArray(args.todos) ? args.todos.length : 0;
			const d = Array.isArray(args.todos)
				? args.todos.filter((i: any) => i.status === "delegated").length
				: 0;
			const bits = [theme.fg("toolTitle", theme.bold("todo "))];
			bits.push(theme.fg("accent", `${n} item${n === 1 ? "" : "s"}`));
			if (d) bits.push(theme.fg("dim", ` ${d} delegated`));
			return new Text(bits.join(""), 0, 0);
		},

		renderResult(result, _opts, theme) {
			const items = (result.details as { items?: TodoItem[] } | undefined)?.items ?? [];
			if (items.length === 0) return new Text("(no todos)", 0, 0);

			const colorFor: Record<Status, { fg: string; icon: string }> = {
				completed: { fg: "success", icon: "☑" },
				in_progress: { fg: "warning", icon: "▶" },
				delegated: { fg: "accent", icon: "⇢" },
				pending: { fg: "muted", icon: "☐" },
			};
			const done = items.filter((i) => i.status === "completed").length;
			const total = items.length;
			const sorted = visibleOrder(items);
			const treeMode = usesTree(items);

			const lines: string[] = [];

			// Themed progress bar
			if (total > 0) {
				const ratio = Math.round((done / total) * PROGRESS_BAR_WIDTH);
				const bar =
					theme.fg("success", "█".repeat(ratio)) +
					theme.fg("dim", "░".repeat(PROGRESS_BAR_WIDTH - ratio));
				lines.push(`${bar} ${done}/${total}`);
				lines.push("");
			}

			for (let idx = 0; idx < sorted.length; idx++) {
				const i = sorted[idx];
				const c = colorFor[i.status];
				const prefix = treeMode ? treePrefix(sorted, idx) : "";
				const secondaryPrefix = " ".repeat(prefix.length);
				const content = clip(i.content, CONTENT_MAX);
				lines.push(theme.fg(c.fg as any, `${idx}. ${c.icon} ${prefix}${content}`));
				if (i.agent) {
					lines.push(theme.fg("dim", `   ${secondaryPrefix}→ ${i.agent}`));
				}
				if (i.result) {
					lines.push(theme.fg("dim", `   ${secondaryPrefix}✓ ${clip(i.result, SECONDARY_MAX)}`));
				}
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ── Tool: todo_history ────────────────────────────────────────────────────

	pi.registerTool({
		name: "todo_history",
		label: "Todo History",
		description: "Browse archived todo lists for this project. Shows recent N lists (default 5).",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "Number of past lists to show (default 5)", default: 5 }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const archives = listArchives(ctx.cwd);
			const limit = params.limit ?? 5;
			const recent = archives.slice(0, limit);

			if (recent.length === 0) {
				return {
					content: [{ type: "text", text: "No archived todo lists for this project." }],
					details: { archives: [] },
				};
			}

			const lines = recent.map((a, idx) => {
				const date = new Date(a.archivedAt).toLocaleDateString("en-US", {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				});
				return `${idx + 1}. ${a.title ?? "(untitled)"} — ${a.completed}/${a.items} done — ${date}`;
			});

			return {
				content: [
					{ type: "text", text: `Archived lists (${recent.length}):\n${lines.join("\n")}` },
				],
				details: { archives: recent },
			};
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_e, ctx) => {
		const list = refreshCacheMetadata(ctx.cwd, loadTodos(ctx.cwd));
		renderStatus(ctx, list);
		writeTodoSessionMeta(ctx.cwd, list);
	});
	pi.on("model_select", async (_e, ctx) => {
		const list = getCached(ctx.cwd);
		renderStatus(ctx, list);
		writeTodoSessionMeta(ctx.cwd, list);
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("todo", {
		description:
			"Show task ledger. /todo clear | history [N] | delegate <idx> [--agent name] [--context notes]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const restStr = rest.join(" ");

			switch (sub) {
				case "":
				case "show": {
					const list = getCached(ctx.cwd);
					writeTodoSessionMeta(ctx.cwd, list);
					if (list.items.length === 0) {
						ctx.ui.notify("Todo list is empty.", "info");
					} else {
						ctx.ui.notify(buildOutput(list), "info");
					}
					return;
				}
				case "clear": {
					const list = getCached(ctx.cwd);
					if (list.items.length > 0) {
						const archived = archiveList(list);
						if (archived) ctx.ui.notify(`Archived to ${basename(archived)}.`, "info");
					}
					const empty: TodoList = { cwd: ctx.cwd, items: [], version: 1 };
					saveTodos(empty);
					refreshCacheMetadata(ctx.cwd, empty);
					renderStatus(ctx, empty);
					writeTodoSessionMeta(ctx.cwd, empty);
					ctx.ui.notify("Todo list cleared.", "info");
					return;
				}
				case "history": {
					const limit = parseInt(restStr, 10) || 5;
					const archives = listArchives(ctx.cwd);
					if (archives.length === 0) {
						ctx.ui.notify("No archived todo lists.", "info");
						return;
					}
					const lines = archives.slice(0, limit).map((a, idx) => {
						const date = new Date(a.archivedAt).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						});
						return `${idx + 1}. ${a.title ?? "(untitled)"} — ${a.completed}/${a.items} done — ${date}`;
					});
					ctx.ui.notify(`Archived lists:\n${lines.join("\n")}`, "info");
					return;
				}
				case "delegate": {
					const idx = parseInt(rest[0], 10);
					if (isNaN(idx) || idx < 0) {
						ctx.ui.notify(
							"Usage: /todo delegate <index> [--agent name] [--context notes]",
							"error",
						);
						return;
					}
					const list = getCached(ctx.cwd);
					const item = visibleOrder(list.items)[idx];
					if (!item) {
						ctx.ui.notify(`No item at index ${idx}.`, "error");
						return;
					}
					// Parse --agent (single word) and --context (up to next --flag or EOL)
					const agentMatch = restStr.match(/--agent\s+(\S+)/);
					const ctxMatch = restStr.match(/--context\s+(.+?)(?=\s+--|$)/);
					if (agentMatch) item.agent = agentMatch[1];
					if (ctxMatch) item.context = ctxMatch[1];
					item.status = "delegated";
					saveTodos(list);
					refreshCacheMetadata(ctx.cwd, list);
					renderStatus(ctx, list);
					writeTodoSessionMeta(ctx.cwd, list);
					const agent = item.agent ? ` → ${item.agent}` : "";
					ctx.ui.notify(`Delegated [${idx}] ${item.content}${agent}`, "info");
					return;
				}
				case "detail": {
					const idx = parseInt(rest[0], 10);
					if (isNaN(idx) || idx < 0) {
						ctx.ui.notify("Usage: /todo detail <index>", "error");
						return;
					}
					const list = getCached(ctx.cwd);
					const item = visibleOrder(list.items)[idx];
					if (!item) {
						ctx.ui.notify(`No item at index ${idx}.`, "error");
						return;
					}
					ctx.ui.notify(formatTodoDetail(item, idx), "info");
					return;
				}
				default: {
					// Maybe it's a numeric index → show detail
					const idx = parseInt(sub, 10);
					if (!isNaN(idx) && idx >= 0) {
						const list = getCached(ctx.cwd);
						const item = visibleOrder(list.items)[idx];
						if (!item) {
							ctx.ui.notify(`No item at index ${idx}.`, "error");
							return;
						}
						ctx.ui.notify(formatTodoDetail(item, idx), "info");
						return;
					}
					ctx.ui.notify(
						"Usage: /todo [show|clear|history [N]|delegate <idx>|detail <idx>]",
						"error",
					);
				}
			}
		},
	});
}
