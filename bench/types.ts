/**
 * Shared shapes for the offline benchmark harness.
 *
 * A bench task replays a real commit: the agent starts from the commit's
 * parent, gets a written task statement, and is graded by the commit's own
 * test files (hidden until grading). Results are one JSONL row per run.
 */

/** One golden task: a replayed commit graded by its own tests. */
export interface BenchTask {
	/** Stable id, used for filtering and in reports. */
	id: string;
	/** Commit whose tests grade the run; the agent starts from `${commit}^`. */
	commit: string;
	/** Rough difficulty, for slicing reports. */
	difficulty: "easy" | "medium" | "hard";
	/** Task statement shown to the agent. States required interfaces, not the solution. */
	prompt: string;
	/** Repo-relative test files from `commit`, injected after the agent finishes. */
	testFiles: string[];
}

/** One configuration under test. */
export interface BenchArm {
	/** Short id used on the CLI and in reports (e.g. "plain", "suite"). */
	id: string;
	/** What this arm isolates. */
	description: string;
	/** Load the pi-suite extensions into the agent (and its sub-agents). */
	suite: boolean;
	/** Instruction prepended to every task prompt (e.g. "run this as a quest"). */
	promptPrefix?: string;
}

/** Token/cost usage summed over the main agent and any sub-agents. */
export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Main-agent assistant turns. */
	turns: number;
	/** Sub-agent runs observed through `subagent` tool results. */
	subagentRuns: number;
	/** Portion of `cost` spent inside sub-agents. */
	subagentCost: number;
	/** Tool calls by name, main agent only. */
	toolCalls: Record<string, number>;
}

/** Hidden-test grading outcome. */
export interface GradeResult {
	/** Every graded test passed and the runner exited 0. */
	passed: boolean;
	/** Individual test counts parsed from TAP; null when unparseable. */
	testsPassed: number | null;
	testsFailed: number | null;
	/** Grader exit code (null on timeout/kill). */
	exitCode: number | null;
}

/** One benchmark run: (task, arm, model, trial). */
export interface BenchResult {
	runId: string;
	taskId: string;
	arm: string;
	model: string;
	thinking: string;
	/** pi-suite commit the agent loaded (suite arms only). */
	suiteRev?: string;
	trial: number;
	/** Agent process exit code (null when killed by the timeout). */
	agentExitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	usage: RunUsage;
	grade: GradeResult;
	/** Files the agent changed vs the base snapshot (hidden tests excluded). */
	changedFiles: string[];
	/** Set when the harness itself failed (workspace, spawn) — not an agent failure. */
	harnessError?: string;
	timestamp: number;
}
