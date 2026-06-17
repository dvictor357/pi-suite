import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDependencyCycle, getMaxDependencyDepth } from "./graph";

const deps = (...d: number[][]) => d.map((dependencies) => ({ dependencies }));

test("detectDependencyCycle returns null for an acyclic graph", () => {
	assert.equal(detectDependencyCycle(deps([], [0], [1])), null); // chain 2→1→0
	assert.equal(detectDependencyCycle(deps([], [0], [0], [1, 2])), null); // diamond
});

test("detectDependencyCycle finds a cycle", () => {
	const cycle = detectDependencyCycle(deps([1], [0])); // 0→1→0
	assert.ok(cycle && cycle.length >= 2, "a 2-node cycle is reported");
});

test("getMaxDependencyDepth: no dependencies → 0", () => {
	assert.equal(getMaxDependencyDepth(deps([], [], [])), 0);
});

test("getMaxDependencyDepth: chain length", () => {
	// 2 depends on 1 depends on 0 → longest chain is 2 edges deep
	assert.equal(getMaxDependencyDepth(deps([], [0], [1])), 2);
});

test("getMaxDependencyDepth: diamond shares a sub-chain (memo soundness)", () => {
	// 3 → {1,2}, 1 → 0, 2 → 0. Longest path 3→1→0 (or 3→2→0) = depth 2.
	assert.equal(getMaxDependencyDepth(deps([], [0], [0], [1, 2])), 2);
});

test("getMaxDependencyDepth is total (no hang/throw) on a cyclic graph", () => {
	// Cycles are rejected upstream; for cyclic input the exact value is
	// implementation-defined — the contract is that it terminates and stays
	// bounded (the old memo-under-mutable-visited could cache a wrong value).
	const d = getMaxDependencyDepth(deps([1], [0]));
	assert.ok(Number.isFinite(d) && d >= 0 && d <= 2, `bounded finite depth, got ${d}`);
});

test("getMaxDependencyDepth ignores out-of-range dependency indices", () => {
	assert.equal(getMaxDependencyDepth(deps([5])), 1); // dep 5 doesn't exist → contributes 0
});
