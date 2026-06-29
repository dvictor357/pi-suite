import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { Quest, QuestTask } from "./types";
import { ICON } from "./constants";

// ── Pure helpers (exported for testing) ───────────────────────────────────

/** Theme shape expected by the kanban renderer. */
export interface KanbanTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** A no-op theme that returns text unchanged — useful in tests. */
export const identityTheme: KanbanTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Column definition produced by buildColumns. */
export interface KanbanColumn {
	title: string;
	tasks: QuestTask[];
	color: string;
}

/** Group tasks into TODO / DOING / DONE / FAILED columns. */
export function buildColumns(tasks: QuestTask[]): KanbanColumn[] {
	return [
		{ title: "TODO", tasks: tasks.filter((t) => t.status === "pending"), color: "muted" },
		{
			title: "DOING",
			tasks: tasks.filter((t) => t.status === "running" || t.status === "verifying"),
			color: "accent",
		},
		{ title: "DONE", tasks: tasks.filter((t) => t.status === "done"), color: "success" },
		{
			title: "FAILED",
			tasks: tasks.filter((t) => t.status === "failed" || t.status === "skipped"),
			color: "error",
		},
	];
}

/** Truncate text to maxLen, appending "…" when truncated. */
export function truncate(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (text.length > maxLen) return text.slice(0, maxLen - 1) + "…";
	return text;
}

/** Build a one-line display label for a task cell. */
export function formatTaskCell(
	task: QuestTask,
	index: number,
	colWidth: number,
	icon: Record<string, string>,
): string {
	const maxContent = colWidth - 5;
	const content = truncate(task.content, maxContent);
	return ` ${icon[task.status] ?? "•"}#${index + 1} ${content}`;
}

/** Format a duration in ms to a short human string like "12s" or "2m 30s". */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	if (remaining === 0) return `${minutes}m`;
	return `${minutes}m ${remaining}s`;
}

/** Build a compact metadata label summarising the task's key fields. */
export function buildMetadataLabel(task: QuestTask): string {
	const parts: string[] = [];
	if (task.verified) parts.push("✅verified");
	if (task.commitHash) parts.push(`\`${task.commitHash.slice(0, 8)}\``);
	if (task.attempts > 1) parts.push(`${task.attempts} attempts`);
	if (task.startedAt) {
		const dur = task.completedAt ? task.completedAt - task.startedAt : Date.now() - task.startedAt;
		parts.push(formatDuration(dur));
	}
	return parts.join(" · ");
}

/** Progress counts for a quest. */
export interface ProgressCounts {
	total: number;
	done: number;
	failed: number;
	skipped: number;
	running: number;
	verifying: number;
	pending: number;
}

/** Compute progress counts from quest tasks. */
export function progressSummary(tasks: QuestTask[]): ProgressCounts {
	let done = 0;
	let failed = 0;
	let skipped = 0;
	let running = 0;
	let verifying = 0;
	let pending = 0;
	for (const t of tasks) {
		switch (t.status) {
			case "done":
				done++;
				break;
			case "failed":
				failed++;
				break;
			case "skipped":
				skipped++;
				break;
			case "running":
				running++;
				break;
			case "verifying":
				verifying++;
				break;
			case "pending":
				pending++;
				break;
		}
	}
	return { total: tasks.length, done, failed, skipped, running, verifying, pending };
}

/** Selection state. */
export interface KanbanSelection {
	col: number;
	row: number;
}

/** Clamp selection to valid bounds given columns. */
export function clampSelection(sel: KanbanSelection, cols: KanbanColumn[]): KanbanSelection {
	const col = Math.max(0, Math.min(sel.col, cols.length - 1));
	const tasks = cols[col]?.tasks ?? [];
	const row = Math.max(0, Math.min(sel.row, tasks.length - 1));
	return { col, row };
}

