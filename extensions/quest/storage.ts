import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentModelChoice, ModelLadderConfig } from "../../core";
import {
	THINKING_LEVELS,
	asRecord,
	strArray,
	boolOr,
	strOr,
	oneOf,
	numOr,
	optStr,
	optNum,
} from "../../core";
import type {
	GitIntegration,
	Quest,
	SandboxMode,
	SandboxPolicy,
	SandboxOverrides,
	WorktreeConfig,
} from "./types";
import { coerceFailureBrief } from "./ladder";
import {
	readJSON,
	writeJSON,
	updateJSON,
	loadProjectMemory,
	projectMemoryPath,
	questActivePath,
	questArchiveDir,
	questArchiveIndexPath,
	CONTRACT_VERSION,
	isFutureContract,
} from "./utils";

/**
 * Read the project's remembered role → model assignments (written by
 * `quest_assign_model`). Returns an empty map when memory is absent or written
 * by a newer contract than this code understands.
 */
export function loadAgentModels(cwd: string): Record<string, AgentModelChoice> {
	const memory = loadProjectMemory(cwd);
	const models = asRecord(memory?.agentModels);
	const choices: Record<string, AgentModelChoice> = {};
	for (const [role, value] of Object.entries(models)) {
		const raw = asRecord(value);
		const model = optStr(raw.model)?.trim();
		if (!model) continue;
		choices[role] = {
			model,
			provider: optStr(raw.provider),
			thinkingLevel: oneOf(raw.thinkingLevel, THINKING_LEVELS) ? raw.thinkingLevel : undefined,
			reason: optStr(raw.reason),
			timestamp: numOr(raw.timestamp, 0),
		};
	}
	return choices;
}

/**
 * Persist a user-approved model assignment for a sub-agent role onto the shared
 * project-memory file. Read-merge-write so a concurrent pi-memory save isn't
 * clobbered, and skip if pi-memory wrote a newer contract.
 */
export function rememberAgentModel(cwd: string, role: string, choice: AgentModelChoice): void {
	updateJSON<Record<string, any>>(
		projectMemoryPath(cwd),
		(memory) => {
			if (isFutureContract(memory)) return memory;
			const agentModels = { ...(memory.agentModels ?? {}) };
			agentModels[role] = choice;
			return { ...memory, agentModels, contractVersion: CONTRACT_VERSION };
		},
		{},
	);
}

/**
 * Read the project's user-approved model escalation ladder (written by
 * `quest_assign_ladder`). Null when no ladder is approved, the memory file is
 * absent/malformed, or it was written by a newer contract.
 */
export function loadModelLadder(cwd: string): ModelLadderConfig | null {
	const memory = loadProjectMemory(cwd);
	const raw = asRecord(memory?.modelLadder);
	const rungs = strArray(raw.rungs)
		.map((r) => r.trim())
		.filter(Boolean);
	if (rungs.length === 0) return null;
	const roles = strArray(raw.roles)
		.map((r) => r.trim())
		.filter(Boolean);
	return {
		rungs,
		roles: roles.length > 0 ? roles : undefined,
		approvedAt: numOr(raw.approvedAt, 0),
		reason: optStr(raw.reason),
	};
}

/**
 * Persist a user-approved model ladder onto the shared project-memory file.
 * Read-merge-write so a concurrent pi-memory save isn't clobbered, and skip if
 * pi-memory wrote a newer contract (mirrors rememberAgentModel).
 */
export function rememberModelLadder(cwd: string, config: ModelLadderConfig): void {
	updateJSON<Record<string, any>>(
		projectMemoryPath(cwd),
		(memory) => {
			if (isFutureContract(memory)) return memory;
			return { ...memory, modelLadder: config, contractVersion: CONTRACT_VERSION };
		},
		{},
	);
}

const VALID_SANDBOX_MODES: SandboxMode[] = ["none", "restricted", "isolated"];

