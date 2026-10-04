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
	{
		id: "parallel-write-claims",
		commit: "e570c60",
		difficulty: "hard",
		testFiles: [
			"extensions/quest/write-claim.test.ts",
			"extensions/quest/parallel.test.ts",
			"extensions/quest/parallel-integration.test.ts",
		],
		prompt: `Parallel quest steps can silently overwrite each other's files.

When quest parallel mode is enabled (\`ParallelConfig.enabled\`), execution-role steps that
declare no write claim are still dispatched concurrently, so two workers can edit the same
file. Require write claims for parallel writers:

1. In extensions/quest/write-claim.ts export:
   - \`hasNonEmptyWriteClaim(writeClaim: string[] | undefined): boolean\`
   - \`missingParallelWriteClaimIndices(steps: ReadonlyArray<{ agent: string; writeClaim?: string[] }>): number[]\`
     — 0-based indices of execution-role steps whose writeClaim is missing or empty.
     Read-only roles (scout, verifier, reviewer, planner; see \`isReadOnlyRole\`) are exempt.
   - \`validateParallelWriteClaims(steps): string | null\` — null when valid; otherwise an
     error message containing "Parallel mode requires", the offending steps as 1-based
     "#N" labels (e.g. "#2, #3"), and a note that "Read-only roles" may omit writeClaim.
2. \`quest_plan\` rejects such a plan with that message when parallel mode is enabled.
3. As defense in depth, \`selectDispatchBatch\` (extensions/quest/parallel.ts) never dispatches
   an execution-role step without a non-empty write claim: it is reported in \`conflicts\` with
   \`blockedBy: -1\`. Read-only roles are still dispatched without claims.`,
	},
	{
		id: "sandbox-guard-bypass",
		commit: "6466fab",
		difficulty: "hard",
		testFiles: ["extensions/quest/sandbox-guard.test.ts", "extensions/quest/storage.test.ts"],
		prompt: `Close sandbox-guard bypasses and an archive-index write race in pi-quest.

\`evaluateToolCall(profile, toolName, args)\` in extensions/quest/sandbox-guard.ts decides
whether a sandboxed step's tool call is blocked. It has holes:

1. Chained shell commands bypass every check: "echo ok && rm -rf src" is allowed because only
   the whole string is classified. Split commands on &&, ||, ;, | and newlines and classify
   every segment, so destructive commands, network commands (when network is denied),
   package installs (when installs are denied) and \`denyCommands\` patterns are caught in any
   segment. Also inspect \`$(...)\` and backtick substitutions: "echo $(rm -rf src)" and
   "echo \`rm -rf src\`" must block. With \`allowCommands\` set, every segment must match an
   allowed prefix ("echo hi && echo there" passes with ["echo"]; "echo hi && curl x" blocks),
   and a destructive substitution still blocks even when the outer command is allowed.
2. Write tools (\`write\`, \`edit\`) called without a path must fail closed (block). Remove tool
   names that don't exist from the write-tool set.
3. Unknown tools that carry a \`path\` argument must be checked against denied paths, the
   built-in sensitive globs (e.g. .env), and \`allowedPaths\` when set. Unknown tools without a
   path are allowed. Non-write tools like \`read\` on a denied/sensitive path are blocked.

Separately, \`archiveQuest\` (extensions/quest/storage.ts) overwrites the archive index, so an
entry written by another process between our read and write is lost. Make the index update
read-merge-write (use the core \`updateJSON\` helper), keep existing entries, and deduplicate
entries by archive path so archiving the same quest twice leaves one entry. Apply the same
read-merge-write treatment to quest→todo syncing.`,
	},
	{
		id: "baseline-aware-gate",
		commit: "c3a16a3",
		difficulty: "hard",
		testFiles: ["extensions/quest/checks.test.ts", "extensions/quest/evidence.test.ts"],
		prompt: `The quest check gate fails steps for redness they inherited.

After a step, pi-quest runs the project's checks (extensions/quest/checks.ts) as a hard gate and
fails the step on any failing check, even one that already failed before the step started. A
correct fix then gets failed on an unrelated pre-existing typecheck error, and the orchestrator
burns its budget "fixing" unrelated code.

Make the gate baseline-aware:

1. \`CheckResult\` gains an optional \`preexisting?: boolean\`, set on a "fail" that also fails at
   the step's baseline commit.
2. Export a pure loop \`gateChecks(planned, run, runAtBaseline): CheckResult[]\` from checks.ts.
   \`run(check)\` returns the check's result; \`runAtBaseline(check)\` returns its result at the
   baseline, or null when there is no baseline answer. Run checks in order. A failure that also
   fails at baseline is tagged \`preexisting: true\` and the loop continues; any other failure is
   recorded and stops the loop. A null baseline answer keeps today's strict behaviour.
3. \`runChecks(planned, cwd, baselineSha = null)\` uses \`gateChecks\`. With a baseline sha, a
   failing check is re-run against a pristine export of that commit (not the working tree);
   cache baseline results per repo+sha+command. Add a \`VERIFICATION.baselineAware\` switch
   (default true) in extensions/quest/constants.ts. Pass the step's \`baselineSha\` from the
   \`quest_update\` gate.
4. \`firstFailure\` ignores pre-existing failures, and \`summarizeChecks\` prints them as
   "<kind>:preexisting" (e.g. "typecheck:preexisting test:pass").
5. \`renderEvidenceBlock\` (extensions/quest/evidence.ts) must not list pre-existing failures
   among the passing gated checks. Show them in their own section headed
   "Pre-existing failures", one line per check formatted like "- typecheck (\`npm run typecheck\`)",
   followed by each check's output summary, and tell the verifier to judge only whether the step
   made them worse and to "not ask it to fix unrelated code".`,
	},
	{
		id: "usage-telemetry",
		commit: "319b37a",
		difficulty: "hard",
		testFiles: [
			"extensions/quest/register-events.test.ts",
			"extensions/quest/tool-call-guard.test.ts",
		],
		prompt: `Quest eval entries never record what a sub-agent run cost.

\`makeEval\` (quest runtime) hardcodes \`tokensIn\`/\`tokensOut\` to 0. The \`subagent\` tool's result
already carries per-run usage in \`details.results[i].usage\` (\`{ input, output, cacheRead,
cacheWrite, cost, contextTokens, turns }\`) plus an optional \`details.results[i].thinking\`.
Attribute it to quest steps and record it on eval entries:

1. In extensions/quest/tool-call-guard.ts export
   \`resolveSubagentStepTargets(quest, input): (number | null)[]\`. It returns one entry per
   sub-agent task, index-aligned with \`input.tasks\` (or a one-element array for the single-agent
   form \`{ agent, task }\`). Use the same step-matching rules as \`resolveSubagentClaimTargets\`;
   a malformed entry (no agent) or an unmatched one (e.g. a read-only "scout" call) is \`null\`,
   and alignment must survive such entries.
2. In the events registered by \`registerEvents\`: on \`tool_execution_start\` for a \`subagent\`
   call, resolve its step targets by \`toolCallId\`; on \`tool_execution_end\`, add each result's
   usage to the matching step as \`step.usage\` (accumulate across runs, keep the reported
   thinking level) and persist the quest.
3. \`makeEval\` consumes \`step.usage\` exactly once: the entry gets \`tokensIn\` = input,
   \`tokensOut\` = output, and new optional \`EvalEntry\` fields (core/eval-logging.ts)
   \`cacheRead\`, \`cacheWrite\`, \`cost\`, \`contextTokens\`, \`turns\`, \`thinking\`. Then
   \`step.usage\` is cleared, so a second \`makeEval\` for the same step reports \`tokensIn: 0\` and
   no \`turns\`. The new fields are additive: no contract version bump.`,
	},
	{
		id: "thinking-routing",
		commit: "3de2b88",
		difficulty: "hard",
		testFiles: ["extensions/quest/register-events.test.ts"],
		prompt: `Quest retries after a quality failure rerun with exactly the same thinking level, and
the orchestrator can launch a step's sub-agent with any model or thinking it likes.

Route sub-agent runtime per step and enforce it:

1. \`FailureBrief\` (extensions/quest/ladder.ts) records an optional \`failureCode\`
   (core \`FailureCode\`), and \`buildFailureBrief\` accepts \`failureCode\` and stores it.
2. A step's routed runtime starts from the role's approved model/thinking in project memory
   (\`rememberAgentModel\` / \`agentModels\`). Each verified quality failure on the step since its
   last escalation (\`MODEL_QUALITY\`, \`CONTEXT_MISSING\`, \`BAD_PLAN\`, \`TEST_FAILURE\`, or a FAIL with
   no code) bumps thinking one level up \`THINKING_LEVELS\` (core), capped by a configurable
   maximum. Mechanical failures don't bump. Judge/exploration roles (scout, verifier, reviewer,
   planner) are never adjusted. Keep the knobs in a \`ROUTING\` block in
   extensions/quest/constants.ts, and use this one routing decision everywhere a step's sub-agent
   is launched (steering, batch steering, quest_delegate).
3. In the \`tool_call\` handler registered by \`registerEvents\`: when the orchestrator calls the
   \`subagent\` tool for the active quest step with a model or thinking that differs from the
   routed one, rewrite \`input.model\` / \`input.thinking\` in place (do not block the call) and
   notify with a message containing "Quest routing: step #<n> model <old> → <new>". Example:
   worker approved as model "approved-model" at "low", one \`MODEL_QUALITY\` failure, call made with
   model "something-else" and thinking "minimal" → rewritten to "approved-model" / "medium".`,
	},
];
