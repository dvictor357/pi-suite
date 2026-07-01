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

## Codebase intelligence ownership split

`pi-minions` owns the reusable codebase intelligence primitive. It scans repositories,
writes the project-local cache at `.pi/codebase-index.json`, implements cache staleness
rules, provides query/map/impact functions, and registers the `codebase` tool.

`pi-suite` does **not** import `pi-minions` code and has no runtime dependency on it.
`pi-quest` consumes the integration contract only:

- During quest creation/planning it detects `.pi/codebase-index.json` and tells the
  orchestrator to run `codebase(operation="scan")`, then `query`/`map`, when that tool is
  available.
- During `quest_plan`, it reads compatible cache contractVersion `1` directly as a
  fallback and enriches step contexts with relevant files plus dependency/reverse
  dependency context.
- During verification handoff, it prompts the verifier to run
  `codebase(operation="impact", file=...)` for changed files and includes direct cache
  impact fallback when the cache is present and compatible.
- Future cache contracts (`contractVersion > 1`) are ignored gracefully rather than
  reinterpreted.

This keeps scanner/cache/query/tool ownership in `pi-minions` while letting `pi-quest`
use the stable cache/tool contract for orchestration decisions.

### Retrieval ranking (read-side, owned by pi-quest)

How `pi-quest` _ranks_ the cache it reads is its own concern (the cache shape stays
`pi-minions`'). The ranker (`extensions/quest/codebase.ts`) scores files with **BM25 over a
field-weighted token bag** built from the same read-only fields (path, name, symbols,
exports, imports): token-boundary matching (so `app` no longer matches `mapper`), idf
weighting (a term in every file stops counting as much as a rare, discriminating one),
combined multi-term evidence, an exact-identifier bonus, and optional 1-hop
dependency-graph expansion of the top hits. The corpus is memoized per index object so a
whole planning pass builds it once. All knobs live in `CODEBASE_RANKING` (`constants.ts`)
and can be overridden per query.

**Tuning.** Defaults were grid-searched against pi-suite's own 45-file index using
task-like prose queries (deliberately not naming the target file) mapped to their true home
file. Full length-normalisation (`b=1`) plus higher tf saturation (`k1=1.6`), with reduced
field/exact boosts, roughly **doubled recall@1 (0.30 → 0.60)** and lifted **MRR (0.57 →
0.73)** versus the untuned starting point — mainly by stopping large files from dominating
on raw token count and letting idf discriminate. The residual misses are the inherent
ceiling of lexical retrieval when the query omits the discriminating term.

**Semantic expansion — tried, measured, kept off.** A dependency-free "semantic" layer
(`expandQuery`) was built to close that vocabulary gap: expand the query with terms that
distinctively co-occur (PMI proxy) with query terms across the corpus, then score them at a
soft weight. Measured on the same ground truth it **regressed** recall@1 (0.60 → 0.35) at
every expansion weight. Root cause: quest's cache is **identifier-only** (symbol/export/path
names, no file content), so co-occurrence is dominated by generic utility tokens
(`ensure`, `available`, `stamp`, …) rather than real synonymy. The machinery is retained as a
tested, configurable seam (`CODEBASE_RANKING.semantic`, default `enabled: false`) that a
future content-based embedding provider can build on — but corpus co-occurrence over
identifier-only documents is not the lever. Genuinely closing the gap needs content-based
embeddings, which require a model (network provider or a bundled local model) and a decision
about the suite's offline/no-dependency posture; that decision is deferred, not taken.

## Context budgeting (small-model / low-context efficiency)

Both pi-quest (the steering/awareness block that leads a sub-agent turn) and pi-memory
(the profile block appended to the system prompt) inject context into agent prompts. Two
shared concerns live in `core/context-budget.ts` so both extensions size and trim context
identically:

- **`budgetForModel(model)`** derives a character budget from the model's real fields —
  primarily `contextWindow` (a low window shrinks the budget, directly serving the
  low-context goal) plus a small, configurable "small-model" marker list. It only ever
  _reduces_ the base budget, so large ample-context models are never starved. All
  thresholds are surfaced in `CONTEXT_BUDGET` and overridable per call.
- **`clampToBudget(text, budget)`** trims by dropping whole trailing lines and appending a
  marker, never cutting a line mid-way. This replaced raw `slice(0, n)` cuts in the live
  awareness path (`todo-sync.ts`), the memory injection, and the composable context-broker —
  a mid-line cut emits malformed markdown exactly when a small model can least afford it.

The model is passed structurally (`BudgetModelInfo`), so `core/` keeps no pi-ai dependency.
The steering path uses the delegated step's assigned model id; the create/command/memory
paths use `ctx.model`. Memory only tightens its block when the model actually triggers a
downscale, preserving existing behaviour on large models.

## Task → Step rename (completed)

Quest originally used `task` as its unit-of-work term. In v1 the canonical term was
changed to `step` across the codebase while preserving full backward compatibility:

- **Internal types:** `QuestStep`, `StepStatus` (canonical); `QuestTask`, `TaskStatus`
  (deprecated aliases, kept for compatibility).
- **Quest shape:** `quest.steps` (canonical); `quest.tasks` (legacy mirror, written on
  every save so older releases can still read quest files).
- **Commit shape:** `commit.stepIndex` (canonical); `commit.taskIndex` (legacy mirror).
- **Public tools:** New `quest_step_detail` alias alongside `quest_task_detail`;
  `stepIndex` parameter aliases alongside `taskIndex` on `quest_commit` and
  `quest_assign_model`. All old `task`-named entry points remain accepted forever.
- **Wire format unchanged:** Both `steps` and `tasks` arrays coexist on disk. The
  rename does NOT bump `CONTRACT_VERSION` — it is not a breaking storage change.

This follows the principle: new code prefers `step`, old integrations continue to work.

## Roadmap alignment

This consolidation is the precondition for the loop-engineering roadmap (deterministic
verification gates, run-log observability, pluggable todo/memory backends): those all
hook the shared contract and a single transition chokepoint rather than three drifting
copies. See the per-extension docs once migrated.
