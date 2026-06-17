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

## Order

Migrate **pi-memory** and **pi-todo** first (they are leaf producers of the shared
state), then **pi-quest** (the consumer that reads both). That way quest is rewired
against a contract its dependencies already satisfy.