function normalizeSandboxPolicy(input: unknown): SandboxPolicy {
	const raw = asRecord(input);
	const mode: SandboxMode = oneOf(raw.mode, VALID_SANDBOX_MODES) ? raw.mode : "none";
	const defaultAllow = mode === "none";
	return {
		mode,
		allowedPaths: strArray(raw.allowedPaths),
		deniedPaths: strArray(raw.deniedPaths),
		allowCommands: strArray(raw.allowCommands),
		denyCommands: strArray(raw.denyCommands),
		allowNetwork: boolOr(raw.allowNetwork, defaultAllow),
		allowPackageInstall: boolOr(raw.allowPackageInstall, defaultAllow),
		worktree:
			raw.worktree != null && typeof raw.worktree === "object"
				? normalizeWorktreeConfig(raw.worktree)
				: null,
	};
}

function normalizeSandboxOverrides(input: unknown): SandboxOverrides {
	const raw = asRecord(input);
	const overrides: SandboxOverrides = {};
	if (oneOf(raw.mode, VALID_SANDBOX_MODES)) overrides.mode = raw.mode;
	const allowedPaths = strArray(raw.allowedPaths);
	if (allowedPaths.length > 0) overrides.allowedPaths = allowedPaths;
	const deniedPaths = strArray(raw.deniedPaths);
	if (deniedPaths.length > 0) overrides.deniedPaths = deniedPaths;
	const allowCommands = strArray(raw.allowCommands);
	if (allowCommands.length > 0) overrides.allowCommands = allowCommands;
	const denyCommands = strArray(raw.denyCommands);
	if (denyCommands.length > 0) overrides.denyCommands = denyCommands;
	if (typeof raw.allowNetwork === "boolean") overrides.allowNetwork = raw.allowNetwork;
	if (typeof raw.allowPackageInstall === "boolean")
		overrides.allowPackageInstall = raw.allowPackageInstall;
	return overrides;
}

function normalizeWorktreeConfig(input: unknown): WorktreeConfig {
	const raw = asRecord(input);
	return {
		enabled: boolOr(raw.enabled, false),
		baseBranch: strOr(raw.baseBranch, "main"),
		path: strOr(raw.path, ""),
		autoCleanup: boolOr(raw.autoCleanup, true),
	};
}

function normalizeSandboxArtifacts(input: unknown) {
	const raw = asRecord(input);
	const calls = Array.isArray(raw.calls)
		? raw.calls
				.map((c: unknown) => {
					const r = asRecord(c);
					return {
						tool: strOr(r.tool, ""),
						input: typeof r.input === "object" && r.input !== null ? r.input : {},
						blocked: boolOr(r.blocked, false),
						reason: optStr(r.reason),
						timestamp: numOr(r.timestamp, 0),
					};
				})
				.filter((c: { tool: string }) => c.tool)
		: [];
	return {
		calls,
		touchedPaths: strArray(raw.touchedPaths),
		changedFiles: Array.isArray(raw.changedFiles) ? strArray(raw.changedFiles) : undefined,
		commitHash: optStr(raw.commitHash),
		worktreePath: optStr(raw.worktreePath),
	};
}

export function syncConventionsToMemory(quest: Quest, cwd: string): void {
	try {
		if (!quest.conventions.length) return;
		// Read-merge-write the shared memory file: merge quest's conventions into
		// whatever is on disk, skipping if pi-memory wrote a newer contract.
		updateJSON<Record<string, any>>(
			projectMemoryPath(cwd),
			(existing) => {
				if (isFutureContract(existing)) return existing; // don't clobber a newer-suite file
				const base =
					existing && Object.keys(existing).length
						? existing
						: { name: basename(cwd), conventions: [], lastScanned: 0 };
				const conventions = Array.isArray(base.conventions) ? base.conventions : [];
				const merged = [...new Set([...conventions, ...quest.conventions])];
				return {
					...base,
					conventions: merged,
					lastModified: Date.now(),
					contractVersion: CONTRACT_VERSION,
				};
			},
			{},
		);
	} catch (e) {
		console.error(
			"[pi-quest] syncConventionsToMemory:",
			e,
		); /* optional — pi-memory may not be installed */
	}
}

