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

These are real mismatches found while extracting the contract — decide the fix during
the review rather than carrying the drift forward:

1. **`research` key.** pi-quest's `quest_memory_save` writes `memory.research[key] =
{ value, category, timestamp }` onto pi-memory's project file, but pi-memory's
   `ProjectProfile` has no `research` field — it stores knowledge as `facts: MemoryFact[]`.
   Decide: should quest research become `MemoryFact`s (scope `project`), or should
   pi-memory adopt `research` as a first-class field? `core` currently types it as an
   optional field on `ProjectMemory` and flags it.
2. **`lastModified` vs `lastScanned`.** pi-quest writes `lastModified` when merging
   conventions; pi-memory tracks `lastScanned`. Pick one timestamp semantics.
3. **`verifyOnComplete` default.** pi-quest's loader defaults a legacy quest missing this
   field to `false`, while `emptyQuest` and the docs default to `true`. (Quest-internal,
   noted for completeness.)

## Order

Migrate **pi-memory** and **pi-todo** first (they are leaf producers of the shared
state), then **pi-quest** (the consumer that reads both). That way quest is rewired
against a contract its dependencies already satisfy.
