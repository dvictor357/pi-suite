import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { cwdHash, readJSON, writeJSON, writeSessionMeta, projectMemoryPath } from "../../core";
import { ERROR_LOG_PATH } from "./constants";

// Shared primitives now live in core. Re-export them so the rest of the quest
// extension can keep importing from "./utils" unchanged.
export { cwdHash, readJSON, writeJSON, writeSessionMeta, projectMemoryPath };

export function loadProjectMemory(cwd: string): Record<string, any> | null {
	return readJSON<Record<string, any> | null>(projectMemoryPath(cwd), null);
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export function logError(context: string, error: unknown): void {
	try {
		const line = `[${new Date().toISOString()}] ${context}: ${(error as Error)?.message || String(error)}\n`;
		appendFileSync(ERROR_LOG_PATH, line, "utf8");
	} catch {
		/* best-effort telemetry */
	}
}

// ── Quest paths (per-project scoping) ────────────────────────────────────────

export function questActivePath(cwd: string): string {
	return join(homedir(), ".pi", "agent", "quests", cwdHash(cwd), "active.json");
}

export function questArchiveDir(cwd: string): string {
	return join(homedir(), ".pi", "agent", "quests", cwdHash(cwd), "archive");
}

export function questArchiveIndexPath(cwd: string): string {
	return join(questArchiveDir(cwd), "archive-index.json");
}
