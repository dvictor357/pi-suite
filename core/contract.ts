/**
 * The cross-extension cohesion contract, expressed as code.
 *
 * pi-todo, pi-memory and pi-quest share state through a small set of on-disk
 * JSON shapes under `~/.pi/agent`. Historically each extension re-declared
 * these types and re-built these paths, so a change in one drifted silently
 * from the others. This module is the single source of truth: every extension
 * imports these types (and the path builders in ./paths) instead of
 * hand-rolling them.
 *
 * Bump `CONTRACT_VERSION` on any breaking change to a shape or path so
 * consumers can detect a mismatch instead of corrupting each other's files.
 */
export const CONTRACT_VERSION = 1;

/**
 * True if a persisted blob was written by a NEWER contract than this code
 * implements (its `contractVersion` exceeds {@link CONTRACT_VERSION}). Such a
 * file may use a shape this code would misread, so callers should refuse to use
 * or overwrite it rather than silently corrupt shared cross-extension state.
 * Files with no `contractVersion` (pre-versioning, or never stamped) are NOT
 * future — they are read and upgraded normally.
 */
export function isFutureContract(blob: { contractVersion?: number } | null | undefined): boolean {
	return (
		blob != null &&
		typeof blob.contractVersion === "number" &&
		blob.contractVersion > CONTRACT_VERSION
	);
}

// ── Session meta (status-bar / awareness handoff, written by all three) ──────

export type ExtensionKey = "memory" | "todo" | "quest";

export interface SessionMeta {
	/** Contract version this file was written with; see {@link CONTRACT_VERSION}. */
	contractVersion?: number;
	cwd?: string;
	cwdHash?: string;
	updatedAt?: number;
	/** Per-extension blob; each extension owns its own key. */
	extensions?: Partial<Record<ExtensionKey, Record<string, unknown>>>;
}

// ── pi-todo: ~/.pi/agent/tmp/todos/<cwdHash>.json ────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "delegated";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Sub-agent type to use when delegating this item. */
	agent?: string;
	/** Focused context / instructions for the sub-agent (keeps context lean). */
	context?: string;
	/** Brief summary of what the sub-agent did or returned. */
	result?: string;
	/** Producer marker for cross-extension sync (e.g. "quest"). */
	source?: string;
	/** External source id (e.g. quest name/id). */
	sourceId?: string;
	/** Source-local task index. */
	sourceIndex?: number;
	createdAt: number;
	completedAt: number | null;
}

export interface TodoList {
	cwd: string;
	title?: string;
	items: TodoItem[];
	version: 1;
}

// ── pi-memory: ~/.pi/agent/memory/projects/<cwdHash>.json ────────────────────

export interface MemoryFact {
	scope: "user" | "project" | "agent";
	category?: string;
	/** 0-10, higher = more important. */
	priority?: number;
	tags?: string[];
	text: string;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectMemory {
	/** Contract version this file was written with; see {@link CONTRACT_VERSION}. */
	contractVersion?: number;
	name: string;
	packageManager: string | null;
	language: string | null;
	framework: string | null;
	designSystem: string | null;
	buildTool: string | null;
	testRunner: string | null;
	linter: string | null;
	formatter: string | null;
	monorepo: boolean;
	directoryPattern: string | null;
	conventions: string[];
	facts: MemoryFact[];
	/** Epoch ms of the last tech-stack scan. */
	lastScanned: number;
	fingerprint?: Record<string, number>;

	// ── Fields below are written by pi-quest onto the memory file, not by
	// pi-memory's own detection. pi-memory does not produce them but MUST
	// preserve them across rescans (see extensions/memory/profile.ts) — this is
	// the resolution of MIGRATION.md drift #1: research stays a first-class,
	// preserved field rather than being folded into `facts`.

	/** Written by pi-quest's `quest_memory_save`. Keyed research findings. */
	research?: Record<string, ProjectResearchFinding>;
	/** Written by pi-quest when merging quest conventions back into memory. */
	lastModified?: number;
}

export interface ProjectResearchFinding {
	value: string;
	category?: string | null;
	timestamp: number;
}

/** pi-memory user-level profile (memory-internal, included here for single-source typing). */
export interface UserMemory {
	communication: string | null;
	commitStyle: string | null;
	indent: string | null;
	quotes: string | null;
	preferredPackageManager: string | null;
	errorHandling: string | null;
	shell: string | null;
	conventions: string[];
	facts: MemoryFact[];
	lastModified: number;
}
