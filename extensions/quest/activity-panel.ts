/**
 * quest/activity-panel.ts — live activity panel for sub-agent execution
 *
 * Consumes tool_execution_start/update/end events for `subagent` and
 * `quest_delegate` (legacy path) tools and renders a compact, non-modal
 * widget above the editor plus an optional footer/status line. Keeps the
 * kanban as the detailed view; never steals focus.
 *
 * The tracker is pure — it knows nothing about pi APIs. The register-events
 * module calls into it and pushes results into `ctx.ui.setWidget` / `setStatus`.
 */

import type { Quest } from "./types";
import { nextPendingStep } from "./steering";

// ── Core types ───────────────────────────────────────────────────────────

export type ActivityPhase = "starting" | "running" | "completed" | "failed";

/** A single sub-agent execution tracked by the activity panel. */
export interface ActivityRun {
	/** pi tool-call id from the parent session. */
	toolCallId: string;
	/** Tool that was invoked: "subagent" (pi-minions) or "quest_delegate" (legacy). */
	toolName: "subagent" | "quest_delegate";
	/** Quest name this run belongs to — resolved from the runtime. */
	questName: string;
	/** Step index this run is working on, or -1 when unknown. */
	stepIndex: number;
	/** Sub-agent role (e.g. "worker", "scout", "verifier"). */
	agent: string;
	/** Model id the sub-agent is running with, when known. */
	model?: string;
	/** Current lifecycle phase. */
	phase: ActivityPhase;
	/** Epoch ms the tool started execution. */
	startedAt: number;
	/** Epoch ms the tool finished (completed or failed). */
	completedAt?: number;
	/**
	 * Brief, UI-safe summary of what the agent is doing. Extracted from the
	 * tool args or partial results. Must never leak sensitive information.
	 */
	currentActivity: string;
	/** First file path the agent wrote to, when detectable. Nullable; advisory only. */
	writeClaim?: string;
	/** Whether the parent step is currently in verification. */
	waitingVerifier: boolean;
	/** Whether this run ended with an error. */
	isError: boolean;
	/** Error message when `isError` is true. */
	error?: string;
}

/** Snapshot of relevant quest state needed by the renderer. */
export interface ActivityQuestState {
	name: string;
	status: string;
	done: number;
	total: number;
	hasVerifierPending: boolean;
	nextStepContent: string;
}

// ── Tracker ──────────────────────────────────────────────────────────────

/** How long (ms) completed/failed runs stay visible before being pruned. */
const COMPLETED_TTL_MS = 15_000;

export class ActivityTracker {
	/** Active runs keyed by toolCallId. */
	private runs = new Map<string, ActivityRun>();

	/** Clear all state (session switch / reload). */
	reset(): void {
		this.runs.clear();
	}

	/** Prune completed/failed runs older than TTL. */
	prune(now: number = Date.now()): void {
		for (const [id, run] of this.runs) {
			if (
				(run.phase === "completed" || run.phase === "failed") &&
				run.completedAt != null &&
				now - run.completedAt > COMPLETED_TTL_MS
			) {
				this.runs.delete(id);
			}
		}
	}

	/** Record a tool_execution_start for a tracked tool. */
	onStart(
		toolCallId: string,
		toolName: "subagent" | "quest_delegate",
		args: Record<string, unknown>,
		quest: Quest,
	): void {
		const stepIndex =
			toolName === "quest_delegate"
				? typeof args.index === "number"
					? args.index
					: -1
				: typeof args.stepIndex === "number"
					? args.stepIndex
					: typeof args.taskIndex === "number"
						? args.taskIndex
						: -1;

		const agent = typeof args.agent === "string" ? args.agent : "worker";
		const model = typeof args.model === "string" && args.model.length > 0 ? args.model : undefined;

		// Resolve step content for quest_delegate, or derive from quest steps.
		let activity = "";
		if (toolName === "quest_delegate" && stepIndex >= 0 && stepIndex < quest.steps.length) {
			const step = quest.steps[stepIndex];
			activity = step.content.slice(0, 80);
		} else {
			activity = `delegating to ${agent}`;
		}

		const run: ActivityRun = {
			toolCallId,
			toolName,
			questName: quest.name,
			stepIndex,
			agent,
			model,
			phase: "starting",
			startedAt: Date.now(),
			currentActivity: activity,
			waitingVerifier: false,
			isError: false,
		};

		this.runs.set(toolCallId, run);
	}

