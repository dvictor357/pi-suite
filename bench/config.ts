/**
 * Benchmark knobs. Everything tunable lives here, not in the runner.
 */
import type { BenchArm } from "./types";

export const BENCH = {
	/** Trials per (task, arm, model). 3 is the floor for seeing variance. */
	trials: 3,
	/** Default model for every arm (and every sub-agent tier, unless --real-tiers). */
	model: "openai-codex/gpt-6.1-sol",
	thinking: "low",
	/**
	 * Providers the bench must never touch: refused up front, and their
	 * credentials are never copied into a sandbox. deepseek is prepaid credit.
	 */
	blockedProviders: ["deepseek"] as readonly string[],
	/** Safety margin on top of `agentTimeoutMs` an OAuth token must stay valid for before each run. */
	oauthMarginMs: 5 * 60_000,
	/** Wall-clock cap on one agent run. */
	agentTimeoutMs: 15 * 60_000,
	/** Wall-clock cap on grading one run's hidden tests. */
	gradeTimeoutMs: 3 * 60_000,
	/** Runs executed at once. Each run is a full agent process plus sub-agents. */
	concurrency: 2,
	/** A harness error matching this stops the batch: retrying only burns the remaining jobs. */
	stopOnProviderError: /usage limit|rate limit|quota|insufficient (balance|credit)/i,
	/** Confidence level for Wilson intervals in reports. */
	z: 1.96,
} as const;

export const ARMS: readonly BenchArm[] = [
	{
		id: "plain",
		description: "pi with no extensions: one agent, built-in tools only",
		suite: false,
	},
	{
		id: "suite",
		description: "pi with pi-suite loaded (memory, todo, quest, pi-minions sub-agents)",
		suite: true,
	},
	{
		id: "quest",
		description: "pi-suite with the work run as a pi-quest (plan, delegate, verify)",
		suite: true,
		// Neutral on how the quest runs: naming "delegate" here once biased the
		// orchestrator toward heavier tiers. Runs before 2026-10-04 used that wording.
		promptPrefix: [
			"Run this task as a pi-quest: create it with quest_create, plan it with quest_plan,",
			"and let the quest run until it completes. Do not stop before the quest is done.",
			"",
		].join("\n"),
	},
];

/** Suffix every task prompt gets, so arms share the same completion contract. */
export const PROMPT_FOOTER = [
	"",
	"Work in the current repository. Implement the change in source code and add or",
	"update tests as you see fit. Do not commit. When you are done, reply with a",
	"one-paragraph summary of what you changed.",
].join("\n");
