/**
 * quest/runtime.ts — the shared runtime for the quest extension.
 *
 * Every quest tool, event, and command used to be registered inside one 2900-line
 * `default function(pi)` and closed over the same handful of mutable variables
 * (`questCache`, `autoPilotLocked`, `ledgerCache`) and helper functions. That made
 * the shared state implicit and the file impossible to split.
 *
 * `createQuestRuntime(pi)` makes that state explicit: it owns the mutable cache,
 * the auto-pilot lock, and the per-quest ledgers, and exposes the helpers the
 * registration modules need. Each `register*` module takes `(pi, rt)` and
 * destructures the helpers it uses, so handler bodies stay close to their
 * original form while the state lives in exactly one place.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

import type { Quest, QuestStep } from "./types";
import { loadQuest, saveQuest } from "./storage";
import { buildSteeringMessage, nextPendingStep } from "./steering";
import { RunLedger, EvalLog } from "../../core";
import type { RunEvent, EvalEntry } from "../../core";
import { loadTeams, ensureBuiltInTeams } from "./teams";
import { renderStatus, writeQuestSessionMeta } from "./status";
import { syncQuestToTodo } from "./todo-sync";
import { QuestKanban, type KanbanActions } from "./kanban";
import { hasCodebaseTool } from "./codebase";

/** Stable, filesystem-safe slug for a quest name (ledger/eval directory key). */
export function questSlug(name: string): string {
	return name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

export interface QuestRuntime {
	/** The pi extension API this runtime was created against. */
	readonly pi: ExtensionAPI;

	// ── Quest cache ────────────────────────────────────────────────────────────
	/** Cached active quest; lazily loads from disk on first read with a cwd. */
	getQuest(cwd?: string): Quest | null;
	/** Replace (or clear with `null`) the cached quest without persisting. */
	setQuest(quest: Quest | null): void;
	/**
	 * The canonical save path — persists the quest, caches it, refreshes the
	 * status badge, writes session-meta, and syncs steps into pi-todo.
	 */
	persist(ctx: ExtensionContext, quest: Quest): void;

	// ── Auto-pilot lock ──────────────────────────────────────────────────────────
	isAutoPilotLocked(): boolean;
	setAutoPilotLocked(locked: boolean): void;

	// ── Step firing ──────────────────────────────────────────────────────────────
	/**
	 * Steer the agent into a specific step: mark it running, bump bookkeeping,
	 * persist, and deliver the steering message under the auto-pilot lock. This is
	 * the single code path that starts a step — shared by the `agent_end` auto-pilot
	 * and by the command/kanban handlers that need an initial kick.
	 */
	fireStep(ctx: ExtensionContext, quest: Quest, step: QuestStep, index: number): void;
	/**
	 * Fire the next eligible pending step of the active cached quest, if any.
	 * Returns whether a step was fired. Safe to call when idle: slash commands and
	 * kanban actions use this to start work immediately instead of waiting for the
	 * next `agent_end` (which a slash command never produces on its own).
	 */
	fireNextTask(ctx: ExtensionContext): boolean;

	// ── Observability ledgers ────────────────────────────────────────────────────
	getLedgers(cwd: string): { ledger: RunLedger; evalLog: EvalLog };
	ensureLedgers(cwd: string, name: string): void;
	recordRun(cwd: string, event: RunEvent): void;
	recordEval(cwd: string, entry: EvalEntry): void;
	makeEval(
		quest: Quest,
		step: QuestStep,
		index: number,
		status: "done" | "failed" | "skipped",
		verified: boolean,
		evidence: string | null | undefined,
	): EvalEntry;

	// ── Misc helpers ─────────────────────────────────────────────────────────────
	/** Plain-text tool result with empty details. */
	textResult(s: string): { content: { type: "text"; text: string }[]; details: object };
	/** Whether a `codebase` tool is currently registered (active or all). */
	codebaseToolAvailable(): boolean;
	/** Stamp an approved model onto a step and persist, when a valid index is given. */
	stampTaskModel(
		quest: Quest | null,
		taskIndex: number | undefined,
		modelId: string,
		ctx: ExtensionContext,
	): void;
	/** Resolve a sub-agent role's persona markdown (team def wins, else agent file). */
	resolvePersona(team: string | undefined, role: string): string | undefined;
	/** Set the quest's team when the named config exists (no-op otherwise). */
	validateAndSetTeam(quest: Quest, teamName?: string): void;
	/** Kanban action callbacks that mirror the /quest command handlers. */
	makeKanbanActions(ctx: ExtensionContext): KanbanActions;
	/** Shared kanban overlay launcher used by /quest and /quest kanban. */
	launchKanban(ctx: ExtensionContext, quest: Quest): Promise<void>;
}

export function createQuestRuntime(pi: ExtensionAPI): QuestRuntime {
	let questCache: Quest | null = null;
	let autoPilotLocked = false;
	const ledgerCache = new Map<string, { ledger: RunLedger; evalLog: EvalLog }>();

	function getQuest(cwd?: string): Quest | null {
		if (!questCache && cwd) questCache = loadQuest(cwd);
		return questCache;
	}

	function setQuest(quest: Quest | null): void {
		questCache = quest;
	}

	function getLedgers(cwd: string): { ledger: RunLedger; evalLog: EvalLog } {
		let entry = ledgerCache.get(cwd);
		if (!entry) {
			const q = getQuest(cwd) ?? ({ name: "unknown" } as Quest);
			entry = {
				ledger: new RunLedger(cwd, questSlug(q.name)),
				evalLog: new EvalLog(cwd, questSlug(q.name)),
			};
			ledgerCache.set(cwd, entry);
		}
		return entry;
	}

	function ensureLedgers(cwd: string, name: string): void {
		ledgerCache.set(cwd, {
			ledger: new RunLedger(cwd, questSlug(name)),
			evalLog: new EvalLog(cwd, questSlug(name)),
		});
	}

	function recordRun(cwd: string, event: RunEvent): void {
		try {
			getLedgers(cwd).ledger.record(event);
		} catch {
			/* best-effort observability */
		}
	}

	function recordEval(cwd: string, entry: EvalEntry): void {
		try {
			getLedgers(cwd).evalLog.record(entry);
		} catch {
			/* best-effort observability */
		}
	}

	function makeEval(
		quest: Quest,
		step: QuestStep,
		index: number,
		status: "done" | "failed" | "skipped",
		verified: boolean,
		evidence: string | null | undefined,
	): EvalEntry {
		return {
			quest: quest.name,
			questSlug: questSlug(quest.name),
			taskIndex: index,
			taskContent: step.content,
			agent: step.agent,
			model: step.model,
			status,
			verified,
			verifyEvidence: evidence ?? null,
			durationMs: step.startedAt ? (step.completedAt ?? Date.now()) - step.startedAt : 0,
			tokensIn: 0,
			tokensOut: 0,
			attempts: step.attempts,
			timestamp: Date.now(),
		};
	}

	function persist(ctx: ExtensionContext, quest: Quest): void {
		saveQuest(quest, ctx.cwd);
		questCache = quest;
		renderStatus(ctx, quest);
		writeQuestSessionMeta(ctx.cwd, quest);
		syncQuestToTodo(quest, ctx.cwd);
	}

	function fireStep(ctx: ExtensionContext, quest: Quest, step: QuestStep, index: number): void {
		step.status = "running";
		step.attempts++;
		if (!step.startedAt) step.startedAt = Date.now();
		quest.lastFiredStepIndex = index;
		quest.stepsSincePause++;
		persist(ctx, quest);

		autoPilotLocked = true;
		try {
			pi.sendUserMessage(buildSteeringMessage(quest, step, index, ctx.cwd), {
				deliverAs: "steer",
			});
		} finally {
			autoPilotLocked = false;
		}
	}

	function fireNextTask(ctx: ExtensionContext): boolean {
		const quest = getQuest(ctx.cwd);
		if (!quest || quest.status !== "active") return false;
		const next = nextPendingStep(quest);
		if (!next) return false;
		fireStep(ctx, quest, next.task, next.index);
		return true;
	}

	const textResult = (s: string) => ({
		content: [{ type: "text" as const, text: s }],
		details: {},
	});

	function codebaseToolAvailable(): boolean {
		try {
			return hasCodebaseTool(pi.getActiveTools()) || hasCodebaseTool(pi.getAllTools());
		} catch {
			return false;
		}
	}

	function stampTaskModel(
		quest: Quest | null,
		taskIndex: number | undefined,
		modelId: string,
		ctx: ExtensionContext,
	): void {
		if (!quest || taskIndex === undefined) return;
		if (taskIndex < 0 || taskIndex >= quest.steps.length) return;
		quest.steps[taskIndex].model = modelId;
		persist(ctx, quest);
	}

	function resolvePersona(team: string | undefined, role: string): string | undefined {
		if (team) {
			const fromTeam = loadTeams()[team]?.agents?.find((a) => a.name === role)?.markdown;
			if (fromTeam?.trim()) return fromTeam;
		}
		// Guard against path traversal — role comes from step data, not a constant.
		if (!/^[a-zA-Z0-9_-]+$/.test(role)) return undefined;
		const file = join(homedir(), ".pi", "agent", "agents", `${role}.md`);
		try {
			return existsSync(file) ? readFileSync(file, "utf8") : undefined;
		} catch {
			return undefined;
		}
	}

	function validateAndSetTeam(quest: Quest, teamName?: string): void {
		if (!teamName) return;
		ensureBuiltInTeams();
		const config = loadTeams()[teamName];
		if (config) {
			quest.team = teamName;
		}
	}

	function makeKanbanActions(ctx: ExtensionContext): KanbanActions {
		return {
			onPause: () => {
				const q = getQuest(ctx.cwd);
				if (!q || q.status !== "active") return;
				q.status = "paused";
				q.pauseReason = "Paused via board.";
				q.lastFiredStepIndex = -1;
				q.sameStepCount = 0;
				persist(ctx, q);
				ctx.ui.notify?.(`Quest "${q.name}" paused. r to resume.`, "info");
			},
			onResume: () => {
				const q = getQuest(ctx.cwd);
				if (!q || q.status !== "paused") return;
				q.status = "active";
				q.stepsSincePause = 0;
				q.lastFiredStepIndex = -1;
				q.sameStepCount = 0;
				q.pauseReason = null;
				persist(ctx, q);
				ctx.ui.notify?.(`Quest "${q.name}" resumed.`, "info");
				fireNextTask(ctx);
			},
			onStart: () => {
				const q = getQuest(ctx.cwd);
				if (!q) return;
				if (q.status === "active") return;
				if (q.steps.length === 0) return;
				if (q.planningMode === "approve" && !q.planApproved) {
					ctx.ui.notify?.("Approval required. Use 'a' to approve the plan first.", "warning");
					return;
				}
				q.status = "active";
				q.stepsSincePause = 0;
				q.lastFiredStepIndex = -1;
				q.sameStepCount = 0;
				q.pauseReason = null;
				persist(ctx, q);
				ctx.ui.notify?.(`Quest "${q.name}" started — ${q.steps.length} steps.`, "info");
				fireNextTask(ctx);
			},
			onApprove: () => {
				const q = getQuest(ctx.cwd);
				if (!q || q.planApproved || q.steps.length === 0) return;
				if (q.planningMode !== "approve") return;
				q.planApproved = true;
				q.status = "active";
				q.stepsSincePause = 0;
				q.lastFiredStepIndex = -1;
				q.sameStepCount = 0;
				q.pauseReason = null;
				persist(ctx, q);
				ctx.ui.notify?.(
					`Plan approved: "${q.name}" — ${q.steps.length} steps. Auto-pilot engaged.`,
					"info",
				);
				fireNextTask(ctx);
			},
			onRetryTask: (taskIndex: number) => {
				const q = getQuest(ctx.cwd);
				if (!q) return;
				const task = q.steps[taskIndex];
				if (!task || task.status !== "failed") return;
				task.status = "pending";
				task.attempts = 0;
				task.startedAt = null;
				task.completedAt = null;
				task.result = null;
				persist(ctx, q);
				ctx.ui.notify?.(`Step #${taskIndex + 1} "${task.content}" reset for retry.`, "info");
			},
		};
	}

	async function launchKanban(ctx: ExtensionContext, quest: Quest): Promise<void> {
		await ctx.ui.custom(
			(tui, theme, _kb, done) => {
				const kanban = new QuestKanban(quest, theme, makeKanbanActions(ctx));
				kanban.onClose = () => done(undefined);
				return {
					render: (w: number) => {
						const fresh = loadQuest(ctx.cwd);
						if (fresh) kanban.setQuest(fresh);
						return kanban.render(w);
					},
					invalidate: () => kanban.invalidate(),
					handleInput: (data: string) => {
						kanban.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true },
		);
	}

	return {
		pi,
		getQuest,
		setQuest,
		persist,
		isAutoPilotLocked: () => autoPilotLocked,
		setAutoPilotLocked: (locked: boolean) => {
			autoPilotLocked = locked;
		},
		fireStep,
		fireNextTask,
		getLedgers,
		ensureLedgers,
		recordRun,
		recordEval,
		makeEval,
		textResult,
		codebaseToolAvailable,
		stampTaskModel,
		resolvePersona,
		validateAndSetTeam,
		makeKanbanActions,
		launchKanban,
	};
}
