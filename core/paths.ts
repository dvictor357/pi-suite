import { homedir } from "node:os";
import { join } from "node:path";
import { cwdHash } from "./hash";

/** Root of pi's per-agent state. Everything pi-suite persists lives under here. */
export const AGENT_DIR = join(homedir(), ".pi", "agent");

/** Shared cross-extension session metadata (status-bar / awareness handoff). */
export const SESSION_META_PATH = join(AGENT_DIR, "session-meta.json");

// ── Cross-extension storage locations ────────────────────────────────────────
// Each path below is OWNED by one extension but READ by others, so the builder
// lives in core as the single source of truth. An owner may keep additional
// private paths in its own module; only the shared ones belong here.

/** pi-todo's per-project todo list. Owned by pi-todo; read by pi-quest to sync tasks. */
export function todoListPath(cwd: string): string {
	return join(AGENT_DIR, "tmp", "todos", `${cwdHash(cwd)}.json`);
}

/** pi-memory's per-project profile. Owned by pi-memory; read by pi-quest for awareness. */
export function projectMemoryPath(cwd: string): string {
	return join(AGENT_DIR, "memory", "projects", `${cwdHash(cwd)}.json`);
}