export function emptyQuest(
	name: string,
	goal: string,
	team?: string,
	planningMode: "auto" | "approve" = "auto",
	verifyOnComplete = true,
	gitIntegration?: Partial<GitIntegration>,
	sandbox?: SandboxPolicy,
): Quest {
	return {
		version: 1,
		name,
		goal,
		status: "planning",
		steps: [],
		tasks: [],
		stepsSincePause: 0,
		tasksSincePause: 0,
		lastFiredStepIndex: -1,
		lastFiredTaskIndex: -1,
		sameStepCount: 0,
		sameTaskCount: 0,
		pauseReason: null,
		conventions: [],
		commits: [],
		planningMode,
		planApproved: false,
		verifyOnComplete,
		gitIntegration: {
			autoCommit: gitIntegration?.autoCommit ?? true,
			autoBranch: gitIntegration?.autoBranch ?? true,
			autoPR: gitIntegration?.autoPR ?? false,
			branchPrefix: gitIntegration?.branchPrefix ?? "quest/",
		},
		sandbox: sandbox && sandbox.mode !== "none" ? sandbox : undefined,
		createdAt: Date.now(),
		completedAt: null,
		updatedAt: Date.now(),
		team: team || undefined,
	};
}

export function loadQuest(cwd: string): Quest | null {
	try {
		const activePath = questActivePath(cwd);
		if (!existsSync(activePath)) return null;
		const raw = JSON.parse(readFileSync(activePath, "utf8"));
		const rawSteps = Array.isArray(raw?.steps) ? raw.steps : raw?.tasks;
		if (raw && raw.version === 1 && Array.isArray(rawSteps)) {
			raw.steps = rawSteps.map((t: any) => ({
				content: t.content || "",
				status: t.status || "pending",
				agent: t.agent || "worker",
				context: t.context || "",
				dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
				result: t.result || null,
				attempts: t.attempts || 0,
				completedAt: t.completedAt || null,
				verified: typeof t.verified === "boolean" ? t.verified : false,
				verifyResult: t.verifyResult || null,
				verifyRetries: typeof t.verifyRetries === "number" ? t.verifyRetries : 0,
				commitHash: t.commitHash || null,
				branchName: t.branchName || null,
				startedAt: typeof t.startedAt === "number" ? t.startedAt : null,
				model: typeof t.model === "string" && t.model.trim() ? t.model : undefined,
				rung: typeof t.rung === "number" ? t.rung : undefined,
				escalations: typeof t.escalations === "number" ? t.escalations : 0,
				failureBriefs: Array.isArray(t.failureBriefs)
					? t.failureBriefs.map(coerceFailureBrief).filter((b: unknown) => b !== null)
					: [],
				lastModel: typeof t.lastModel === "string" && t.lastModel.trim() ? t.lastModel : undefined,
				sandbox:
					t.sandbox && typeof t.sandbox === "object"
						? normalizeSandboxOverrides(t.sandbox)
						: undefined,
				sandboxArtifacts:
					t.sandboxArtifacts && typeof t.sandboxArtifacts === "object"
						? normalizeSandboxArtifacts(t.sandboxArtifacts)
						: undefined,
			}));
			// Legacy mirror for downgrade compatibility. New code uses steps.
			raw.tasks = raw.steps;
			if (raw.planningMode !== "auto" && raw.planningMode !== "approve") {
				raw.planningMode = "auto";
			}
			if (typeof raw.planApproved !== "boolean") {
				raw.planApproved = false;
			}
			if (typeof raw.verifyOnComplete !== "boolean") {
				// Default to true to match emptyQuest and the quest_create docs — a
				// legacy quest missing this field should verify, not silently skip.
				raw.verifyOnComplete = true;
			}
			if (!raw.commits || !Array.isArray(raw.commits)) {
				raw.commits = [];
			} else {
				raw.commits = raw.commits.map((c: any) => {
					const stepIndex =
						typeof c.stepIndex === "number"
							? c.stepIndex
							: typeof c.taskIndex === "number"
								? c.taskIndex
								: 0;
					return {
						stepIndex,
						taskIndex: stepIndex,
						hash: typeof c.hash === "string" ? c.hash : "",
						message: typeof c.message === "string" ? c.message : "",
						branch: typeof c.branch === "string" ? c.branch : undefined,
						timestamp: typeof c.timestamp === "number" ? c.timestamp : Date.now(),
					};
				});
			}
			if (!raw.researchFindings || !Array.isArray(raw.researchFindings)) {
				raw.researchFindings = [];
			}
			const gi =
				raw.gitIntegration && typeof raw.gitIntegration === "object" ? raw.gitIntegration : {};
			raw.gitIntegration = {
				autoCommit: typeof gi.autoCommit === "boolean" ? gi.autoCommit : true,
				autoBranch: typeof gi.autoBranch === "boolean" ? gi.autoBranch : true,
				autoPR: typeof gi.autoPR === "boolean" ? gi.autoPR : false,
				branchPrefix: typeof gi.branchPrefix === "string" ? gi.branchPrefix : "quest/",
			};
			if (raw.team !== undefined && typeof raw.team !== "string") {
				raw.team = undefined;
			}
			if (typeof raw.createdAt !== "number") {
				raw.createdAt = Date.now();
			}
			if (typeof raw.updatedAt !== "number") {
				raw.updatedAt = Date.now();
			}
			if (!raw.conventions || !Array.isArray(raw.conventions)) {
				raw.conventions = [];
			}
			const validStatuses: string[] = ["planning", "active", "paused", "done", "idle"];
			if (!validStatuses.includes(raw.status)) {
				raw.status = "idle";
			}
			raw.stepsSincePause =
				typeof raw.stepsSincePause === "number"
					? raw.stepsSincePause
					: typeof raw.tasksSincePause === "number"
						? raw.tasksSincePause
						: 0;
			raw.tasksSincePause = raw.stepsSincePause;
			raw.lastFiredStepIndex =
				typeof raw.lastFiredStepIndex === "number"
					? raw.lastFiredStepIndex
					: typeof raw.lastFiredTaskIndex === "number"
						? raw.lastFiredTaskIndex
						: -1;
			raw.lastFiredTaskIndex = raw.lastFiredStepIndex;
			raw.sameStepCount =
				typeof raw.sameStepCount === "number"
					? raw.sameStepCount
					: typeof raw.sameTaskCount === "number"
						? raw.sameTaskCount
						: 0;
			raw.sameTaskCount = raw.sameStepCount;
			// ── Sandbox (backwards-compatible: absent = no sandbox) ──────
			if (raw.sandbox && typeof raw.sandbox === "object") {
				raw.sandbox = normalizeSandboxPolicy(raw.sandbox);
			} else {
				raw.sandbox = undefined;
			}

			const finishedSteps =
				raw.steps.length > 0 &&
				raw.steps.every(
					(t: Quest["steps"][number]) => t.status === "done" || t.status === "skipped",
				) &&
				!raw.steps.some((t: Quest["steps"][number]) => t.status === "failed");
			if (raw.status === "done" || finishedSteps) {
				raw.status = "done";
				raw.completedAt = typeof raw.completedAt === "number" ? raw.completedAt : Date.now();
				if (archiveQuest(raw as Quest, cwd)) clearActiveQuest(cwd);
				return null;
			}

			return raw as Quest;
		}
	} catch (e) {
		console.error("[pi-quest] loadQuest:", e); /* corrupt */
	}
	return null;
}

