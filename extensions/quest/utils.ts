import { join } from "node:path";
import { homedir } from "node:os";
import { cwdHash, readJSON, projectMemoryPath, isFutureContract } from "../../core";

/**
 * Read pi-memory's project file for awareness. Returns null if absent, or if it
 * was written by a newer contract than this code understands (don't misread a
 * shape we don't recognise).
 */
export function loadProjectMemory(cwd: string): Record<string, any> | null {
	const memory = readJSON<Record<string, any> | null>(projectMemoryPath(cwd), null);
	return isFutureContract(memory) ? null : memory;
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