/** Move selection in a direction. Returns new selection (already clamped). */
export function moveSelection(
	sel: KanbanSelection,
	cols: KanbanColumn[],
	direction: "left" | "right" | "up" | "down",
): KanbanSelection {
	switch (direction) {
		case "left":
			if (sel.col <= 0) return sel;
			return clampSelection({ col: sel.col - 1, row: 0 }, cols);
		case "right":
			if (sel.col >= cols.length - 1) return sel;
			return clampSelection({ col: sel.col + 1, row: 0 }, cols);
		case "up":
			if (sel.row <= 0) return sel;
			return clampSelection({ col: sel.col, row: sel.row - 1 }, cols);
		case "down": {
			const maxRow = (cols[sel.col]?.tasks.length ?? 1) - 1;
			if (sel.row >= maxRow) return sel;
			return clampSelection({ col: sel.col, row: sel.row + 1 }, cols);
		}
	}
}

/**
 * Find the selected task given the quest, columns, and current selection.
 * Returns the task along with its original index in quest.tasks.
 */
export function getSelectedTask(
	quest: Quest,
	cols: KanbanColumn[],
	sel: KanbanSelection,
): { task: QuestTask; index: number } | null {
	const col = cols[sel.col];
	if (!col || sel.row >= col.tasks.length) return null;
	const task = col.tasks[sel.row];
	const index = quest.tasks.indexOf(task);
	if (index === -1) return null;
	return { task, index };
}

// ── Status & header helpers ──────────────────────────────────────────────

/** Build a compact one-line quest status summary for the board header. */
export function buildStatusLine(quest: Quest, tasks: QuestTask[]): string {
	const p = progressSummary(tasks);
	const parts: string[] = [];

	parts.push(`[${quest.status.toUpperCase()}]`);
	parts.push(`${p.done}/${p.total} done`);

	if (p.running > 0) parts.push(`${p.running} running`);
	if (p.verifying > 0) parts.push(`${p.verifying} verifying`);
	if (p.failed > 0) parts.push(`${p.failed} failed`);
	if (p.skipped > 0) parts.push(`${p.skipped} skipped`);

	if (quest.sandbox?.mode) parts.push(`sandbox:${quest.sandbox.mode}`);
	if (quest.team) parts.push(`team:${quest.team}`);
	if (quest.planningMode === "approve" && !quest.planApproved && quest.tasks.length > 0) {
		parts.push("[awaiting approval]");
	}

	return parts.join(" · ");
}

// ── Rich task cell formatting ─────────────────────────────────────────────

/** Compute the space a task's prefix takes: " ☐#12 "  (icon + # + index + spaces). */
export function measureTaskPrefix(
	task: QuestTask,
	index: number,
	icon: Record<string, string>,
): number {
	return ` ${icon[task.status] ?? "•"}#${index + 1} `.length;
}

/**
 * Build a compact right-hand metadata suffix for a task cell.
 * The suffix is progressively disclosed based on available column width:
 *   < 18 → "" (no metadata)
 *   < 22 → agent only "[worker]"
 *   < 28 → agent + verified "[worker] ✓"
 *   < 34 → agent + verified + git "[worker] ✓ ⎇abc1234"
 *   34+  → full with deps "[worker] ✓ ⎇abc1234 ↳#1,#2"
 * Returns "" when there is nothing to show.
 */
export function buildTaskSuffix(task: QuestTask, colWidth: number): string {
	const parts: string[] = [];

	// Agent badge — always included when colWidth >= 18
	if (colWidth >= 18 && task.agent) {
		if (colWidth >= 22) {
			parts.push(`[${task.agent}]`);
		} else {
			// Ultra-compact: first char of agent name
			parts.push(`[${task.agent[0]}]`);
		}
	}

	// Sandbox indicator — compact badge when task has sandbox overrides.
	// Differentiate: restricted → 🔒, isolated → 🔒i, any sandbox → 🔒
	if (task.sandbox && colWidth >= 22) {
		const sbIcon = task.sandbox.mode === "isolated" ? "🔒i" : "🔒";
		parts.push(sbIcon);
	}

	// Verification checkmark
	if (task.verified && colWidth >= 22) {
		parts.push("✓");
	}

	// Git commit short hash
	if (task.commitHash && colWidth >= 28) {
		parts.push(`⎇${task.commitHash.slice(0, 7)}`);
	}

	// Dependency markers
	if (task.dependencies.length > 0 && colWidth >= 34) {
		const deps = task.dependencies.map((d) => `#${d + 1}`).join(",");
		parts.push(`↳${deps}`);
	}

	if (parts.length === 0) return "";
	return " " + parts.join(" ");
}

