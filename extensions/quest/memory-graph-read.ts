/**
 * Budgeted memory-graph retrieval for quest awareness and planning.
 *
 * The project memory graph is write-heavy today (memory_graph + silent eval
 * mirrors). This module is the pure read path: select a small, ranked set of
 * non-eval nodes and render them under a character budget so constrained models
 * still get a clean block. No SDK, no I/O — callers load the graph from disk.
 */

import { clampToBudget, type MemoryGraph, type MemoryNode, type NodeKind } from "../../core";

/** Preferred node kinds for prompt injection, highest priority first. */
export const PREFERRED_PROMPT_KINDS: readonly NodeKind[] = [
	"design-decision",
	"knowledge",
	"loop-pattern",
	"sandbox-log",
	"artifact-set",
];

/** Default node cap for awareness blocks on large/ample-context models. */
export const DEFAULT_MAX_AWARENESS_NODES = 5;
/** Tighter node cap for small / low-context models. */
export const CONSTRAINED_MAX_AWARENESS_NODES = 2;
/** Max graph nodes attached to a single planned step context. */
export const DEFAULT_MAX_PLANNING_NODES_PER_STEP = 2;

const STOP_WORDS = new Set([
	"with",
	"from",
	"this",
	"that",
	"into",
	"task",
	"code",
	"file",
	"files",
	"test",
	"tests",
	"update",
	"implement",
	"create",
	"add",
	"use",
	"using",
	"when",
	"then",
	"should",
	"must",
	"context",
	"step",
	"quest",
	"the",
	"and",
	"for",
	"are",
	"was",
	"were",
	"will",
	"can",
	"not",
	"but",
	"all",
	"any",
	"via",
	"per",
]);

export interface SelectGraphNodesOpts {
	/** Max nodes to return after ranking. Default 5. */
	maxNodes?: number;
	/**
	 * Exclude `eval-result` nodes from the candidate pool. Default true —
	 * eval dumps are write-side telemetry and should not flood prompts.
	 */
	excludeEvalResults?: boolean;
	/**
	 * When `excludeEvalResults` is false, keep only the newest K eval-result
	 * nodes among candidates. Default 0 (still drop them).
	 */
	maxEvalResults?: number;
	/** Preferred kinds (higher priority). Defaults to PREFERRED_PROMPT_KINDS. */
	preferredKinds?: readonly NodeKind[];
	/**
	 * Optional keywords for overlap scoring (planning path). When set, nodes
	 * need at least `minKeywordHits` hits in label/detail/id to be selected,
	 * and ranking prefers higher overlap.
	 */
	keywords?: readonly string[];
	/** Min keyword hits when keywords are provided. Default 1. */
	minKeywordHits?: number;
}

export interface GraphEnrichmentResult<T extends { content: string; context: string }> {
	enrichedSteps: T[];
	/** How many steps had graph nodes appended. */
	attachedCount: number;
	/** One-line summary for tool output. */
	summary: string;
}

/**
 * Extract normalized keyword tokens from free text for graph overlap scoring.
 * Drops short tokens and common filler words.
 */
export function extractKeywords(text: string): string[] {
	if (!text?.trim()) return [];
	return [
		...new Set(
			text
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
				.split(/[^A-Za-z0-9]+/)
				.map((t) => t.toLowerCase())
				.filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
		),
	];
}

/** Count how many keywords appear in a node's searchable text. */
export function keywordOverlapScore(node: MemoryNode, keywords: readonly string[]): number {
	if (!keywords.length) return 0;
	const hay = `${node.id} ${node.kind} ${node.label} ${node.detail ?? ""}`.toLowerCase();
	let hits = 0;
	for (const kw of keywords) {
		if (kw && hay.includes(kw)) hits++;
	}
	return hits;
}

function kindRank(kind: NodeKind, preferred: readonly NodeKind[]): number {
	const idx = preferred.indexOf(kind);
	if (idx >= 0) return idx;
	// Unknown / deprioritized kinds sort after preferred; eval last.
	if (kind === "eval-result") return preferred.length + 10;
	return preferred.length + 1;
}

function nodeTime(node: MemoryNode): number {
	return typeof node.updatedAt === "number"
		? node.updatedAt
		: typeof node.createdAt === "number"
			? node.createdAt
			: 0;
}

/**
 * Select a budgeted set of memory-graph nodes for prompt injection.
 *
 * - Excludes `eval-result` by default (or keeps only last K when included).
 * - Prefers design-decision, knowledge, loop-pattern, sandbox-log, artifact-set.
 * - Newest-first within kind priority.
 * - Optional keyword overlap for planning enrichment.
 */
