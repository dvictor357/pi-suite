/**
 * quest/context-broker.ts — composable context builder for sub-agent prompts.
 *
 * Before this module, quest built "awareness" blocks in at least five places:
 *   - compactAwarenessBlock() in todo-sync.ts (quest_create response)
 *   - buildSteeringMessage() in steering.ts (auto-pilot prompt)
 *   - Inline codebase strings in quest_update (verification/impact)
 *   - FORMAT_DIRECTIVE appended everywhere
 *   - Ad-hoc memory reads scattered in index.ts
 *
 * This module centralises those reads into one function that returns a
 * budget-bound block for the specific call-site, so changing what context
 * flows into a sub-agent (or reducing prompt bloat) is a single edit.
 *
 * Design:
 *   - Each data source (memory, todo, codebase, format) is a PLUGGABLE slot.
 *     By default we use the disk-based readers quest already has. A test can
 *     inject overrides so we don't need file-system mocks.
 *   - Output is clamped to `budget` characters (default 1200).
 *   - `mode` selects which slots to include (planning includes codebase;
 *     completion omits it).
 */
import { basename } from "node:path";
import type { ProjectMemory, TodoList } from "../../core";
import { FORMAT_DIRECTIVE, LADDER } from "./constants";
import { renderFailureBriefs, type FailureBrief } from "./ladder";
import { loadProjectMemory } from "./utils";
import { todoPath } from "./todo-sync";
import { readJSON, clampToBudget } from "../../core";
import { loadCodebaseIndex, codebaseStatusSummary, type CodebaseLoadResult } from "./codebase";

// ── Slots ────────────────────────────────────────────────────────────────────

export interface ContextSource {
	/** Human-friendly label shown in the output. */
	label: string;
	/** Produce zero or more lines of context. Empty array → skip this slot. */
	render: (cwd: string) => string[];
}

/**
 * Memory slot: project name, tech stack, conventions, quest research.
 */
export function memorySlot(memory?: ProjectMemory | null): ContextSource {
	return {
		label: "Memory",
		render: (cwd) => {
			const mem = memory ?? loadProjectMemory(cwd);
			const lines: string[] = [];
			const name = mem?.name ?? basename(cwd);
			const tech = [mem?.language, mem?.framework, mem?.packageManager].filter(Boolean).join(" • ");
			lines.push(`${name}${tech ? ` (${tech})` : ""}`);

			const conventions = Array.isArray(mem?.conventions) ? mem.conventions.slice(0, 5) : [];
			if (conventions.length) {
				lines.push(
					`Conventions: ${conventions.join("; ")}${(mem?.conventions?.length ?? 0) > conventions.length ? "…" : ""}`,
				);
			}

			const research = mem?.research as
				| Record<string, { value: string; category?: string; timestamp: number }>
				| undefined;
			if (research) {
				const entries = Object.entries(research)
					.sort(([, a], [, b]) => b.timestamp - a.timestamp)
					.slice(0, 3);
				for (const [k, v] of entries) {
					const cat = v.category ? `[${v.category}] ` : "";
					const val = v.value.length > 80 ? v.value.slice(0, 77) + "…" : v.value;
					lines.push(`Research ${k}: ${cat}${val}`);
				}
			}
			return lines;
		},
	};
}

/**
 * Todo slot: completed/total, active, delegated counts.
 */
export function todoSlot(todo?: TodoList | null): ContextSource {
	return {
		label: "Todo",
		render: (cwd) => {
			const list = todo ?? readJSON<TodoList | null>(todoPath(cwd), null);
			const items = Array.isArray(list?.items) ? list.items : [];
			if (items.length === 0) return [];
			const completed = items.filter((i) => i.status === "completed").length;
			const active = items.filter((i) => i.status === "in_progress").length;
			const delegated = items.filter((i) => i.status === "delegated").length;
			return [
				`${completed}/${items.length} done${active ? ` · ${active} active` : ""}${delegated ? ` · ${delegated} delegated` : ""}`,
			];
		},
	};
}

/**
 * Codebase slot: cache status summary + planning-relevant stats.
 */
export function codebaseSlot(
	mode: "planning" | "verification" | "completion",
	cache?: CodebaseLoadResult,
): ContextSource {
	return {
		label: "Codebase",
		render: (cwd) => {
			if (mode === "completion") return []; // no codebase context on completion
			const result = cache ?? loadCodebaseIndex(cwd);
			if (result.status === "ok") {
				if (mode === "planning") {
					return [
						`Cache ready: ${result.index.fileCount} files, scanned ${new Date(result.index.scannedAt).toISOString()}. Use codebase(query) and codebase(map) for file-level context.`,
					];
				}
				// verification: brief status only
				return [`${result.index.fileCount} indexed files.`];
			}
			return [codebaseStatusSummary(result)];
		},
	};
}

/**
 * Format directive slot: the language-agnostic code-hygiene reminder.
 */
export function formatSlot(mode: "planning" | "verification" | "completion"): ContextSource {
	return {
		label: "Format",
		render: () => {
			if (mode === "completion") return [FORMAT_DIRECTIVE];
			// planning/verification get a shorter nudge
			return ["Respect the project's existing formatting conventions."];
		},
	};
}

/**
 * Failure slot: distilled prior verified failures for the step being retried.
 * Only rendered when briefs exist, so it costs nothing on first attempts.
 */
export function failureSlot(briefs: readonly FailureBrief[] | undefined): ContextSource {
	return {
		label: "Prior failures",
		render: () => {
			const block = renderFailureBriefs(briefs, LADDER.briefBudget, LADDER.maxBriefs);
			return block ? block.split("\n") : [];
		},
	};
}

// ── Builder ──────────────────────────────────────────────────────────────────

export type ContextMode = "planning" | "verification" | "completion";

export interface ContextBuildOptions {
	/** Max total chars for the output block. Default 1200. */
	budget?: number;
	/** Override specific slots (for testing, or injecting mock data). */
	slots?: {
		memory?: ContextSource;
		todo?: ContextSource;
		codebase?: ContextSource;
		format?: ContextSource;
		/** Included only when provided — see {@link failureSlot}. */
		failure?: ContextSource;
	};
}

/**
 * Build a compact awareness block for a sub-agent prompt.
 *
 * @param cwd  Project working directory.
 * @param mode Which call-site is requesting context; selects relevant slots.
 * @param opts Optional budget / slot overrides.
 */
export function buildContext(
	cwd: string,
	mode: ContextMode = "planning",
	opts: ContextBuildOptions = {},
): string {
	const budget = opts.budget ?? 1200;
	const sources: ContextSource[] = [
		opts.slots?.memory ?? memorySlot(),
		opts.slots?.todo ?? todoSlot(),
		opts.slots?.codebase ?? codebaseSlot(mode),
		...(opts.slots?.failure ? [opts.slots.failure] : []),
		opts.slots?.format ?? formatSlot(mode),
	];

	const lines: string[] = [`## Project Awareness`];

	for (const src of sources) {
		const rendered = src.render(cwd);
		if (rendered.length === 0) continue;
		lines.push(``, `**${src.label}:** ${rendered[0]}`);
		for (let i = 1; i < rendered.length; i++) {
			lines.push(`  ${rendered[i]}`);
		}
	}

	// Structure-safe trim to budget: drop whole trailing lines rather than
	// cutting one in half (shared with the live awareness/memory paths).
	return clampToBudget(lines.join("\n"), budget);
}
