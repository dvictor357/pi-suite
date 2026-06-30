/**
 * Pure dependency-graph helpers for quest step lists. Steps reference their
 * dependencies by index; these functions take just `{ dependencies }[]` so they
 * stay testable in isolation.
 */

type DepNode = { dependencies: number[] };

/**
 * Return one cycle (as a list of step indices) if the dependency graph contains
 * one, else null. Standard colour-marking DFS (0=unvisited, 1=on-stack, 2=done).
 */
export function detectDependencyCycle(steps: DepNode[]): number[] | null {
	const n = steps.length;
	const state = new Array<number>(n).fill(0);
	const path: number[] = [];

	function dfs(i: number): number[] | null {
		if (i < 0 || i >= n) return null; // out-of-range dependency — ignore here
		if (state[i] === 1) {
			const cycleStart = path.indexOf(i);
			return path.slice(cycleStart).concat(i);
		}
		if (state[i] === 2) return null;
		state[i] = 1;
		path.push(i);
		for (const dep of steps[i]?.dependencies ?? []) {
			const result = dfs(dep);
			if (result) return result;
		}
		path.pop();
		state[i] = 2;
		return null;
	}

	for (let i = 0; i < n; i++) {
		const result = dfs(i);
		if (result) return result;
	}
	return null;
}

/**
 * Longest dependency chain length in the graph (0 for no dependencies).
 *
 * Memoised longest-path DFS. Memoisation is sound because a node's value
 * depends only on the node (not the traversal path): `memo[i]` is written only
 * after all of `i`'s dependencies are fully resolved. An on-stack guard makes
 * the function total even on cyclic input (a back-edge contributes 0 and is not
 * cached), though callers should reject cycles via {@link detectDependencyCycle}
 * first. The previous implementation keyed memo by node but computed it under a
 * mutable `visited` set, so a value cached during a cycle short-circuit could be
 * wrong — this version never caches a truncated result.
 */
export function getMaxDependencyDepth(steps: DepNode[]): number {
	const n = steps.length;
	const memo = new Array<number>(n).fill(-1);
	const onStack = new Array<boolean>(n).fill(false);

	function depth(i: number): number {
		if (i < 0 || i >= n) return 0; // out-of-range dependency
		if (onStack[i]) return 0; // back-edge (cycle): don't recurse or cache
		if (memo[i] !== -1) return memo[i];
		onStack[i] = true;
		let max = 0;
		for (const dep of steps[i]?.dependencies ?? []) {
			max = Math.max(max, 1 + depth(dep));
		}
		onStack[i] = false;
		memo[i] = max;
		return max;
	}

	let result = 0;
	for (let i = 0; i < n; i++) {
		result = Math.max(result, depth(i));
	}
	return result;
}
