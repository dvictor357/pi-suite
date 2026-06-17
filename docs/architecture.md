# Architecture

## The problem this repo solves

pi-quest, pi-todo, and pi-memory were three independent repos that nonetheless formed
**one coupled system**:

- All three defined byte-identical `cwdHash(cwd)` = `sha256(cwd).slice(0,16)`.
- All three defined `writeSessionMeta(key: "memory" | "todo" | "quest", …)` — the union
  type itself proves they were designed to know about each other.
- They share on-disk JSON shapes (`TodoList`, the memory project profile, `SessionMeta`)
  that were **declared more than once** — pi-quest re-declared pi-todo's `TodoItem` as
  `SyncedTodoItem`, and hard-coded pi-memory's profile layout.

Because every cross-extension read is best-effort (`try/catch` → fallback), a drift
between the copies doesn't error — it corrupts silently. The fix is a single shared
contract module (`core/`) that all three import.

## Why one repo

We verified `pi`'s installer behavior directly from
`@earendil-works/pi-coding-agent/dist/core/package-manager.js`:

1. **`parseSource`** recognizes `npm:` (by package name + optional `@version`), `git:`
   (`host` + `path` + optional `@ref`), and local paths. **A `git:` source has no
   subdirectory component** — you cannot install one package from a subfolder of a git
   repo. A git install clones the whole repo and reads the **root** `package.json`.

2. **`resolveExtensionEntries`** reads the root manifest's `pi.extensions` **array** and
   resolves each entry relative to the repo root; if a listed entry is a directory, it is
   auto-discovered for an `index.ts`. So **one repo can expose many extensions.**

### The two viable approaches

| Approach                 | Shape                                                                         | Install                                     | Trade-off                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Single repo** (chosen) | One repo, `pi.extensions` lists all three; shared `core/` via relative import | `pi install git:…/pi-suite` loads all three | No npm publish needed; `pi config` toggles individual extensions off. Not independently installable.    |
| Published packages       | Monorepo publishing three npm packages that depend on a published `core`      | `pi install npm:@you/pi-quest`              | Independent install — but **requires npm publishing**, because `git:` cannot target a workspace subdir. |

The single-repo approach was chosen because:

- It keeps the existing `git:` distribution path (no publishing pipeline).
- `pi.extensions` is purpose-built for multiple extensions in one repo.
- The shared `core/` becomes plain relative imports — the cleanest possible extraction.
- `pi config` preserves per-extension enable/disable, softening the only real downside.

The published-packages approach remains available later: if independent install ever
becomes a hard requirement, publish each extension to npm with `core` as a dependency. It
does not need to gate the consolidation now.

## Module boundaries

```
core/  ──────────────► owned by no extension; imported by all three
  contract.ts            shared on-disk shapes + CONTRACT_VERSION
  paths.ts               AGENT_DIR, shared path builders
  hash.ts, fs.ts         primitives
  session-meta.ts        shared status handoff

extensions/quest/  ────► imports ../../core; keeps quest-private state local
extensions/todo/   ────► imports ../../core
extensions/memory/ ────► imports ../../core
```

The guiding rule: **`core` owns only what crosses an extension boundary.** Anything a
single extension touches alone stays in that extension.

## Roadmap alignment

This consolidation is the precondition for the loop-engineering roadmap (deterministic
verification gates, run-log observability, pluggable todo/memory backends): those all
hook the shared contract and a single transition chokepoint rather than three drifting
copies. See the per-extension docs once migrated.
