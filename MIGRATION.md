# Migration

How the three standalone repos move into `pi-suite`, and what each should adopt from
`core/`. This is the checklist for the per-repo review pass — nothing here is applied to
the original repos yet.

## Per-extension steps (same for all three)

1. Copy the extension's source into `extensions/<name>/`.
   - pi-quest is already modular (`extensions/quest/*.ts`) — copy the directory.
   - pi-todo and pi-memory are single files today (`todo.ts`, `memory.ts`). Land them as
     `extensions/<name>/index.ts`; split into modules opportunistically, not as a
     prerequisite.
2. Delete the locally-duplicated primitives and import them from `core` instead
   (see the symbol map below).
3. Replace local on-disk type declarations with the `core/contract` types.
4. Route I/O error logging through `setErrorSink` once at startup, instead of inline
   `console.error` scattered through helpers (optional, recommended).
5. `npm run typecheck` and `npm run format` from the repo root.

## Symbol map — replace local with `core`

| Local symbol (in each repo today)                         | Replace with (`core`)                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `cwdHash`                                                 | `import { cwdHash } from "../../core"`                                    |
| `readJSON` / `writeJSON`                                  | `import { readJSON, writeJSON } from "../../core"`                        |
| `AGENT_DIR`                                               | `import { AGENT_DIR } from "../../core"`                                  |
| `SESSION_META_PATH` + `writeSessionMeta`                  | `import { writeSessionMeta } from "../../core"`                           |
| pi-todo `TodoItem` / `TodoList`                           | `import type { TodoItem, TodoList } from "../../core"`                    |
| pi-quest `SyncedTodoItem` / `SyncedTodoList`              | same as above — these were a duplicate of pi-todo's shapes                |
| pi-quest `todoPath()`                                     | `import { todoListPath } from "../../core"`                               |
| pi-quest `projectMemoryPath()`                            | `import { projectMemoryPath } from "../../core"`                          |
| pi-memory `ProjectProfile` / `MemoryFact` / `UserProfile` | `import type { ProjectMemory, MemoryFact, UserMemory } from "../../core"` |

## Contract drift to resolve during review

These were real mismatches found while extracting the contract:

1. **`research` key. — RESOLVED.** pi-quest's `quest_memory_save` writes
   `memory.research[key] = { value, category, timestamp }` onto pi-memory's project file.
   Decision: `research` stays a **first-class, preserved optional field** on
   `ProjectMemory` (keeping its keyed-update semantics), rather than being folded into
   `facts`. pi-memory does not produce it but must not destroy it: `reconcileProfile`
   (`extensions/memory/profile.ts`) overlays only detected fields onto the stored profile,
   and `saveProject` read-merges the on-disk `research`/`lastModified` so a stale save
   can't clobber quest's newer data.
2. **`lastModified` vs `lastScanned`. — PARTIALLY RESOLVED.** Both are now preserved
   (no data loss): pi-memory owns `lastScanned` (last tech-stack scan); pi-quest writes
   `lastModified` and it survives rescans. Unifying them into one timestamp semantics is
   still open, but no longer causes data loss.
3. **`verifyOnComplete` default. — OPEN.** pi-quest's loader defaults a legacy quest
   missing this field to `false`, while `emptyQuest` and the docs default to `true`.
   Quest-internal; tracked as a Tier-2 fix, not yet applied.

Cross-extension on-disk shapes now carry a `contractVersion` (stamped on write, checked
on read via `isFutureContract`): a file written by a newer suite is not misread or
clobbered. See `core/contract.ts`.

## Task → Step rename — RESOLVED

Quest originally used `task` as its unit-of-work term (QuestTask, quest.tasks, taskIndex,
quest_task_detail, etc.). The canonical term is now `step`:

| Old (still accepted) | New (canonical)      |
| -------------------- | -------------------- |
| `QuestTask`          | `QuestStep`          |
| `TaskStatus`         | `StepStatus`         |
| `quest.tasks`        | `quest.steps`        |
| `commit.taskIndex`   | `commit.stepIndex`   |
| `quest_task_detail`  | `quest_step_detail`  |
| `taskIndex` (params) | `stepIndex` (params) |

**Compatibility policy:** Every old `task`-named entry point remains accepted forever.
The wire format carries both fields side-by-side (`quest.tasks` is written as a mirror of
`quest.steps` on every save), so older pi-quest releases can still read quest files.
`quest_task_detail` and `taskIndex` params continue to work; new `quest_step_detail` and
`stepIndex` params are preferred aliases. This rename does NOT bump `CONTRACT_VERSION` —
it is not a breaking storage change.

### What changed internally

- `extensions/quest/types.ts`: `QuestStep`, `StepStatus` are canonical; `QuestTask`,
  `TaskStatus` are `@deprecated` aliases.
- `Quest.steps` is canonical; `Quest.tasks` is a legacy mirror persisted on save.
- `commit.stepIndex` is canonical; `commit.taskIndex` is a legacy mirror.
- `quest.stepsSincePause`, `quest.lastFiredStepIndex`, `quest.sameStepCount` are
  canonical; their `task`-named counterparts are legacy mirrors.
- `extensions/quest/storage.ts`: `loadQuest` normalizes both `tasks` and `steps` into
  `steps` on read; `saveQuest` writes the `tasks` mirror back.

### Public API compatibility aliases added

- `quest_step_detail` tool — alias for `quest_task_detail`
- `stepIndex` parameter on `quest_commit` and `quest_assign_model` — alias for `taskIndex`

New code should use the `step`-named forms; old integrations continue to work unchanged.

## Verified escalation ladder — RESOLVED

Quest now supports an additive project-memory field, `ProjectMemory.modelLadder`, for a
user-approved ordered cheap→frontier model ladder. No `CONTRACT_VERSION` bump is required:
legacy readers ignore the field, and new readers treat absence as "no ladder".

Storage and preservation rules:

- `core/contract.ts` defines `ModelLadderConfig` (`rungs`, `roles?`, `approvedAt`,
  `reason?`) and `ProjectMemory.modelLadder?`.
- `extensions/quest/storage.ts` owns `loadModelLadder` / `rememberModelLadder` and uses
  read-merge-write with `isFutureContract` protection.
- `extensions/memory/profile.ts` preserves `modelLadder` in `withForeignFromDisk`, so a
  memory rescan cannot clobber a ladder approved during a quest.
- `QuestStep` gained additive ladder fields: `rung?`, `escalations?`, `failureBriefs?`,
  and `lastModel?`; legacy quest loads default them safely.

Operationally, `quest_assign_ladder` validates and approves the rung list once per project.
Ladder transitions never re-prompt, judge roles are excluded, and explicit step models
bypass the ladder.

## pi-minions delegation and thinking levels — RESOLVED

`AgentModelChoice` now has an additive optional `thinkingLevel` field. No
`CONTRACT_VERSION` bump is required: old readers ignore it and old entries without it keep
their previous default/tier-thinking behavior. `quest_assign_model` approves model and
thinking together, and unsandboxed Quest steering calls pi-minions' `subagent` tool with
the resolved model/thinking as per-invocation overrides.

The old `quest_delegate` entry point remains registered as a compatibility and security
fallback. Quest deliberately uses it for `restricted`/`isolated` steps because its guarded
in-process tool definitions enforce sandbox policy; pi-minions does not yet enforce that
policy in the child process.

## Order

Migrate **pi-memory** and **pi-todo** first (they are leaf producers of the shared
state), then **pi-quest** (the consumer that reads both). That way quest is rewired
against a contract its dependencies already satisfy.
