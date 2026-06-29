# AGENTS.md

You are working in `pi-suite`, a TypeScript package for pi. Use this file as your map before editing code.

## What this project is

`pi-suite` ships three pi extensions that work together:

- `pi-quest` plans work, delegates tasks to sub-agents, verifies results, and tracks quest progress.
- `pi-todo` keeps a persistent task ledger for the current project.
- `pi-memory` remembers project/user preferences and injects that context into future agent runs.

These extensions share files under `~/.pi/agent`. The main goal of this repo is to keep their shared JSON shapes and path rules in one place: `core/`.

## Start here

Use these commands from the repo root:

```bash
npm install
npm run typecheck
npm test
npm run format:check
npm run format
```

What they do:

- `npm run typecheck` runs `tsc --noEmit`.
- `npm test` runs `node --import tsx --test core/*.test.ts extensions/*/*.test.ts`.
- `npm run format:check` checks Prettier formatting.
- `npm run format` writes Prettier formatting.

## Mental model

Think of the repo in two layers:

1. `core/` owns shared contracts and low-level helpers.
2. `extensions/` owns behavior exposed to pi.

Do not move extension behavior into `core/`. Do not duplicate shared contracts inside extensions.

## Repo map

```text
core/
  contract.ts         Shared JSON types and CONTRACT_VERSION
  paths.ts            ~/.pi/agent paths and cwdHash-scoped path builders
  hash.ts             cwdHash(cwd) = sha256(cwd).slice(0, 16)
  fs.ts               readJSON/writeJSON/updateJSON/appendLine
  coerce.ts           Typed unknown→value helpers for the disk-read boundary
  session-meta.ts     Shared status handoff for memory/todo/quest
  retry-policy.ts     Retry/burst/depth constants (single source of truth)
  run-ledger.ts       Append-only JSONL execution log per quest
  eval-logging.ts     Per-task eval audit trail (JSONL)
  *.test.ts           Core tests

extensions/
  quest/
    index.ts          Thin entry point: builds QuestRuntime, calls register-* modules
    runtime.ts        createQuestRuntime: shared quest cache, auto-pilot lock, ledgers, helpers
    register-create.ts    quest_create, quest_decide
    register-planning.ts  quest_plan, quest_update, quest_approve
    register-status.ts    quest_status/commit/git_summary/team/history/memory_save
    register-delegate.ts  quest_assign_model/delegate/abort/task_detail
    register-events.ts    agent_end auto-pilot, session_start, model_select, sandbox tool_call hook
    register-command.ts   /quest command + kanban board
    sandbox-guard.ts  evaluateToolCall: per-call block/allow decision (real enforcement)
    storage.ts        Quest load/save/archive; sync quest conventions + agent-model choices to memory
    todo-sync.ts      Sync quest tasks into pi-todo; build awareness block
    steering.ts       Auto-pilot task selection and status formatting
    graph.ts          Dependency validation
    teams.ts          Built-in/user team configs
    models.ts         Pure model matching + user-approval dialog for sub-agent models
    delegate.ts       Pure delegation logic: tool scope, model precedence, prompt building
    subagent.ts       Live isolated sub-agent spawn (only SDK-value import; not test-loaded)
    kanban.ts         TUI kanban board
    status.ts         Status badge and session meta
    types.ts          Quest/team types
    context-broker.ts Composable sub-agent prompt context builder
    verifier.ts       Structured verification loop (prompt building, retry)

  todo/
    index.ts          Registers todo tools, commands, events, storage, cache, archives
    display.ts        Todo display order; command indices follow this order

  memory/
    index.ts          Registers memory tools, commands, events, and prompt injection
    detect.ts         Pure project/user tech-stack detection
    profile.ts        Reconcile detected fields while preserving foreign fields

docs/                 Architecture notes
MIGRATION.md          Migration checklist and drift history
package.json          pi package manifest; pi.extensions points at ./extensions
```

## Non-negotiable rules

Follow these unless the user explicitly asks for an architecture change:

1. `core/` is the source of truth for shared state.
   - Import shared helpers/types from `../../core`.
   - Do not reimplement `cwdHash`, JSON helpers, session-meta, or shared JSON types in an extension.
2. Keep `core/` pure Node.
   - No `@earendil-works/pi-*` imports in `core/`.
   - Anything that depends on pi APIs belongs in `extensions/<name>/`.
3. Put something in `core/` only if more than one extension touches it.
   - Extension-private state stays inside that extension.
4. When multiple extensions can write the same file, preserve fields you do not own.
   - Use read-merge-write helpers such as `updateJSON`.
   - `pi-memory` owns detected profile fields, but must preserve quest-written `research` and `lastModified`.
5. Respect future contract versions.
   - If `isFutureContract(blob)` is true, do not reinterpret or overwrite that file.

## Shared storage

Shared files live under `~/.pi/agent`. Project-scoped files use `cwdHash(cwd)`.

- Todo list: `~/.pi/agent/tmp/todos/<cwdHash>.json`
- Project memory: `~/.pi/agent/memory/projects/<cwdHash>.json`
- User memory: `~/.pi/agent/memory/user.json`
- Session meta: shared status handoff with extension keys `memory`, `todo`, `quest`
- Quest active/archive state: `~/.pi/agent/quests/<cwdHash>/...`
- Quest teams: `~/.pi/agent/quests/teams`

If you change a shared shape or shared path:

1. Update `core/contract.ts` and any affected helpers.
2. Bump `CONTRACT_VERSION` for breaking changes.
3. Update all consumers.
4. Add or update tests.
5. Update `docs/architecture.md` or `MIGRATION.md` if the change affects the contract story.