/**
 * Render a rich task cell with inline metadata when column width permits.
 * Layout:  ☐#3 Task content…  [worker] ✓ ⎇abc1234
 * When colWidth is too narrow for metadata, degrades to basic formatTaskCell.
 */
export function formatTaskCellRich(
	task: QuestTask,
	index: number,
	colWidth: number,
	icon: Record<string, string>,
): string {
	const prefix = ` ${icon[task.status] ?? "•"}#${index + 1} `;
	const suffix = buildTaskSuffix(task, colWidth);
	const usedByDecor = prefix.length + suffix.length;
	const contentMax = colWidth - usedByDecor;

	if (contentMax <= 0) {
		// No room for content — just prefix + suffix, clipped to width
		return (prefix + suffix.trimStart()).padEnd(colWidth).slice(0, colWidth);
	}

	const content = truncate(task.content, contentMax);
	const spacer = colWidth - prefix.length - suffix.length - content.length;
	return prefix + content + " ".repeat(Math.max(spacer, 0)) + suffix;
}

// ── Detail pane helpers ───────────────────────────────────────────────────

/**
 * Word-wrap a block of text to fit within maxWidth characters.
 * Respects existing newlines. Returns an array of lines.
 */
export function wrapLines(text: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		let remaining = paragraph;
		while (remaining.length > 0) {
			if (remaining.length <= maxWidth) {
				lines.push(remaining);
				break;
			}
			// Try to break at a space near maxWidth
			let cut = maxWidth;
			const spaceAt = remaining.lastIndexOf(" ", maxWidth);
			if (spaceAt > 0) cut = spaceAt;
			lines.push(remaining.slice(0, cut).trimEnd());
			remaining = remaining.slice(cut).trimStart();
		}
	}
	return lines;
}

/** Format a Unix-epoch timestamp as a short local date-time string. */
export function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		d.getFullYear(),
		"-",
		pad(d.getMonth() + 1),
		"-",
		pad(d.getDate()),
		" ",
		pad(d.getHours()),
		":",
		pad(d.getMinutes()),
	].join("");
}

/**
 * Build compact sandbox detail lines for display in the task detail pane.
 * Shows quest-level policy and any per-task overrides.
 */
export function buildSandboxDetailLines(
	quest: { sandbox?: { mode?: string; worktree?: { path?: string } | null } },
	task: { sandbox?: { mode?: string } },
	maxW: number,
): string[] {
	const lines: string[] = [];
	const mode = task.sandbox?.mode || quest.sandbox?.mode;
	const label = mode === "isolated" ? "Sandbox: isolated 🔒" : "Sandbox: restricted 🔒";
	lines.push(label);

	if (quest.sandbox?.worktree?.path) {
		for (const line of wrapLines(`  Worktree: ${quest.sandbox.worktree.path}`, maxW))
			lines.push(line);
	}
	if (task.sandbox?.mode) {
		for (const line of wrapLines(`  Task override: +${task.sandbox.mode}`, maxW)) lines.push(line);
	}
	return lines;
}

/**
 * Build the complete detail view for a task as an array of lines.
 * The caller is responsible for scrolling (slicing from a scroll offset).
 */