	/** Record a tool_execution_update (partial progress). */
	onUpdate(toolCallId: string, partialResult: unknown): void {
		const run = this.runs.get(toolCallId);
		if (!run) return;

		// Transition from starting → running on first update.
		if (run.phase === "starting") {
			run.phase = "running";
		}

		// Extract a safe activity summary from the partial result.
		// The partialResult for subagent is typically accumulated output text.
		// We show only a short, sanitized prefix — never the full output.
		run.currentActivity = safeActivityFromResult(partialResult) || run.currentActivity;

		// Try to detect a write claim: look for file paths in partial result.
		// This is advisory — no enforcement, just visual feedback.
		if (!run.writeClaim) {
			run.writeClaim = guessWriteClaim(partialResult);
		}
	}

	/** Record a tool_execution_end (completion or error). */
	onEnd(toolCallId: string, isError: boolean, error?: string): void {
		const run = this.runs.get(toolCallId);
		if (!run) return;

		run.phase = isError ? "failed" : "completed";
		run.completedAt = Date.now();
		run.isError = isError;
		if (error) run.error = error;
	}

	/** Mark a step as waiting for verification. */
	setWaitingVerifier(stepIndex: number): void {
		for (const run of this.runs.values()) {
			if (run.stepIndex === stepIndex) {
				run.waitingVerifier = true;
			}
		}
	}

	/** Resolve a compact quest-state snapshot for the renderer. */
	questSnapshot(quest: Quest): ActivityQuestState {
		const done = quest.steps.filter((s) => s.status === "done").length;
		const verifying = quest.steps.some((s) => s.status === "verifying");
		const next = nextPendingStep(quest);
		return {
			name: quest.name,
			status: quest.status,
			done,
			total: quest.steps.length,
			hasVerifierPending: verifying,
			nextStepContent: next?.task.content ?? "",
		};
	}

	/** The active runs (starting + running), newest first. */
	get activeRuns(): ActivityRun[] {
		const list: ActivityRun[] = [];
		for (const r of this.runs.values()) {
			if (r.phase === "starting" || r.phase === "running") {
				list.push(r);
			}
		}
		list.sort((a, b) => b.startedAt - a.startedAt);
		return list;
	}

	/** Recently completed runs (completed + failed), newest first. */
	get recentRuns(): ActivityRun[] {
		this.prune();
		const list: ActivityRun[] = [];
		for (const r of this.runs.values()) {
			if (r.phase === "completed" || r.phase === "failed") {
				list.push(r);
			}
		}
		list.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
		return list;
	}

	/** True when anything is visible — widgets should hide when idle. */
	get hasActivity(): boolean {
		return this.activeRuns.length > 0 || this.recentRuns.length > 0;
	}
}

// ── Safe extraction helpers ──────────────────────────────────────────────

/** Max chars of output text shown in the activity panel. */
const ACTIVITY_MAX = 80;

/**
 * Extract a brief, UI-safe activity summary from a tool's partial result.
 * The result is typically accumulated output text from a sub-agent session.
 * We take only the first line, truncated, to avoid leaking sensitive detail.
 */
