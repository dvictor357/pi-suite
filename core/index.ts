/**
 * @pi-suite/core — the shared cross-extension contract for the pi-suite
 * extensions (pi-quest, pi-todo, pi-memory).
 *
 * Extensions import from here instead of re-declaring storage shapes, paths, or
 * helpers. This is the only module all three depend on; see ./contract for the
 * versioned on-disk contract and core/README.md for the rationale.
 */
export { CONTRACT_VERSION } from "./contract";
export type {
	ExtensionKey,
	SessionMeta,
	TodoStatus,
	TodoItem,
	TodoList,
	MemoryFact,
	ProjectMemory,
	ProjectResearchFinding,
	UserMemory,
} from "./contract";

export { cwdHash } from "./hash";
export { readJSON, writeJSON, appendLine, setErrorSink } from "./fs";
export { AGENT_DIR, SESSION_META_PATH, todoListPath, projectMemoryPath } from "./paths";
export { readSessionMeta, writeSessionMeta } from "./session-meta";