export function saveQuest(quest: Quest, cwd: string): void {
	quest.updatedAt = Date.now();
	quest.tasks = quest.steps;
	quest.tasksSincePause = quest.stepsSincePause;
	quest.lastFiredTaskIndex = quest.lastFiredStepIndex;
	quest.sameTaskCount = quest.sameStepCount;
	quest.commits = quest.commits.map((commit) => ({
		...commit,
		taskIndex: commit.stepIndex,
	}));
	writeJSON(questActivePath(cwd), quest);
}

export function clearActiveQuest(cwd: string): void {
	rmSync(questActivePath(cwd), { force: true });
}

export function archiveQuest(quest: Quest, cwd: string): string | null {
	try {
		const archiveDir = questArchiveDir(cwd);
		const slug = quest.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
		const ts = quest.completedAt ?? Date.now();
		const path = join(archiveDir, `${ts}-${slug}.json`);
		writeJSON(path, quest);
		updateArchiveIndex(cwd, {
			path,
			name: quest.name,
			goal: quest.goal,
			completedAt: quest.completedAt ?? Date.now(),
			taskCount: quest.steps.length,
			doneCount: quest.steps.filter((t) => t.status === "done").length,
		});
		return path;
	} catch (e) {
		console.error("[pi-quest] archiveQuest:", e);
		return null;
	}
}

/** One row of the quest archive index: a finished quest summarised for history. */
interface QuestArchiveEntry {
	path: string;
	name: string;
	goal: string;
	completedAt: number | null;
	taskCount: number;
	doneCount: number;
}