export function buildTaskDetail(
	task: QuestTask,
	index: number,
	quest: Quest,
	width: number,
	icon: Record<string, string>,
): string[] {
	const maxW = Math.max(width - 2, 20); // leave 1-char margin each side
	const lines: string[] = [];

	// ── Title line ──
	const iconChar = icon[task.status] ?? "•";
	const titleText = truncate(`${iconChar} Task #${index + 1}: ${task.content}`, maxW);
	lines.push(titleText);
	lines.push("");

	// ── Status & agent ──
	const metaParts: string[] = [];
	metaParts.push(`Status: ${task.status}`);
	metaParts.push(`Agent: ${task.agent}`);
	if (task.model) metaParts.push(`Model: ${task.model}`);
	metaParts.push(`Attempts: ${task.attempts}`);
	lines.push(metaParts.join(" · "));

	// ── Dependencies ──
	if (task.dependencies.length > 0) {
		const depLabels = task.dependencies.map((d) => {
			const depTask = quest.tasks[d];
			return depTask ? `#${d + 1} ${depTask.content}` : `#${d + 1} (?)`;
		});
		for (const label of wrapLines(`Dependencies: ${depLabels.join(", ")}`, maxW)) {
			lines.push(label);
		}
	}

	// ── Timing ──
	const timingParts: string[] = [];
	if (task.startedAt) {
		timingParts.push(`Started: ${formatTimestamp(task.startedAt)}`);
		if (task.completedAt) {
			timingParts.push(`Completed: ${formatTimestamp(task.completedAt)}`);
			timingParts.push(`Duration: ${formatDuration(task.completedAt - task.startedAt)}`);
		} else {
			timingParts.push(`Elapsed: ${formatDuration(Date.now() - task.startedAt)}`);
		}
	} else {
		timingParts.push("Not started yet");
	}
	lines.push(timingParts.join(" · "));

	// ── Git ──
	if (task.commitHash || task.branchName) {
		const gitParts: string[] = [];
		if (task.commitHash) gitParts.push(`Commit: ${task.commitHash.slice(0, 8)}`);
		if (task.branchName) gitParts.push(`Branch: ${task.branchName}`);
		lines.push(gitParts.join(" · "));
	}

	// ── Verification ──
	if (task.verified) {
		const vLine = task.verifyResult
			? `Verification: ✅ ${task.verifyResult}`
			: "Verification: ✅ passed";
		for (const line of wrapLines(vLine, maxW)) lines.push(line);
	} else if (task.status === "verifying") {
		lines.push(`Verification: 🔍 in progress (retries: ${task.verifyRetries})`);
	}

	// ── Sandbox ──
	if (quest.sandbox || task.sandbox) {
		lines.push("");
		const sbLines = buildSandboxDetailLines(quest, task, maxW);
		for (const line of sbLines) lines.push(line);
	}

	lines.push("");

	// ── Context ──
	lines.push("── Context ──");
	lines.push("");
	if (task.context) {
		for (const line of wrapLines(task.context, maxW)) lines.push(line);
	} else {
		lines.push("(none)");
	}

	lines.push("");

	// ── Result ──
	lines.push("── Result ──");
	lines.push("");
	if (task.result) {
		for (const line of wrapLines(task.result, maxW)) lines.push(line);
	} else {
		lines.push("(no result yet)");
	}

	return lines;
}

// ── Render helpers ────────────────────────────────────────────────────────

export interface KanbanLayout {
	numCols: number;
	gap: number;
	colWidth: number;
	maxRows: number;
}

/** Compute layout dimensions from the terminal width. */
export function computeLayout(width: number, numCols = 4, gap = 2): KanbanLayout {
	const colWidth = Math.floor((width - (numCols - 1) * gap) / numCols);
	const colWidthClamped = Math.max(colWidth, 8);
	return { numCols, gap, colWidth: colWidthClamped, maxRows: 0 };
}

/** Compute maxRows from columns after layout is known. */
export function resolveMaxRows(layout: KanbanLayout, cols: KanbanColumn[]): KanbanLayout {
	return { ...layout, maxRows: Math.max(...cols.map((c) => c.tasks.length), 1) };
}

/** Render a single kanban cell line with rich inline metadata. */
export function renderCell(
	col: KanbanColumn,
	task: QuestTask | undefined,
	_rowIndex: number,
	isSelected: boolean,
	allTasks: QuestTask[],
	theme: KanbanTheme,
	colWidth: number,
): string {
	if (!task) return theme.fg("dim", " ".repeat(colWidth));

	const idx = allTasks.indexOf(task);
	const raw = idx >= 0 ? formatTaskCellRich(task, idx, colWidth, ICON) : "";
	const padded = raw.padEnd(colWidth).slice(0, colWidth);

	if (isSelected) return theme.bg("selectedBg", theme.fg("text", padded));
	return theme.fg(col.color, padded);
}

// ── QuestKanban class (public API preserved) ──────────────────────────────

/** Actions the kanban can trigger — wired by index.ts to avoid importing storage here. */
export interface KanbanActions {
	/** Pause the active quest. */
	onPause?: () => void;
	/** Resume a paused quest. */
	onResume?: () => void;
	/** Start the plan (or approve if approval mode). */
	onStart?: () => void;
	/** Approve plan and start. For approve-mode plans only. */
	onApprove?: () => void;
	/** Retry a failed task (reset to pending). */
	onRetryTask?: (taskIndex: number) => void;
}

