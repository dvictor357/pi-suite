import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryEdge } from "../../core";
import { upsertGraphEdge } from "./graph";

const edge = (from: string, to: string, label?: string): MemoryEdge => ({
	from,
	to,
	kind: "supports",
	label,
});

test("upsertGraphEdge adds, updates, and refreshes its index after external changes", () => {
	const edges: MemoryEdge[] = [];
	assert.equal(upsertGraphEdge(edges, edge("a", "b", "first")), "added");
	assert.equal(upsertGraphEdge(edges, edge("a", "b", "updated")), "updated");
	assert.equal(edges.length, 1);
	assert.equal(edges[0].label, "updated");

	edges.push(edge("b", "c", "external"));
	assert.equal(upsertGraphEdge(edges, edge("b", "c", "refreshed")), "updated");
	assert.equal(edges.length, 2);
	assert.equal(edges[1].label, "refreshed");
});
