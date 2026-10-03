/**
 * Golden tasks: real pi-suite commits replayed from their parent.
 *
 * Each prompt is written like an issue: it states the problem and any
 * interface the hidden tests import (module, export name, observable format),
 * but not the implementation. Every task is checked by `bench validate`: its
 * tests must fail on the parent and pass on the commit.
 */
import type { BenchTask } from "./types";

export const TASKS: readonly BenchTask[] = [
	{
		id: "awareness-min-hits",
		commit: "56a9774",
		difficulty: "easy",
		testFiles: ["extensions/quest/context-efficiency.test.ts"],
		prompt: `Step awareness in pi-quest is too eager to switch to keyword matches.

\`compactAwarenessBlock\` (extensions/quest/todo-sync.ts) normally shows recent memory-graph
nodes, but switches to nodes matching the step's task keywords as soon as any node shares a
single keyword with the task. One incidental word (e.g. "parallel" in "Rename parallel config
flag") can therefore push recent design decisions out of the block in favour of one unrelated
node.

Require a minimum number of keyword hits before switching to task matches. Export the
threshold as \`AWARENESS_MIN_KEYWORD_HITS = 2\` from extensions/quest/memory-graph-read.ts.
Cap it at the number of keywords the task actually has, so a one-keyword task (e.g.
"worktrees") can still match on its only keyword.`,
	},
	{
		id: "activity-block-text",
		commit: "34d5286",
		difficulty: "easy",
		testFiles: ["extensions/quest/activity-panel.test.ts"],
		prompt: `The quest activity panel shows "[object Object]" as a sub-agent run's progress line.

\`ActivityTracker.onUpdate\` (extensions/quest/activity-panel.ts) stringifies the update's
content directly. For subagent runs the partial result arrives in pi's standard tool-result
block shape, so the current activity renders as "[object Object]".

Extract readable text from all of these shapes when setting \`currentActivity\`:
- \`{ content: [{ type: "text", text: "..." }], details: {} }\` (array of text blocks)
- \`{ content: { type: "text", text: "Edited src/app.ts" } }\` (single block object) — the
  activity must be exactly that text
- \`{ type: "text", text: "wrote tests" }\` (a bare text block) — exactly that text

Plain string content must keep working.`,
	},
	{
		id: "todo-merge-preserve",
		commit: "dc501ec",
		difficulty: "medium",
		testFiles: ["extensions/todo/index.test.ts"],
		prompt: `\`todo_write\` drops delegation metadata when an item is resubmitted.

\`todo_write\` replaces the whole list. When the model flips a delegated item to "completed"
without re-passing agent/context/result, those fields are lost; quest-synced metadata can be
lost the same way.

Extract the merge step into a pure module extensions/todo/merge.ts exporting
\`mergeTodoItems(next: readonly TodoItem[], previous: readonly TodoItem[]): TodoItem[]\` and use
it from \`todo_write\`. Items are matched by \`content\`. Required behaviour:
- Any of agent, context, result, source, sourceId, sourceIndex, level that is undefined on the
  resubmitted item falls back to the previous item's value; explicit values win.
- createdAt is kept from the previous item; brand-new items get the current time.
- completedAt is stamped when an item becomes "completed", not re-stamped if it was already
  completed, and reset to null when the item is not completed.`,
	},
	{
		id: "user-prompt-bits",
		commit: "260382b",
		difficulty: "easy",
		testFiles: ["extensions/memory/user-bits.test.ts"],
		prompt: `pi-memory silently drops some user preferences from the injected prompt.

The "You:" section of the memory prompt block only renders for some preference fields: a user
whose only preference is \`communication\` gets nothing injected, and \`shell\` and
\`preferredPackageManager\` are stored but never shown.

Add a pure helper in extensions/memory/user-bits.ts:
\`buildUserPromptBits(user: UserMemory): string[]\`, returning one string per set preference, in
this order and format:
- commitStyle → "<commitStyle> commits" (e.g. "conventional commits")
- indent → as-is
- quotes → "<quotes> quotes"
- errorHandling → as-is
- communication → as-is
- shell → "shell: <shell>"
- preferredPackageManager → "package manager: <manager>"
Null or empty values produce no entry; an empty user yields []. Use it in the memory
extension so the "You:" section renders whenever at least one bit exists.`,
	},
	{
		id: "stale-quest-archive",
		commit: "498a1f7",
		difficulty: "medium",
		testFiles: ["extensions/quest/storage.test.ts"],
		prompt: `Finished quests linger as the active quest.

If the active quest file on disk is already finished — quest status "done", or every step is
"done" or "skipped" — \`loadQuest(cwd)\` in extensions/quest/storage.ts still returns it as the
active quest.

Make \`loadQuest\` archive such a quest (it must show up in \`listArchives\`), remove the active
quest file, and return null. Make the other completion paths (command, delegate, and
agent_end handlers) rely on \`archiveQuest\` for archiving and active-file cleanup so all paths
behave the same.`,
	},
	{
		id: "thinking-stats",
		commit: "be16fa3",
		difficulty: "medium",
		testFiles: ["core/eval-stats.test.ts"],
		prompt: `Break eval stats down by (agent, thinking level).

Routing now bumps sub-agent thinking levels, and we need to see whether that buys passes. In
core/eval-stats.ts:

1. Export \`computeThinkingStats(entries: unknown[]): RoleThinkingStats[]\`. Each row has
   \`agent\`, \`thinking\`, \`samples\`, \`verifiedPasses\`, \`passRate\` and optional \`usage\` — the
   same counters and usage/cost-per-verified-pass semantics as the existing per-(agent, model)
   stats from \`computeEvalStats\`, including which statuses count. Rows with no recorded
   thinking level are excluded. Rows without tracked usage carry no \`usage\`. Sort by agent,
   then thinking level in \`THINKING_LEVELS\` order (core/contract.ts).
2. Give \`formatEvalStatsReport\` an optional third parameter with these rows. When non-empty,
   add a section headed \`## Role / Thinking (<n> pairs)\` with table columns
   \`| Agent | Thinking | Samples | Verified Pass % | Cost / Verified Pass |\`, formatting the
   percentage and cost cells the same way the existing role/model table does. Omit the section
   when there are no rows.
3. Export the new function/type from core/index.ts and show the table in quest_eval_stats.`,
	},
	{
		id: "verify-prose",
		commit: "1e3ffc8",
		difficulty: "medium",
		testFiles: ["extensions/quest/verifier.test.ts"],
		prompt: `Make verifier-verdict parsing robust to how small models actually write.

\`parseVerifyOutcome(text)\` in extensions/quest/verifier.ts returns "pass", "fail" or
"inconclusive". Small models state their verdict in decorated or buried prose and it comes
back inconclusive. It must recognise:
- markdown/emoji decoration around a leading verdict: "**PASS** — ...", "## FAIL\\n...",
  "\`PASSED\`", "- FAILED: missing tests", "✅ PASS, ...", "❌ FAIL, ..."
- a labelled verdict anywhere: "Verdict: PASS", "Result — FAIL", "Outcome: passed all checks"
- a bare verdict on the final line: "Checked the diff.\\nRan lint and tests.\\nPASS"
It must NOT read prose that merely mentions passing or failing as a verdict, e.g. "Make sure
the tests do not fail before shipping." or "This could pass review later, but I'm not sure
yet." stay "inconclusive". Existing behaviour must keep working.

Also, in \`quest_update\`, when a step is awaiting verification and no explicit verifyOutcome is
given, infer the outcome from the result text with this parser.`,
	},
	{
		id: "failure-briefs",
		commit: "baf8ba7",
		difficulty: "hard",
		testFiles: ["extensions/quest/delegate.test.ts", "extensions/quest/ladder.test.ts"],
		prompt: `Retries should start from what went wrong.

When a quest step fails verification and is retried, the sub-agent prompt doesn't clearly tell
it what failed before. Add a failure-brief block to sub-agent prompts:

1. \`buildSubAgentPrompt\` (extensions/quest/delegate.ts) accepts an optional
   \`failureBriefBlock?: string\`. When it is non-blank, include it (trimmed) after the
   dependency-results section ("Prior results you can build on") and before the format
   directive. A blank or whitespace-only block is omitted entirely.
2. Export \`briefBudgetForModel(model: BudgetModelInfo | undefined, cfg: LadderConfig): number\`
   from extensions/quest/ladder.ts: \`cfg.briefBudget\` scaled down for small/low-context models
   by the same factor the awareness budget uses (\`budgetForModel(model)\` relative to
   \`CONTEXT_BUDGET.awarenessBudget\`, core/context-budget.ts), never scaled above the configured
   budget, rounded to an integer. Large models get exactly \`cfg.briefBudget\`.
3. Wire it up: on a verification FAIL, render the step's failure briefs within that budget and
   pass them into the retry's sub-agent prompt and the orchestrator steering block.`,
	},
];
