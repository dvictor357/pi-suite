import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { GitIntegration, Quest } from "./types";
import {
	readJSON,
	writeJSON,
	updateJSON,
	projectMemoryPath,
	questActivePath,
	questArchiveDir,
	questArchiveIndexPath,
	CONTRACT_VERSION,
	isFutureContract,
} from "./utils";

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
): Quest {
	return {
		version: 1,
		name,
		goal,
		status: "planning",
		tasks: [],
		tasksSincePause: 0,
		lastFiredTaskIndex: -1,
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
		if (raw && raw.version === 1 && Array.isArray(raw.tasks)) {
			raw.tasks = raw.tasks.map((t: any) => ({
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
			}));
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
			if (typeof raw.tasksSincePause !== "number") raw.tasksSincePause = 0;
			if (typeof raw.lastFiredTaskIndex !== "number") raw.lastFiredTaskIndex = -1;
			if (typeof raw.sameTaskCount !== "number") raw.sameTaskCount = 0;
			return raw as Quest;
		}
	} catch (e) {
		console.error("[pi-quest] loadQuest:", e); /* corrupt */
	}
	return null;
}

export function saveQuest(quest: Quest, cwd: string): void {
	quest.updatedAt = Date.now();
	writeJSON(questActivePath(cwd), quest);
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
			taskCount: quest.tasks.length,
			doneCount: quest.tasks.filter((t) => t.status === "done").length,
		});
		return path;
	} catch (e) {
		console.error("[pi-quest] archiveQuest:", e);
		return null;
	}
}

function updateArchiveIndex(
	cwd: string,
	entry: {
		path: string;
		name: string;
		goal: string;
		completedAt: number;
		taskCount: number;
		doneCount: number;
	},
): void {
	try {
		const indexPath = questArchiveIndexPath(cwd);
		const index = readJSON<{ version: 1; entries: any[] }>(indexPath, {
			version: 1,
			entries: [],
		});
		index.entries = index.entries.filter((e: any) => e.path !== entry.path);
		index.entries.push(entry);
		index.entries.sort((a: any, b: any) => (b.completedAt || 0) - (a.completedAt || 0));
		writeJSON(indexPath, index);
	} catch (e) {
		console.error("[pi-quest] updateArchiveIndex:", e); /* best-effort */
	}
}

export function rebuildArchiveIndex(cwd: string): void {
	try {
		const archiveDir = questArchiveDir(cwd);
		if (!existsSync(archiveDir)) return;
		const entries: any[] = [];
		const files = readdirSync(archiveDir).filter(
			(f) => f.endsWith(".json") && f !== "archive-index.json",
		);
		for (const f of files) {
			try {
				const raw = JSON.parse(readFileSync(join(archiveDir, f), "utf8"));
				entries.push({
					path: join(archiveDir, f),
					name: raw.name || f,
					goal: raw.goal || "",
					completedAt: raw.completedAt || null,
					taskCount: Array.isArray(raw.tasks) ? raw.tasks.length : 0,
					doneCount: Array.isArray(raw.tasks)
						? raw.tasks.filter((t: any) => t.status === "done").length
						: 0,
				});
			} catch (e) {
				console.error("[pi-quest] rebuildArchiveIndex/read:", e); /* skip corrupt */
			}
		}
		entries.sort((a: any, b: any) => (b.completedAt || 0) - (a.completedAt || 0));
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
	tasks: number;
	done: number;
	completedAt: number | null;
}[] {
	try {
		const archiveDir = questArchiveDir(cwd);
		if (!existsSync(archiveDir)) return [];
		const indexPath = questArchiveIndexPath(cwd);
		const index = readJSON<{ version: 1; entries: any[] } | null>(indexPath, null);
		if (index && Array.isArray(index.entries)) {
			return index.entries.slice(0, limit).map((e: any) => ({
				name: e.name || "?",
				goal: e.goal || "",
				tasks: e.taskCount || 0,
				done: e.doneCount || 0,
				completedAt: e.completedAt || null,
			}));
		}
		rebuildArchiveIndex(cwd);
		const rebuilt = readJSON<{ version: 1; entries: any[] }>(indexPath, {
			version: 1,
			entries: [],
		});
		return rebuilt.entries.slice(0, limit).map((e: any) => ({
			name: e.name || "?",
			goal: e.goal || "",
			tasks: e.taskCount || 0,
			done: e.doneCount || 0,
			completedAt: e.completedAt || null,
		}));
	} catch (e) {
		console.error("[pi-quest] listArchives:", e);
		return [];
	}
}
