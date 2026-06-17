# core — the cross-extension contract

`core/` is the single module that pi-quest, pi-todo, and pi-memory all depend on. It
exists because the three extensions share state on disk under `~/.pi/agent`, and before
this module each one re-declared the shapes and re-built the paths by hand — so a change
in one drifted silently from the others (every read is best-effort, so mismatches
corrupt quietly rather than erroring).

Everything here is **pure Node** (no `pi` host imports), so it typechecks strictly and
could be unit-tested in isolation.

## What it owns

| File              | Responsibility                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`     | The versioned on-disk shapes: `SessionMeta`, `TodoList`/`TodoItem`, `ProjectMemory`/`MemoryFact`/`UserMemory`. Plus `CONTRACT_VERSION`.         |
| `paths.ts`        | `AGENT_DIR`, `SESSION_META_PATH`, and the shared path builders `todoListPath` / `projectMemoryPath`.                                            |
| `hash.ts`         | `cwdHash(cwd)` — the per-project scoping key. **Must be identical across all extensions.**                                                      |
| `fs.ts`           | `readJSON` / `writeJSON` / `appendLine`, plus an optional `setErrorSink` so extensions can route I/O errors to their own logs.                  |
| `session-meta.ts` | `readSessionMeta` / `writeSessionMeta(key, cwd, data)` — merges one extension's status blob into the shared file without clobbering the others. |
| `index.ts`        | The public surface. Import from `@pi-suite/core` semantics via the relative path `../../core`.                                                  |

## Ownership rule

A path or shape belongs in `core` only if **more than one extension touches it**. An
extension's private state (e.g. pi-quest's `active.json`, pi-todo's archive index) stays
in that extension's own module. When in doubt: if removing it from `core` would only
affect one extension, it doesn't belong here.

## Versioning

Bump `CONTRACT_VERSION` whenever you make a breaking change to a shape or a shared path.
Consumers can compare it to detect a mismatch instead of writing data the other side
can't read.

## Known drift to reconcile

`ProjectMemory` documents two fields (`research`, `lastModified`) that pi-quest writes
onto pi-memory's project file but which pi-memory's own profile does not declare. These
are flagged in `contract.ts` and tracked in [../MIGRATION.md](../MIGRATION.md) — resolve
them during the per-repo review rather than perpetuating the drift.