/** Narrow one untrusted index row into a QuestArchiveEntry, or null if it has no path. */
function coerceQuestArchiveEntry(value: unknown): QuestArchiveEntry | null {
	const e = asRecord(value);
	if (typeof e.path !== "string") return null;
	return {
		path: e.path,
		name: strOr(e.name, "?"),
		goal: optStr(e.goal) ?? "",
		completedAt: optNum(e.completedAt) ?? null,
		taskCount: numOr(e.taskCount, 0),
		doneCount: numOr(e.doneCount, 0),
	};
}

function readQuestArchiveIndex(indexPath: string): QuestArchiveEntry[] {
	const raw = asRecord(readJSON<unknown>(indexPath, { version: 1, entries: [] }));
	return Array.isArray(raw.entries)
		? raw.entries.map(coerceQuestArchiveEntry).filter((e): e is QuestArchiveEntry => e !== null)
		: [];
}

const byCompletedAtDesc = (a: QuestArchiveEntry, b: QuestArchiveEntry): number =>
	(b.completedAt ?? 0) - (a.completedAt ?? 0);

function updateArchiveIndex(cwd: string, entry: QuestArchiveEntry): void {
	try {
		const indexPath = questArchiveIndexPath(cwd);
		const entries = readQuestArchiveIndex(indexPath).filter((e) => e.path !== entry.path);
		entries.push(entry);
		entries.sort(byCompletedAtDesc);
		writeJSON(indexPath, { version: 1, entries });
	} catch (e) {
		console.error("[pi-quest] updateArchiveIndex:", e); /* best-effort */
	}
}

export function rebuildArchiveIndex(cwd: string): void {
	try {
		const archiveDir = questArchiveDir(cwd);
		if (!existsSync(archiveDir)) return;
		const entries: QuestArchiveEntry[] = [];
		const files = readdirSync(archiveDir).filter(
			(f) => f.endsWith(".json") && f !== "archive-index.json",
		);
		for (const f of files) {
			try {
				const raw = asRecord(JSON.parse(readFileSync(join(archiveDir, f), "utf8")));
				const steps = Array.isArray(raw.steps)
					? raw.steps
					: Array.isArray(raw.tasks)
						? raw.tasks
						: [];
				entries.push({
					path: join(archiveDir, f),
					name: strOr(raw.name, f),
					goal: optStr(raw.goal) ?? "",
					completedAt: optNum(raw.completedAt) ?? null,
					taskCount: steps.length,
					doneCount: steps.filter((t) => asRecord(t).status === "done").length,
				});
			} catch (e) {
				console.error("[pi-quest] rebuildArchiveIndex/read:", e); /* skip corrupt */
			}
		}
		entries.sort(byCompletedAtDesc);
		writeJSON(questArchiveIndexPath(cwd), { version: 1, entries });
	} catch (e) {
		console.error("[pi-quest] rebuildArchiveIndex:", e); /* best-effort */
	}
}

export function listArchives(
	limit: number,
	cwd: string,
): {
	name: string;
	goal: string;
	steps: number;
	done: number;
	completedAt: number | null;
}[] {
	const toSummary = (e: QuestArchiveEntry) => ({
		name: e.name,
		goal: e.goal,
		steps: e.taskCount,
		done: e.doneCount,
		completedAt: e.completedAt,
	});
	try {
		const archiveDir = questArchiveDir(cwd);
		if (!existsSync(archiveDir)) return [];
		const indexPath = questArchiveIndexPath(cwd);
		// When a valid index exists, return it as-is (even if empty) — matching the
		// original: only a missing/malformed index triggers a rebuild from files.
		const rawIndex = asRecord(readJSON<unknown>(indexPath, null));
		if (Array.isArray(rawIndex.entries)) {
			return rawIndex.entries
				.map(coerceQuestArchiveEntry)
				.filter((e): e is QuestArchiveEntry => e !== null)
				.slice(0, limit)
				.map(toSummary);
		}
		rebuildArchiveIndex(cwd);
		return readQuestArchiveIndex(indexPath).slice(0, limit).map(toSummary);
	} catch (e) {
		console.error("[pi-quest] listArchives:", e);
		return [];
	}
}