export type KanbanMode = "board" | "detail" | "help";

/**
 * Build a compact action-hint string for the board footer based on which
 * callbacks are wired and the current quest state.
 */
export function buildActionHints(quest: Quest, actions: KanbanActions): string {
	const hints: string[] = [];
	if (actions.onPause && quest.status === "active") hints.push("p pause");
	if (actions.onResume && quest.status === "paused") hints.push("r resume");
	if (actions.onStart && (quest.status === "planning" || quest.status === "idle")) {
		if (quest.planningMode === "approve" && !quest.planApproved && quest.tasks.length > 0) {
			if (actions.onApprove) hints.push("a approve  s start");
			else hints.push("a approve");
		} else {
			hints.push("s start");
		}
	}
	if (
		actions.onApprove &&
		quest.planningMode === "approve" &&
		!quest.planApproved &&
		quest.tasks.length > 0 &&
		!hints.some((h) => h.includes("approve"))
	) {
		hints.push("a approve");
	}
	// Retry is only available in detail mode, not on the board.
	return hints.join("  ·  ");
}

/** Build the keyboard help overlay as an array of lines. */
export function buildHelpOverlay(width: number): string[] {
	const w = Math.max(width - 4, 30);
	const lines: string[] = [];
	const hr = "─".repeat(Math.min(w, 60));

	lines.push(" Keyboard Help");
	lines.push(` ${hr}`);
	lines.push("");

	lines.push(" Board Mode");
	lines.push(truncate(" ← → ↑ ↓     Navigate columns and tasks", w));
	lines.push(truncate(" Enter       Open task detail pane", w));
	lines.push(truncate(" p / r / s / a  Pause, Resume, Start, Approve (context)", w));
	lines.push(truncate(" ?  /  h     Show this help overlay", w));
	lines.push(truncate(" Esc         Close kanban (return to chat)", w));
	lines.push("");

	lines.push(" Detail Mode");
	lines.push(truncate(" ↑ ↓         Scroll task detail", w));
	lines.push(truncate(" PgUp PgDn   Page scroll", w));
	lines.push(truncate(" Home / End  Jump to top / bottom", w));
	lines.push(truncate(" ?  /  h     Show this help overlay", w));
	lines.push(truncate(" Esc / Bksp  Back to board", w));
	lines.push("");

	lines.push(" Help Mode");
	lines.push(truncate(" Esc / Bksp  Return to previous mode", w));
	lines.push("");

	return lines;
}

export class QuestKanban {
	private quest: Quest;
	private theme: KanbanTheme;
	private actions: KanbanActions;
	private selectedCol = 0;
	private selectedRow = 0;
	private mode: KanbanMode = "board";
	private previousMode: KanbanMode = "board";
	private detailScroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	public onClose?: () => void;

	constructor(quest: Quest, theme: KanbanTheme, actions: KanbanActions = {}) {
		this.quest = quest;
		this.theme = theme;
		this.actions = actions;
	}

	/** Update the quest reference (e.g. after external changes). */
	setQuest(quest: Quest): void {
		this.quest = quest;
		this.clampSelf();
		this.invalidate();
	}

	/** Current selection state (read-only snapshot for tests). */
	get selection(): KanbanSelection {
		return { col: this.selectedCol, row: this.selectedRow };
	}

	/** Current display mode (read-only for tests). */
	get currentMode(): KanbanMode {
		return this.mode;
	}

	private clampSelf(): void {
		const cols = buildColumns(this.quest.tasks);
		const clamped = clampSelection(this.selection, cols);
		this.selectedCol = clamped.col;
		this.selectedRow = clamped.row;
	}

	/** Open help overlay, remembering the mode to return to. */
	private openHelp(): void {
		this.previousMode = this.mode;
		this.mode = "help";
		this.invalidate();
	}

	/** Return from help overlay to the previous mode. */
	private closeHelp(): void {
		this.mode = this.previousMode;
		this.invalidate();
	}