export function selectGraphNodesForPrompt(
	graph: MemoryGraph | null | undefined,
	opts: SelectGraphNodesOpts = {},
): MemoryNode[] {
	const nodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
	if (!nodes.length) return [];

	const maxNodes = Math.max(0, opts.maxNodes ?? DEFAULT_MAX_AWARENESS_NODES);
	if (maxNodes === 0) return [];

	const excludeEval = opts.excludeEvalResults !== false;
	const maxEval = Math.max(0, opts.maxEvalResults ?? 0);
	const preferred = opts.preferredKinds ?? PREFERRED_PROMPT_KINDS;
	const keywords = opts.keywords?.filter(Boolean) ?? [];
	const minHits = Math.max(1, opts.minKeywordHits ?? 1);

	let candidates = nodes.filter((n) => n && typeof n.id === "string" && n.kind && n.label);

	if (excludeEval) {
		candidates = candidates.filter((n) => n.kind !== "eval-result");
	} else if (maxEval === 0) {
		candidates = candidates.filter((n) => n.kind !== "eval-result");
	} else {
		// Keep non-eval + newest maxEval eval-result nodes only.
		const evals = candidates
			.filter((n) => n.kind === "eval-result")
			.sort((a, b) => nodeTime(b) - nodeTime(a))
			.slice(0, maxEval);
		const evalIds = new Set(evals.map((n) => n.id));
		candidates = candidates.filter((n) => n.kind !== "eval-result" || evalIds.has(n.id));
	}

	if (keywords.length) {
		const scored = candidates
			.map((n) => ({ node: n, score: keywordOverlapScore(n, keywords) }))
			.filter((s) => s.score >= minHits);
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const kr = kindRank(a.node.kind, preferred) - kindRank(b.node.kind, preferred);
			if (kr !== 0) return kr;
			return nodeTime(b.node) - nodeTime(a.node);
		});
		return scored.slice(0, maxNodes).map((s) => s.node);
	}

	// Awareness path: preferred kinds first, then newest.
	const sorted = [...candidates].sort((a, b) => {
		const kr = kindRank(a.kind, preferred) - kindRank(b.kind, preferred);
		if (kr !== 0) return kr;
		return nodeTime(b) - nodeTime(a);
	});
	return sorted.slice(0, maxNodes);
}

/**
 * Render selected nodes as a line-oriented block, clamped with structure-safe
 * trimming (`clampToBudget` — whole lines, never mid-line cuts).
 */
export function renderGraphContextBlock(nodes: readonly MemoryNode[], budgetChars: number): string {
	if (!nodes.length || budgetChars <= 0) return "";

	const lines = ["Graph:"];
	for (const n of nodes) {
		const detailRaw = n.detail?.trim() ?? "";
		const detail = detailRaw.length > 80 ? `${detailRaw.slice(0, 77)}…` : detailRaw;
		const line = detail ? `- [${n.kind}] ${n.label}: ${detail}` : `- [${n.kind}] ${n.label}`;
		lines.push(line);
	}
	return clampToBudget(lines.join("\n"), budgetChars);
}

/**
 * Attach 1–2 keyword-overlapping graph nodes to each step's context for
 * `quest_plan`. Pure: no I/O. Skips steps already enriched with `[Memory graph]`.
 */
export function enrichStepsWithMemoryGraph<T extends { content: string; context: string }>(
	steps: T[],
	graph: MemoryGraph | null | undefined,
	goal: string,
	opts?: { maxNodesPerStep?: number },
): GraphEnrichmentResult<T> {
	const maxPer = Math.max(0, opts?.maxNodesPerStep ?? DEFAULT_MAX_PLANNING_NODES_PER_STEP);
	if (!steps.length || maxPer === 0 || !graph?.nodes?.length) {
		return {
			enrichedSteps: steps,
			attachedCount: 0,
			summary: "Memory graph: no nodes attached.",
		};
	}

	let attachedCount = 0;
	const enrichedSteps = steps.map((step) => {
		if (step.context.includes("[Memory graph]")) return step;
		const keywords = extractKeywords(`${step.content}\n${step.context}\n${goal}`);
		if (!keywords.length) return step;

		const selected = selectGraphNodesForPrompt(graph, {
			maxNodes: maxPer,
			excludeEvalResults: true,
			keywords,
			minKeywordHits: 1,
		});
		if (!selected.length) return step;

		const block = formatPlanningGraphBlock(selected);
		attachedCount++;
		return { ...step, context: `${step.context}\n\n${block}` };
	});

	return {
		enrichedSteps,
		attachedCount,
		summary: `Memory graph: attached nodes to ${attachedCount}/${steps.length} step contexts.`,
	};
}

function formatPlanningGraphBlock(nodes: readonly MemoryNode[]): string {
	const lines = ["[Memory graph]"];
	for (const n of nodes) {
		const detailRaw = n.detail?.trim() ?? "";
		const detail = detailRaw.length > 100 ? `${detailRaw.slice(0, 97)}…` : detailRaw;
		lines.push(detail ? `- [${n.kind}] ${n.label}: ${detail}` : `- [${n.kind}] ${n.label}`);
	}
	return lines.join("\n");
}