## Extension guide

### Quest extension

Quest is the autonomous project manager.

Tools registered by quest:

- `quest_create`, `quest_plan`, `quest_update`, `quest_approve`
- `quest_status`, `quest_task_detail`, `quest_history`, `quest_abort`
- `quest_commit`, `quest_git_summary`
- `quest_team`, `quest_decide`, `quest_memory_save`
- `quest_assign_model`, `quest_delegate` — orchestrator-driven sub-agent model assignment and isolated sub-agent spawn

Sub-agent delegation (Path B) lives in three modules:

- `models.ts` — pure model matching + `promptModelAssignment` (the user-approval dialog).
- `delegate.ts` — pure, SDK-free decisions: role → tool scope, model precedence (`resolveTaskModel`), prompt building, output extraction.
- `subagent.ts` — the only quest module that imports the SDK as a value (`createAgentSession`); kept out of every test path.

Role → model choices approved by the user are remembered in project memory under `agentModels` (see `core/contract.ts` `AgentModelChoice`); `storage.ts` `loadAgentModels`/`rememberAgentModel` own that read/write. Team `modelHints` are advisory proposals only — the user always approves via `quest_assign_model`.

Command:

```text
/quest create|start|pause|resume|approve|cancel|kanban|status|history|git|team ...
```

The `/quest` and `/quest kanban` commands open a keyboard-driven kanban board
(overlay). Keyboard shortcuts in board mode:

- `← → ↑ ↓` Navigate columns and tasks; `Enter` open task detail
- `p` pause active quest; `r` resume paused quest
- `s` start quest; `a` approve plan (approval mode only)
- `?` / `h` toggle keyboard help overlay; `Esc` close kanban

In task detail mode: `↑ ↓` scroll, `PgUp`/`PgDn` page, `Home`/`End` jump,
`r` retry failed task, `Esc`/`Backspace` back to board.

When editing quest:

- Use `persist(ctx, quest)` for normal quest state changes. It saves the quest, updates UI status, writes session meta, and syncs to todo.
- Keep quest task dependencies acyclic and within `MAX_DEPENDENCY_DEPTH`.
- Quest-created todo items must keep `source: "quest"`, `sourceId`, and `sourceIndex`.
- Syncing quest tasks to todo must not delete user-created todo items.
- Verification is expected to default on for new and legacy quests.

### Todo extension

Todo is the task ledger.

Tools registered by todo:

- `todo_write`
- `todo_history`

Command:

```text
/todo
/todo clear
/todo history [N]
/todo delegate <idx> ...
```

When editing todo:

- `todo_write` replaces the full list. It does not append.
- Keep at most one item `in_progress`.
- Delegated items may be multiple; keep their `context` focused and small.
- Display order is `in_progress`, `delegated`, `pending`, `completed`.
- Command indices use display order, not raw array order.
- If every item is completed, the list auto-archives.

### Memory extension

Memory stores project/user context and injects it into the system prompt.

Tools registered by memory:

- `memory_status`, `memory_project`, `memory_user`
- `memory_search`, `memory_lint`

Command:

```text
/memory
/memory rescan
/memory clear
/memory project key=value
/memory user key=value
```

When editing memory:

- `before_agent_start` appends the profile block to the system prompt.
- Detection should overwrite only detected tech-stack fields.
- Preserve manual conventions, facts, and quest research during rescans.
- Agent-scoped facts are filtered by `PI_AGENT_NAME`, category, or tags.
- Keep prompt output budgeted. Do not dump large memory files into the system prompt.

## Code style

Use the existing style:

- TypeScript ES modules.
- Strict TypeScript.
- Tabs in code.
- Double quotes.
- Semicolons.
- Trailing commas.
- Prettier print width 100.
- Markdown/JSON/YAML use 2-space indentation.
- Prefer `node:` imports for Node built-ins.
- Use `typebox` schemas for tool parameters.
- Use `StringEnum` from `@earendil-works/pi-ai` for enum-like tool params.
- Keep tool descriptions concise; they become model-facing context.

## Tests to run

Before finishing meaningful code changes, run the narrowest useful checks first. When practical, run all gates:

```bash
npm run typecheck
npm test
npm run format:check
```

Add or update tests when you touch:

- `core/` contracts, paths, hashing, fs helpers, or session meta.
- Quest graph/dependency behavior.
- Todo display order or command index behavior.
- Memory detection or profile reconciliation.
- Any migration item in `MIGRATION.md`.

## Common workflows

### Changing a shared contract

1. Edit `core/contract.ts` and any related path/helper files.
2. Bump `CONTRACT_VERSION` if the change is breaking.
3. Update every extension that reads or writes the shape.
4. Add/update tests.
5. Update docs if the storage contract changed.
6. Run typecheck, tests, and format check.

### Adding quest behavior

1. Start in `extensions/quest/index.ts` for tool/command/event wiring.
2. Put storage logic in `storage.ts`.
3. Put task-selection logic in `steering.ts`.
4. Put dependency validation in `graph.ts`.
5. Put todo handoff logic in `todo-sync.ts`.
6. Use best-effort handoffs to todo/memory, and never clobber fields you do not own.

### Adding memory detection

1. Add signal/detection logic in `extensions/memory/detect.ts`.
2. Preserve manual and foreign fields through `profile.ts` reconciliation.
3. Add/update detection tests.
4. Keep the injected prompt block small.

### Adding todo behavior

1. Keep the list shape aligned with `core/contract.ts`.
2. Preserve full-list replacement semantics for `todo_write`.
3. Update `display.ts` if display order or command indexing changes.
4. Preserve quest metadata unless you are intentionally clearing quest items.