function safeActivityFromResult(partialResult: unknown): string | null {
	try {
		const text =
			typeof partialResult === "string"
				? partialResult
				: partialResult != null && typeof partialResult === "object" && "content" in partialResult
					? String((partialResult as { content: unknown }).content ?? "")
					: "";
		if (!text) return null;

		// Take first non-empty line, strip markdown formatting
		const firstLine =
			text
				.split("\n")
				.find((l) => l.trim().length > 0)
				?.trim() ?? "";
		if (!firstLine) return null;

		// Strip common markdown prefixes for cleaner display
		const cleaned = firstLine.replace(/^[#*>-]+ /, "").trim();
		return cleaned.length > ACTIVITY_MAX ? cleaned.slice(0, ACTIVITY_MAX - 1) + "…" : cleaned;
	} catch {
		return null;
	}
}

/** Advisory heuristic: try to detect a file being written from partial output. */
function guessWriteClaim(partialResult: unknown): string | undefined {
	try {
		const text =
			typeof partialResult === "string"
				? partialResult
				: partialResult != null && typeof partialResult === "object" && "content" in partialResult
					? String((partialResult as { content: unknown }).content ?? "")
					: "";
		if (!text) return undefined;

		// Look for file path patterns — common tool output formats.
		const patterns = [
			/\b(?:Writing|Created|Saved|Edited|Modified)\s+(?:to\s+)?`?([^\s`,\n]{3,80})`?/i,
			/`([^\s`]{3,80}\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|md|json|yaml|yml|html|css))`/,
		];
		for (const p of patterns) {
			const m = text.match(p);
			if (m?.[1]) {
				const file = m[1].replace(/^\.\//, "");
				return file.length > 40 ? file.slice(-40) : file;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// ── Widget renderer (setWidget-compatible) ───────────────────────────────

/**
 * Build a widget factory suitable for `ctx.ui.setWidget`. Returns a function
 * `(tui, theme) => Component` that renders active sub-agent runs and recently
 * completed ones.
 */
export function buildActivityWidgetFn(
	tracker: ActivityTracker,
	quest: ActivityQuestState | null,
): (_tui: unknown, _theme: unknown) => { render: () => string[]; invalidate: () => void } {
	return (_tui: unknown, _theme: unknown) => ({
		render: () => renderWidgetLines(tracker, quest),
		invalidate: () => {},
	});
}

function renderWidgetLines(tracker: ActivityTracker, quest: ActivityQuestState | null): string[] {
	const lines: string[] = [];
	const active = tracker.activeRuns;
	const recent = tracker.recentRuns;

	if (!quest && active.length === 0 && recent.length === 0) return [];

	// ── Quest header ──
	if (quest) {
		const icon = quest.status === "active" ? "⚔" : quest.status === "planning" ? "📋" : "⏸";
		const header = `${icon} ${quest.name} — ${quest.done}/${quest.total} done`;
		lines.push(header);
	}

	// ── Active runs ──
	for (const run of active) {
		const phaseIcon = run.waitingVerifier ? "🔍" : "▶";
		const elapsed = formatElapsed(Date.now() - run.startedAt);
		const modelStr = run.model ? ` · ${shortModel(run.model)}` : "";
		const writeStr = run.writeClaim ? ` · 📄${run.writeClaim}` : "";
		const stepStr = run.stepIndex >= 0 ? `Step #${run.stepIndex + 1}: ` : "";
		const line = `  ${phaseIcon} ${run.agent} · ${stepStr}${run.currentActivity} · ${elapsed}${modelStr}${writeStr}`;
		lines.push(line);
	}

	// ── Verification pending ──
	if (quest?.hasVerifierPending && active.length === 0) {
		const nextStr = quest.nextStepContent ? ` — next: ${quest.nextStepContent.slice(0, 50)}` : "";
		lines.push(`  🔍 verifying${nextStr}`);
	}

	// ── Recent completions (max 2) ──
	for (const run of recent.slice(0, 2)) {
		const icon = run.isError ? "✗" : "✓";
		const stepStr = run.stepIndex >= 0 ? `Step #${run.stepIndex + 1}: ` : "";
		const line = `  ${icon} ${run.agent} · ${stepStr}${run.currentActivity}`;
		lines.push(line);
	}

	return lines;
}

// ── Footer renderer ──────────────────────────────────────────────────────

/**
 * Build a compact one-line footer string for the quest activity.
 * Returns null when there's nothing to show.
 */
export function buildActivityFooter(
	tracker: ActivityTracker,
	quest: ActivityQuestState | null,
): string | null {
	const active = tracker.activeRuns;
	if (active.length === 0) {
		if (quest?.hasVerifierPending) return "🔍 verifying";
		return null;
	}

	const run = active[0];
	const elapsed = formatElapsed(Date.now() - run.startedAt);
	const parts: string[] = [];
	if (quest) parts.push(`${quest.name}`);
	parts.push(`${run.agent}`);
	if (run.model) parts.push(shortModel(run.model));
	parts.push(elapsed);
	if (active.length > 1) parts.push(`+${active.length - 1}`);
	return parts.join(" · ");
}

// ── Status badge renderer ────────────────────────────────────────────────

/**
 * Build a compact status string for the quest status badge.
 * Shows active sub-agent count on top of existing quest status.
 */
export function buildActivityStatus(
	tracker: ActivityTracker,
	quest: ActivityQuestState | null,
): string | null {
	if (!quest) return null;
	const active = tracker.activeRuns;
	const icon = quest.status === "active" ? "⚔" : quest.status === "planning" ? "📋" : "⏸";
	const label = quest.total > 0 ? `${icon} ${quest.done}/${quest.total}` : `${icon} plan`;
	if (active.length > 0) return `${label} ▶`;
	if (quest.hasVerifierPending) return `${label} 🔍`;
	return label;
}

// ── Working indicator ────────────────────────────────────────────────────

/**
 * Build a pixie-dust animated indicator for when a sub-agent is running.
 * Returns frames or undefined to use the default.
 */
export function buildActivityWorkingIndicator(
	tracker: ActivityTracker,
): { frames: string[]; intervalMs: number } | undefined {
	const active = tracker.activeRuns;
	if (active.length === 0) return undefined;

	// Pixie-dust spinner: different density dots for active sub-agents.
	return {
		frames: ["·", "•", "●", "•"],
		intervalMs: 180,
	};
}

// ── Shared formatting helpers ────────────────────────────────────────────

function formatElapsed(ms: number): string {
	if (ms < 0) return "0s";
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3600000) return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	return `${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

function shortModel(id: string): string {
	// Keep provider prefix for clarity, truncate the rest.
	if (id.includes("/")) {
		const parts = id.split("/");
		return parts[0] + "/" + parts[parts.length - 1];
	}
	if (id.length > 20) return id.slice(0, 19) + "…";
	return id;
}