	/** Open the detail pane for the currently-selected task. No-op if none. */
	private openDetail(): void {
		const cols = buildColumns(this.quest.tasks);
		const sel = getSelectedTask(this.quest, cols, this.selection);
		if (!sel) return;
		this.mode = "detail";
		this.detailScroll = 0;
		this.invalidate();
	}

	/** Return from detail pane to the board. */
	private closeDetail(): void {
		this.mode = "board";
		this.detailScroll = 0;
		this.invalidate();
	}

	/** Scroll the detail pane by delta lines, clamped later in render. */
	private scrollDetail(delta: number): void {
		this.detailScroll = Math.max(0, this.detailScroll + delta);
		this.invalidate();
	}

	handleInput(data: string): void {
		// ── Help mode (global) ──
		if (this.mode === "help") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
				this.closeHelp();
				return;
			}
			if (data === "?" || data === "h") {
				this.closeHelp();
				return;
			}
			return;
		}

		// ── Detail mode ──
		if (this.mode === "detail") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace)) {
				this.closeDetail();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.closeDetail();
				return;
			}
			if (data === "?" || data === "h") {
				this.openHelp();
				return;
			}
			// Retry failed task
			if (data === "r" && this.actions.onRetryTask) {
				const cols = buildColumns(this.quest.tasks);
				const sel = getSelectedTask(this.quest, cols, this.selection);
				if (sel && sel.task.status === "failed") {
					this.actions.onRetryTask(sel.index);
				}
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.scrollDetail(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.scrollDetail(1);
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.scrollDetail(-5);
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				this.scrollDetail(5);
				return;
			}
			if (matchesKey(data, Key.home)) {
				this.detailScroll = 0;
				this.invalidate();
				return;
			}
			if (matchesKey(data, Key.end)) {
				this.detailScroll = Number.MAX_SAFE_INTEGER;
				this.invalidate();
				return;
			}
			return;
		}

		// ── Board mode ──
		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openDetail();
			return;
		}
		if (data === "?" || data === "h") {
			this.openHelp();
			return;
		}
		// ── Action shortcuts ──
		if (data === "p" && this.actions.onPause) {
			this.actions.onPause();
			return;
		}
		if (data === "r" && this.actions.onResume) {
			this.actions.onResume();
			return;
		}
		if (data === "s" && this.actions.onStart) {
			this.actions.onStart();
			return;
		}
		if (data === "a" && this.actions.onApprove) {
			this.actions.onApprove();
			return;
		}
		const cols = buildColumns(this.quest.tasks);
		let moved = false;
		if (matchesKey(data, Key.left)) {
			const next = moveSelection(this.selection, cols, "left");
			moved = next.col !== this.selectedCol || next.row !== this.selectedRow;
			this.selectedCol = next.col;
			this.selectedRow = next.row;
		} else if (matchesKey(data, Key.right)) {
			const next = moveSelection(this.selection, cols, "right");
			moved = next.col !== this.selectedCol || next.row !== this.selectedRow;
			this.selectedCol = next.col;
			this.selectedRow = next.row;
		} else if (matchesKey(data, Key.up)) {
			const next = moveSelection(this.selection, cols, "up");
			moved = next.col !== this.selectedCol || next.row !== this.selectedRow;
			this.selectedCol = next.col;
			this.selectedRow = next.row;
		} else if (matchesKey(data, Key.down)) {
			const next = moveSelection(this.selection, cols, "down");
			moved = next.col !== this.selectedCol || next.row !== this.selectedRow;
			this.selectedCol = next.col;
			this.selectedRow = next.row;
		}
		if (moved) this.invalidate();
	}

	render(width: number): string[] {
		if (this.mode === "help") return this.renderHelp(width);
		if (this.mode === "detail") return this.renderDetail(width);
		return this.renderBoard(width);
	}

	private renderBoard(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const cols = buildColumns(this.quest.tasks);
		const layout = resolveMaxRows(computeLayout(width), cols);
		const { colWidth, gap, maxRows } = layout;

		const totalTasks = cols.reduce((sum, c) => sum + c.tasks.length, 0);

		const lines: string[] = [];

		// ── Header ──
		const title = `Quest: ${this.quest.name}`;
		lines.push(theme.fg("accent", theme.bold(title)));
		const statusLine = buildStatusLine(this.quest, this.quest.tasks);
		lines.push(theme.fg("dim", `  ${statusLine}`));
		lines.push("");

		if (totalTasks === 0) {
			lines.push(theme.fg("muted", "  No tasks yet. Create a plan with quest_plan."));
			lines.push("");
			lines.push(theme.fg("dim", "esc close"));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// Header row
		const headerLine = cols
			.map((c, ci) => {
				const hdr = ` ${c.title} (${c.tasks.length}) `;
				const padded = hdr.padEnd(colWidth).slice(0, colWidth);
				const colored = theme.fg(c.color, padded);
				return ci === this.selectedCol ? theme.bg("selectedBg", colored) : colored;
			})
			.join(" ".repeat(gap));
		lines.push(headerLine);

		const sep = cols.map(() => "─".repeat(colWidth)).join(" ".repeat(gap));
		lines.push(theme.fg("dim", sep));

		// Task rows
		for (let r = 0; r < maxRows; r++) {
			const rowParts = cols.map((c, ci) => {
				const task = c.tasks[r];
				const isSelected = ci === this.selectedCol && r === this.selectedRow;
				return renderCell(c, task, r, isSelected, this.quest.tasks, theme, colWidth);
			});
			lines.push(rowParts.join(" ".repeat(gap)));
		}

		lines.push("");
		const actionHints = buildActionHints(this.quest, this.actions);
		const footerLine = "←→ columns  ↑↓ tasks  enter detail  ? help  esc close";
		lines.push(theme.fg("dim", footerLine));
		if (actionHints) {
			lines.push(theme.fg("dim", `  ${actionHints}`));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderDetail(width: number): string[] {
		const theme = this.theme;
		const cols = buildColumns(this.quest.tasks);
		const sel = getSelectedTask(this.quest, cols, this.selection);

		// ── Empty state ──
		if (!sel) {
			const lines: string[] = [];
			lines.push(theme.fg("accent", theme.bold("Task Detail")));
			lines.push("");
			lines.push(theme.fg("muted", "  No task selected."));
			lines.push(theme.fg("muted", "  Return to the board and select a task with arrow keys."));
			lines.push("");
			lines.push(theme.fg("dim", "esc back to board"));
			return lines;
		}

		const { task, index } = sel;
		const allLines = buildTaskDetail(task, index, this.quest, width, ICON);

		// Clamp scroll — show at least the last line near the bottom
		const bodyWindow = 12;
		const maxScroll = Math.max(0, allLines.length - bodyWindow);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		if (this.detailScroll < 0) this.detailScroll = 0;

		const result: string[] = [];
		const start = this.detailScroll;
		const end = Math.min(start + bodyWindow, allLines.length);

		// ── Title bar ──
		const title = truncate(`Task #${index + 1}: ${task.content}`, width - 2);
		result.push(theme.fg("accent", theme.bold(`  ${title}`)));
		result.push("");

		// ── Scroll indicator at top ──
		if (start > 0) {
			result.push(theme.fg("dim", `  ↑ ${start} more above`));
		}

		// ── Body lines ──
		for (let i = start; i < end; i++) {
			result.push(`  ${allLines[i]}`);
		}

		// ── Scroll indicator at bottom ──
		if (end < allLines.length) {
			const remaining = allLines.length - end;
			result.push(theme.fg("dim", `  ↓ ${remaining} more below`));
		}

		// ── Footer ──
		result.push("");
		const footerBase = "↑↓ scroll  pgup/pgdn page  home/end  enter/esc back  ? help";
		if (task.status === "failed" && this.actions.onRetryTask) {
			result.push(theme.fg("dim", `${footerBase}  ·  r retry`));
		} else {
			result.push(theme.fg("dim", footerBase));
		}

		return result;
	}

	private renderHelp(width: number): string[] {
		const theme = this.theme;
		const lines = buildHelpOverlay(width);
		const result: string[] = [];

		result.push(theme.fg("accent", theme.bold(lines[0])));
		result.push(theme.fg("dim", lines[1]));
		for (let i = 2; i < lines.length; i++) {
			result.push(theme.fg("dim", lines[i]));
		}
		result.push("");
		result.push(theme.fg("dim", `Active mode: ${this.previousMode}  ·  esc / ? / h to close help`));

		return result;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
