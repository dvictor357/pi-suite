import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectMemoryPath, writeJSON } from "../../core";
import type { MemoryGraph } from "../../core";
import { buildStepContext } from "./context-broker";
import { compactAwarenessBlock } from "./todo-sync";
import {
	extractKeywords,
	renderGraphContextBlock,
	selectGraphNodesForPrompt,
} from "./memory-graph-read";

// Controlled experiment, not a model benchmark: relevance is labeled explicitly.
// Newer unrelated decisions crowd out the older worktree lesson in awareness.
const graph: MemoryGraph = {
	nodes: [
		...["Tabs", "Double quotes", "Semicolons", "Trailing commas", "ES modules"].map(
			(label, index) => ({
				id: `style-${index}`,
				kind: "design-decision" as const,
				label,
				detail: "Follow the existing project style.",
				createdAt: 100 + index,
				updatedAt: 100 + index,
			}),
		),
		{
			id: "worktree",
			kind: "knowledge",
			label: "Worktree isolation",
			detail: "Give parallel workers separate worktrees to prevent conflicting writes.",
			createdAt: 1,
			updatedAt: 1,
		},
	],
	edges: [],
};

test("compare awareness retrieval with task matching and ID deduplication", () => {
	const cases = [
		{
			name: "older relevant lesson",
			query: "Isolate parallel worktree workers",
			relevant: ["worktree"],
			prior: [],
		},
		{
			name: "already in step context",
			query: "Use ES modules",
			relevant: ["style-4"],
			prior: ["style-4"],
		},
		{ name: "unrelated query", query: "Configure OAuth authentication", relevant: [], prior: [] },
		{
			name: "paraphrase misses",
			query: "Avoid simultaneous agents overwriting changes",
			relevant: ["worktree"],
			prior: [],
		},
	];
	for (const maxNodes of [2, 5]) {
		for (const scenario of cases) {
			const baseline = selectGraphNodesForPrompt(graph, { maxNodes });
			const matched = selectGraphNodesForPrompt(graph, {
				maxNodes,
				keywords: extractKeywords(scenario.query),
			});
			// Prototype only: production step context currently retains text, not node IDs.
			const candidate = matched.filter((node) => !scenario.prior.includes(node.id));
			const prior = graph.nodes.filter((node) => scenario.prior.includes(node.id));
			const measure = (selected: typeof baseline) => {
				const ids = [...prior, ...selected].map((node) => node.id);
				return {
					chars:
						renderGraphContextBlock(prior, 10_000).length +
						renderGraphContextBlock(selected, 10_000).length,
					relevant: scenario.relevant.filter((id) => ids.includes(id)).length,
					irrelevant: ids.filter((id) => !scenario.relevant.includes(id)).length,
					duplicates: ids.length - new Set(ids).size,
				};
			};
			const before = measure(baseline);
			const after = measure(candidate);
			assert.ok(after.chars < before.chars);
			assert.equal(after.irrelevant, 0);
			assert.equal(after.duplicates, 0);
			if (scenario.name === "older relevant lesson") {
				assert.equal(before.relevant, 0);
				assert.equal(after.relevant, 1);
			}
			if (scenario.name === "already in step context") assert.equal(after.relevant, 1);
			if (scenario.name === "already in step context") assert.equal(before.duplicates, 1);
			if (scenario.name === "paraphrase misses") assert.equal(after.relevant, 0);
			console.log(
				JSON.stringify({ maxNodes, case: scenario.name, baseline: before, candidate: after }),
			);
		}
	}
});

test("final step prompt selects relevant lessons, deduplicates, and retains no-match fallback", () => {
	// The preload owns cleanup; no writes to the user's real project memory.
	const cwd = mkdtempSync(join(process.env.HOME ?? tmpdir(), "context-efficiency-"));
	writeJSON(projectMemoryPath(cwd), { name: "fixture", graph });
	const prompt = buildStepContext({
		role: "worker",
		content: "Isolate parallel worktree workers",
		cwd,
	});
	assert.match(prompt, /Worktree isolation/);
	assert.doesNotMatch(prompt, /\[design-decision\]/);
	const detail = graph.nodes.find((node) => node.id === "worktree")!.detail!;
	const context = `[Memory graph]\n- [knowledge] Worktree isolation: ${detail}`;
	const deduplicated = buildStepContext({
		role: "worker",
		content: "Isolate parallel worktree workers",
		context,
		cwd,
	});
	assert.equal(deduplicated.split("Worktree isolation").length - 1, 1);
	assert.doesNotMatch(deduplicated, /\[design-decision\]/);
	const fallback = buildStepContext({
		role: "worker",
		content: "Avoid simultaneous agents overwriting changes",
		cwd,
	});
	assert.match(fallback, /ES modules/);
	assert.match(compactAwarenessBlock(cwd), /ES modules/);
	// One incidental shared word ("parallel") must not displace recent awareness.
	const incidental = compactAwarenessBlock(cwd, undefined, {
		task: "Rename parallel config flag",
		existingContext: "",
	});
	assert.match(incidental, /ES modules/);
	// A single-keyword task can still match on its only keyword.
	const single = compactAwarenessBlock(cwd, undefined, { task: "worktrees", existingContext: "" });
	assert.match(single, /Worktree isolation/);
	assert.doesNotMatch(single, /\[design-decision\]/);
});
