# pi-suite reliability and efficiency review

Reviewed 2026-10-06. Priorities: reliable autonomous completion and lower cost per
completed task. This is a focused review of orchestration, execution, persistence,
acceptance, and existing benchmark evidence, not an exhaustive security audit or
a comparison against other pi packages.

## Recommendation

Keep Quest and Minions as the planning/execution pair; Todo, Memory, and Agent
support that workflow. The next investment should make completion trustworthy and
prove when orchestration earns its overhead. The repo already has most of the
mechanisms needed: tiers, deterministic checks, acceptance, model ladders, usage
logging, and a benchmark harness. Tune and connect those before adding features.

## Current evidence

- Typecheck and formatting pass. The full isolated test suite passes: 1,025 Node
  tests and 254 Vitest tests, including the regression added during this review.
- Running tests inside the restricted environment failed the detached-grandchild
  cleanup test because process discovery was unavailable. Running with process
  access passed. That failure did not justify changing the implementation.
- The loader integration test loads all five extensions and checks unique tool
  names. Other integration tests cover shared model assignments, scanner output,
  future-contract handling, and the isolated SDK fallback.
- Existing benchmarks are useful but measure older revisions and tasks from this
  repository. They are evidence about those runs, not proof of current performance
  or general superiority.

| Saved benchmark                                    | Observed outcome                                                                                  | Implication                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bench/results/2026-10-04T05-05-27-218Z/report.md` | Suite and quest both passed 10/10; cost per pass was $0.0818 and $0.1824 respectively             | Quest added about 2.2 times the cost without improving this sample's pass rate                   |
| `bench/results/2026-10-04T06-35-34-905Z/report.md` | Plain passed 3/6; quest passed 6/6; cost per pass was $0.1949 and $0.4234; quest had two timeouts | More promising on harder tasks, but passing code and autonomous completion need separate metrics |
| `bench/results/2026-10-04T13-47-23-539Z/report.md` | A later dirty quest revision passed 5/6 at $0.4317 per pass                                       | Small samples and changing revisions do not establish a stable improvement                       |

The confidence intervals overlap in the paired plain/quest report. Run a matched
comparison on a fixed revision before claiming a reliable advantage.

## Findings and improvement order

### 1. Fixed: stale acceptance checks could restore an aborted quest

In `extensions/quest/register-events.ts`, `applyAcceptanceCheck` awaited commands,
detected that the current quest had changed, then persisted the old quest anyway.
That could restore an aborted quest or overwrite a replacement, including its
cache and shared status/todo handoffs.

The fix returns before persistence when the quest object no longer owns the
runtime. A paused current quest still retains its evidence. A regression exercises
both abort and replacement while a command is running: it failed before the fix
and passes after it. The existing pause test also passes.

### 2. Next: require successful persistence before announcing durable success

`core/fs.ts` deliberately makes `writeJSON` best-effort unless `throwOnError` is
requested. `saveQuest` and `archiveQuest` in `extensions/quest/storage.ts` do not
request it. Consequently, a failed archive write can still return a path, after
which completion/abort callers may remove the active file. `persist` can also
update UI and shared handoffs despite a failed active-state write.

This is a code-path risk identified by inspection; disk-failure reproduction was
not performed in this review. Use the existing strict-write option for authoritative
quest state and handle failure before clearing it. Keep telemetry best-effort.
Check: force an archive publication failure and assert that active quest state
survives and the user receives a failure rather than a success report.

### 3. Measure autonomous completion independently of code correctness

`bench/stats.ts` counts `grade.passed` regardless of `timedOut`. That correctly
measures hidden-test correctness, but it cannot alone measure autonomous delivery.
The saved 6/6 quest report also records two timeouts.

Keep that correctness metric and add completion without timeout, interventions,
cost per autonomous success, and time to completion. Count failed-run spend in
the denominator, as the current cost-per-pass implementation already does.
Check: a timed-out run with passing hidden tests remains a correctness pass but
does not count as an autonomous success.

### 4. Match execution overhead to task size

`extensions/quest/tiering.ts` already supports inline simple/medium work;
`extensions/quest/loadout.ts` already hides run-only tools outside live quests.
Preserve those mechanisms. Benchmark them before adding another scheduler or
routing abstraction.

Compare plain, suite, and quest on matched small and hard tasks. Record the chosen
tier and separate parent, worker, and verifier spend. Use delegation where isolation,
parallel work, or a fresh context produces a measurable benefit. Do not change
legacy complex-tier behavior silently.

### 5. Bound spend across the whole quest

Minions' `RunBudget` caps a single call, shared across its workers. Quest already
attributes worker usage to steps, but there is no equivalent quest-wide cap in
the inspected quest creation/types. Repeated calls and corrective rounds can
therefore outlive an individual call's budget.

Start with a cumulative worker-spend limit that pauses before another dispatch
and passes the remaining allowance into Minions. Label its coverage accurately:
parent and verifier spend also need accounting before calling it a total quest
budget. Provider usage arrives after work is billed, so a dollar cap is a stopping
threshold with possible overshoot, not a guaranteed prepaid limit.

### 6. Make the strength of acceptance evidence explicit

`createAcceptance` permits criteria without commands; `decideAcceptance` passes
an empty evidence list. The recap already warns when commands are absent. This is
reasonable for qualitative work, but it is weaker than proving a coding goal.

Distinguish reviewed criteria from machine-verified outcomes in status and metrics.
For checkable coding work, encourage targeted behavior checks declared before
execution. Keep qualitative goals usable; do not invent meaningless commands just
to satisfy a required field. A command already green at baseline is useful evidence
but does not demonstrate that the requested change was implemented.

## Suggested delivery sequence

1. Persistence failure handling and its regression, followed by lifecycle tests
   for pause/abort/replacement during asynchronous verification.
2. Autonomous completion metrics in the existing benchmark report.
3. Matched benchmarks on a fixed revision, including tasks outside pi-suite,
   interrupted runs, and multi-step dependency work.
4. Tune existing tiers/context/routing against those results; add cumulative
   worker-budget enforcement if repeated dispatch is a material cost source.

The release bar should include no lost state under tested failures, no stale work
after cancellation, explicit evidence for completion, and measured cost per
autonomous success. Unit-test count alone does not establish those properties.

## Progress

Branch `fix/quest-durable-state` (2026-10-07):

- Finding 1 committed, plus the same guard after every auto-pilot dialog (failed
  steps, stall, verification, burst checkpoint), with pause/abort/replace tests.
- Finding 2 fixed: `saveQuest`/`archiveQuest` write strictly; a failed archive keeps
  the active quest, `persist` alerts and skips shared handoffs, and `quest_abort` /
  `/quest cancel` report the failure instead of success.
- Finding 3 fixed: the bench report adds autonomous successes, cost per autonomous
  success, and median autonomous time. The saved paired report re-rendered shows
  quest at 4/6 autonomous and $0.6351 per autonomous success.
- Finding 4 instrumentation: the bench records the final quest tier and splits spend
  into parent and sub-agent roles. Re-deriving the saved transcripts shows the
  orchestrator dominates quest spend, and the verifier is the largest sub-agent cost.
