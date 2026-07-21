import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryGraph, MemoryNode, NodeKind } from "../../core";
import {
	CONSTRAINED_MAX_AWARENESS_NODES,
	DEFAULT_MAX_AWARENESS_NODES,
	DEFAULT_MAX_PLANNING_NODES_PER_STEP,
	enrichStepsWithMemoryGraph,
	extractKeywords,
	keywordOverlapScore,
	renderGraphContextBlock,
	selectGraphNodesForPrompt,
} from "./memory-graph-read";

function node(id: string, kind: NodeKind, label: string, t: number, detail?: string): MemoryNode {
	return {
		id,
		kind,
		label,
		detail,
		createdAt: t,
		updatedAt: t,
	};
}

/** Fixture graph with mixed kinds for selection/ranking tests. */
function fixtureGraph(): MemoryGraph {
	return {
		nodes: [
			node("eval-old", "eval-result", "Old eval fail", 100, "worker failed on lint"),
			node("eval-new", "eval-result", "New eval pass", 500, "worker passed"),
			node(
				"dd-tabs",
				"design-decision",
				"Use tabs for TypeScript",
				200,
				"Project convention: tabs, double quotes",
			),
			node(
				"know-graph",
				"knowledge",
				"Memory graph is additive",
				300,
				"Stored on ProjectMemory.graph; preserved across rescans",
			),
			node(
				"loop-retry",
				"loop-pattern",
				"Retry verification three times",
				250,
				"Bounded verify retries before escalate",
			),
			node(
				"sandbox-wt",
				"sandbox-log",
				"Worktree isolation for parallel",
				350,
				"Each parallel step gets its own worktree",
			),
			node(
				"art-diff",
				"artifact-set",
				"Diff evidence bundle",
				400,
				"changedFiles + checks for verifier",
			),
			node("know-old", "knowledge", "Legacy note about auth", 50, "OAuth tokens live in env"),
		],
		edges: [
			{ from: "dd-tabs", to: "know-graph", kind: "supports" },
			{ from: "loop-retry", to: "eval-new", kind: "produced" },
		],
	};
}

describe("extractKeywords", () => {
	test("tokenizes and drops stop words / short tokens", () => {
		const kws = extractKeywords("Implement sandbox worktree isolation for parallel steps");
		assert.ok(kws.includes("sandbox"));
		assert.ok(kws.includes("worktree"));
		assert.ok(kws.includes("isolation"));
		assert.ok(kws.includes("parallel"));
		assert.ok(!kws.includes("for"));
		assert.ok(!kws.includes("the"));
	});

	test("empty / whitespace → empty", () => {
		assert.deepEqual(extractKeywords(""), []);
		assert.deepEqual(extractKeywords("   "), []);
	});
});

describe("keywordOverlapScore", () => {
	test("counts hits in label, detail, id", () => {
		const n = node("sandbox-wt", "sandbox-log", "Worktree isolation", 1, "parallel steps");
		assert.equal(keywordOverlapScore(n, ["sandbox", "worktree", "parallel"]), 3);
		assert.equal(keywordOverlapScore(n, ["oauth"]), 0);
	});
});

describe("selectGraphNodesForPrompt", () => {
	test("empty / missing graph → []", () => {
		assert.deepEqual(selectGraphNodesForPrompt(null), []);
		assert.deepEqual(selectGraphNodesForPrompt(undefined), []);
		assert.deepEqual(selectGraphNodesForPrompt({ nodes: [], edges: [] }), []);
	});

	test("excludes eval-result by default", () => {
		const selected = selectGraphNodesForPrompt(fixtureGraph(), { maxNodes: 20 });
		assert.ok(selected.every((n) => n.kind !== "eval-result"));
		assert.ok(selected.some((n) => n.id === "dd-tabs"));
		assert.ok(selected.some((n) => n.id === "know-graph"));
	});

	test("can keep last K eval-result when not excluded", () => {
		const selected = selectGraphNodesForPrompt(fixtureGraph(), {
			maxNodes: 20,
			excludeEvalResults: false,
			maxEvalResults: 1,
		});
		const evals = selected.filter((n) => n.kind === "eval-result");
		assert.equal(evals.length, 1);
		assert.equal(evals[0].id, "eval-new");
	});

	test("preferred kinds first, then newest within priority", () => {
		// design-decision and knowledge beat loop/sandbox/artifact; among
		// knowledge nodes, newest (know-graph @300) before know-old @50.
		const selected = selectGraphNodesForPrompt(fixtureGraph(), { maxNodes: 3 });
		assert.equal(selected.length, 3);
		assert.equal(selected[0].kind, "design-decision");
		assert.equal(selected[0].id, "dd-tabs");
		assert.equal(selected[1].kind, "knowledge");
		assert.equal(selected[1].id, "know-graph");
		// Third: remaining knowledge (know-old) ranks above loop-pattern
		assert.equal(selected[2].id, "know-old");
	});

	test("respects maxNodes (awareness defaults)", () => {
		const full = selectGraphNodesForPrompt(fixtureGraph(), {
			maxNodes: DEFAULT_MAX_AWARENESS_NODES,
		});
		const tight = selectGraphNodesForPrompt(fixtureGraph(), {
			maxNodes: CONSTRAINED_MAX_AWARENESS_NODES,
		});
		assert.equal(full.length, DEFAULT_MAX_AWARENESS_NODES);
		assert.equal(tight.length, CONSTRAINED_MAX_AWARENESS_NODES);
	});

	test("keyword overlap ranks matching nodes for planning", () => {
		const kws = extractKeywords("sandbox worktree isolation for parallel branches");
		const selected = selectGraphNodesForPrompt(fixtureGraph(), {
			maxNodes: DEFAULT_MAX_PLANNING_NODES_PER_STEP,
			keywords: kws,
		});
		assert.ok(selected.length >= 1);
		assert.equal(selected[0].id, "sandbox-wt");
		// No eval-result even if keywords might match "worker" in eval detail
		assert.ok(selected.every((n) => n.kind !== "eval-result"));
	});

	test("keyword path returns [] when nothing overlaps", () => {
		const selected = selectGraphNodesForPrompt(fixtureGraph(), {
			maxNodes: 5,
			keywords: ["quantum", "entanglement", "foobar"],
		});
		assert.deepEqual(selected, []);
	});
});

describe("renderGraphContextBlock", () => {
	test("empty nodes or zero budget → empty string", () => {
		assert.equal(renderGraphContextBlock([], 500), "");
		assert.equal(renderGraphContextBlock([node("a", "knowledge", "A", 1)], 0), "");
	});

	test("renders kind + label (+ truncated detail)", () => {
		const long = "x".repeat(120);
		const block = renderGraphContextBlock(
			[
				node("dd", "design-decision", "Tabs", 1, "use tabs"),
				node("k", "knowledge", "Long", 2, long),
			],
			2000,
		);
		assert.match(block, /^Graph:/);
		assert.match(block, /\[design-decision\] Tabs: use tabs/);
		assert.match(block, /\[knowledge\] Long: x{77}…/);
	});

	test("line-safe clamp never exceeds budget", () => {
		const nodes = fixtureGraph().nodes.filter((n) => n.kind !== "eval-result");
		const budget = 120;
		const block = renderGraphContextBlock(nodes, budget);
		assert.ok(block.length <= budget);
		// Should keep header and at least start of content, or hard-cut with marker
		assert.ok(block.includes("Graph:") || block.endsWith("…"));
	});

	test("clamp drops whole trailing lines (structure-safe)", () => {
		const nodes = [
			node("a", "knowledge", "Alpha", 3, "detail a"),
			node("b", "knowledge", "Bravo", 2, "detail b"),
			node("c", "knowledge", "Charlie", 1, "detail c"),
		];
		const full = renderGraphContextBlock(nodes, 10_000);
		const lines = full.split("\n");
		// Budget that fits header + first data line only
		const headerAndOne = lines[0].length + 1 + lines[1].length + 2; // + marker room
		const clamped = renderGraphContextBlock(nodes, headerAndOne + 5);
		assert.ok(clamped.length <= headerAndOne + 5);
		assert.ok(clamped.includes("Alpha"));
		// Charlie (last) should be dropped when budget is tight
		if (clamped.includes("…")) {
			assert.ok(!clamped.includes("Charlie") || clamped.indexOf("Charlie") < 0);
		}
	});
});

describe("enrichStepsWithMemoryGraph", () => {
	test("attaches 1–2 overlapping nodes to matching steps", () => {
		const steps = [
			{
				content: "Isolate parallel sandbox worktrees",
				context: "Each step needs its own worktree under sandbox isolation.",
			},
			{
				content: "Unrelated step",
				// Goal keywords are folded into every step; keep this free of graph terms.
				context: "Do something with quantum foobar widgets.",
			},
		];
		// Neutral goal — no graph keyword hits — so only step 0 matches via its own text.
		const result = enrichStepsWithMemoryGraph(steps, fixtureGraph(), "Ship the release");
		assert.equal(result.attachedCount, 1);
		assert.match(result.enrichedSteps[0].context, /\[Memory graph\]/);
		assert.match(result.enrichedSteps[0].context, /sandbox-log|Worktree/);
		assert.ok(!result.enrichedSteps[1].context.includes("[Memory graph]"));
		assert.match(result.summary, /1\/2/);
	});

	test("idempotent: skips already-enriched steps", () => {
		const steps = [
			{
				content: "sandbox worktree",
				context: "do it\n\n[Memory graph]\n- already there",
			},
		];
		const result = enrichStepsWithMemoryGraph(steps, fixtureGraph(), "sandbox");
		assert.equal(result.attachedCount, 0);
		assert.equal(result.enrichedSteps[0].context, steps[0].context);
	});

	test("no graph / empty → identity", () => {
		const steps = [{ content: "a", context: "b" }];
		const r1 = enrichStepsWithMemoryGraph(steps, null, "goal");
		const r2 = enrichStepsWithMemoryGraph(steps, { nodes: [], edges: [] }, "goal");
		assert.equal(r1.enrichedSteps, steps);
		assert.equal(r2.enrichedSteps, steps);
		assert.equal(r1.attachedCount, 0);
	});

	test("respects maxNodesPerStep", () => {
		const steps = [
			{
				content: "verification retry loop pattern and design decision tabs",
				context: "Need retry verification three times and use tabs for TypeScript conventions.",
			},
		];
		const result = enrichStepsWithMemoryGraph(steps, fixtureGraph(), "verify tabs", {
			maxNodesPerStep: 1,
		});
		assert.equal(result.attachedCount, 1);
		const matches = result.enrichedSteps[0].context.match(/^- \[/gm) ?? [];
		assert.equal(matches.length, 1);
	});
});
