# Bundled pi-minions

Delegate tasks to specialized subagents with **isolated context windows**.

Each subagent runs as an independent `pi` process — it can read hundreds of files, call tools, and reason deeply, and only the final answer comes back to the main session. No context pollution.

## Install

Install pi-suite and disable/remove any separately installed pi-minions package
first. The suite bundles the runner and agents in `extensions/subagent`; existing
settings and history need no migration.

## Modes

| Mode         | Description                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Single**   | One agent, one task. `{ agent, task }`                                                                                           |
| **Parallel** | Multiple agents run concurrently (max 4). `{ tasks: [...] }`                                                                     |
| **Chain**    | Sequential steps. Each step sees the previous output via `{previous}`. `{ chain: [...] }`                                        |
| **Pipeline** | Items flow through stages independently — item B can be in stage 1 while item A is in stage 3. `{ items: [...], stages: [...] }` |

Parallel writer tasks must declare non-empty, disjoint `writeClaim` path arrays or use separate `cwd` directories — unless they run with `isolation: "worktree"` (below). Pipeline writer stages follow the same rule and may use `{item}` in `readClaim`/`writeClaim`. `scout`, `planner`, `reviewer`, and `verifier` are read-only and cannot declare writes. Single and sequential calls remain unchanged.

## Worktree Isolation

Set `isolation: "worktree"` on a single or parallel call and each writer agent gets its own `git worktree` checked out from `HEAD`. Agents can edit the same files at the same time without stepping on each other or on your working tree. No `writeClaim` needed.

```
subagent({
  isolation: "worktree",
  tasks: [
    { agent: "worker", task: "Add retry backoff to the HTTP client" },
    { agent: "worker", task: "Add request timeouts to the HTTP client" },
    { agent: "scout",  task: "List every caller of the HTTP client" },
  ],
})
```

When a task finishes, whatever it changed is committed to its own branch, `pi-minions/<run>/<n>-<agent>`, and the temporary checkout is deleted. The result reports the branch, a diff stat, and ready-to-run `git diff` / `git merge` commands. Nothing is merged for you.

- **No changes, no branch.** The branch is deleted if the agent changed nothing.
- **Partial work is kept.** A failed, timed-out, or aborted task still commits what it left behind, so you can inspect it. List all branches with `git branch --list 'pi-minions/*'`.
- **Read-only agents run in place.** No worktree for `scout`, `planner`, `reviewer`, `verifier`, or any agent whose `tools` list has no `write`, `edit`, or `bash`.
- **Starts from `HEAD`.** Uncommitted changes in your checkout are not visible to isolated agents. The result warns when your tree is dirty. Commit first if agents need that work.
- **Dependencies.** An untracked root `node_modules` is symlinked into each worktree so builds and tests run without a fresh install. The link is never committed.
- **Limits.** Requires a git repo with at least one commit. A task `cwd` must stay inside the repo. Chain and pipeline modes don't support isolation yet. Auto-commits use `--no-verify`, so hooks don't run on the scratch branches.

## Budgets

Cap what one `subagent` call can spend. The cap covers every agent, retry, chain step, and pipeline stage in the call:

```
subagent({ maxCost: 0.5, tasks: [...] })      // USD
subagent({ maxTokens: 200000, chain: [...] }) // input + output tokens
```

Once the cap is reached, running subagents are stopped, queued ones never start, and retries are skipped. The call still returns: results so far, with stopped tasks marked `failed (budget)`, plus a note saying the output is partial. The TUI shows spend against the cap next to the usage totals.

- **Soft cap.** Spend is counted after each model turn, so turns already in flight can push slightly past the cap.
- **Final answers finish.** An agent whose last turn crosses the cap keeps its answer. Only agents with more work pending are stopped.
- **Cost needs provider pricing.** `maxCost` uses the cost the provider reports. If a provider reports $0, use `maxTokens` instead.
- **Defaults.** Set `subagent.maxCost` / `subagent.maxTokens` in `~/.pi/agent/settings.json` to apply a cap to every call. Pass `0` in a call to turn a default cap off for that call.

## Run History & Re-runs

Every `subagent` call that runs at least one agent is saved: parameters, each agent's transcript, usage, status, and worktree branches. When a call has failures, its output ends with a run id and the exact call that re-runs it:

```
Run id: mfx3k2a1-9c4e. Re-run the failed work with subagent({ rerun: "mfx3k2a1-9c4e" }).
```

`rerun` redoes only the work that didn't finish:

| Mode     | What re-runs                                                                        |
| -------- | ----------------------------------------------------------------------------------- |
| Single   | The task, if it failed                                                              |
| Parallel | Only the failed or unfinished tasks                                                 |
| Chain    | From the first failed step onward, with that step's `{previous}` taken from history |
| Pipeline | Only the failed items, from the first stage                                         |

Use `rerunScope: "all"` to repeat the whole call. Options you pass alongside `rerun`, such as `retries`, `maxCost`, `timeoutMs`, or `isolation`, replace the stored ones.

Slash commands:

| Command                      | Description                                                |
| ---------------------------- | ---------------------------------------------------------- |
| `/subagent runs`             | Recent runs for this project: status, agents, cost         |
| `/subagent show <id>`        | Each task's status, output, errors, and worktree branch    |
| `/subagent rerun <id> [all]` | Asks the main agent to re-run, so results land in the chat |

Ids can be shortened to any unique prefix. History lives in `~/.pi/agent/subagent-runs/<project hash>/`, outside your repo, so transcripts never end up in a commit. Files are owner-only (`0600`). The newest 50 runs per project are kept, and text over 16 KB per message is truncated. Set `"history": false` in the `subagent` settings block to turn recording off.

## Output Contracts

Give a subagent a JSON Schema and it returns validated data instead of free text. Chains and pipelines can then pass typed fields from one step to the next.

```
subagent({
  chain: [
    {
      agent: "scout",
      task: "Find the files that handle auth",
      output: {
        type: "object",
        required: ["files"],
        properties: { files: { type: "array", items: { type: "string" } } },
      },
    },
    { agent: "worker", task: "Add rate limiting to {previous.files.0}" },
  ],
})
```

How it works:

1. The schema is added to the task, asking for one fenced ` ```json ` block in the final message.
2. The JSON is extracted and validated when the agent finishes.
3. If it doesn't match, the agent runs once more with the validation errors and its previous answer, to fix the format rather than redo the work.
4. If it still doesn't match, the task fails with `invalid_output` and the list of errors. That failure works with `onError`, run history, and `rerun` like any other.

Using the result:

- `{previous}` receives the validated value as formatted JSON.
- `{previous.a.b}` or `{previous.list.0}` inserts one field: strings as-is, everything else as JSON.
- A path that doesn't exist, or a path on a step with no schema, fails that step before anything is spawned. No agent ever receives a half-filled task.
- In single mode, the tool's answer is the JSON itself. Each result's `details` carries the parsed value as `structured`.

`output` works on single calls, parallel `tasks`, chain steps, and pipeline stages. An agent can also declare a default schema in its frontmatter, written as YAML. A per-call `output` replaces it:

```markdown
---
name: file-finder
description: Lists files relevant to a question
tools: read,ls,ffgrep,fffind
output:
  type: object
  required: [files]
  properties:
    files: { type: array, items: { type: string } }
---
```

## Codebase Intelligence

A built-in `codebase` tool scans your repo, builds a dependency graph, and answers architecture questions. No native dependencies — regex parsers, Node built-ins, and a JSON sidecar cache.

### Operations

| Operation  | Description                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| **scan**   | Index all JS/TS source files (imports, exports, symbols, hashes). Writes `.pi/codebase-index.json`. Auto-runs on first use. |
| **query**  | Find files by pattern — matches paths, file names, symbols, and exports (case-insensitive).                                 |
| **map**    | Show a file's immediate dependencies and reverse dependencies with import/export details.                                   |
| **impact** | Transitive reverse dependency closure — every file that depends on a given file, directly or transitively.                  |

### Cache

The index is cached to `.pi/codebase-index.json` and auto-refreshes when files change (mtime + SHA-256 hash of first 16 KiB). Force a re-scan with `force: true`.

### Bundled Agent

`codebase-analyst` (`tier: reasoning`) reads `.pi/codebase-index.json` directly to answer architecture, dependency, and refactoring-impact questions.

### pi-suite Integration

pi-suite's quest orchestration consumes the same `.pi/codebase-index.json` for pre-flight checks and post-task impact verification. No code dependencies — the contract is the JSON schema and `contractVersion` field.

**Ownership split:**

| Layer                           | Owner      | Role                                                                                         |
| ------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| **Scanner** (`indexer.ts`)      | pi-minions | Walk repo, parse imports/exports/symbols, build dep/revDep maps                              |
| **Cache** (`cache.ts`)          | pi-minions | Read/write `.pi/codebase-index.json`, staleness detection                                    |
| **Query engine** (`query.ts`)   | pi-minions | `scanIndex`, `queryFiles`, `depMap`, `getImpact` — pure functions on `IndexData`             |
| **`codebase` tool**             | pi-minions | Tool registration, params, results, and TUI rendering                                        |
| **Quest planning/verification** | pi-suite   | Reads `.pi/codebase-index.json` directly for pre-flight checks and post-task impact analysis |

The suite bundles pi-minions in `extensions/subagent`. The cache shape, version, and path live in `core/codebase-contract.ts`; Quest keeps its own tolerant reader and ranking. See [`CONTRACT.md`](../extensions/subagent/codebase/CONTRACT.md) for the full specification including cache location, schema, tool params/results, staleness rules, and limitations.

## Agent Definition

Agents are `.md` files with YAML frontmatter. **9 agents ship with the package** (Scout, Worker, Reviewer, Verifier, Planner, Lead, QA, Quick-Worker, Codebase Analyst) and are auto-discovered. Define your own in user or project directories — they override bundled agents with the same name.

### Discovery order (last wins)

1. **Bundled** — shipped with pi-minions (`extensions/subagent/agents/`)
2. **User** — `~/.pi/agent/agents/*.md`
3. **Project** — `.pi/agents/*.md` (nearest to cwd)

```markdown
---
name: fast-recon
description: Quick file search and pattern matching. Use for initial exploration.
tools: read,ls,find,grep
tier: fast
---

You are a fast reconnaissance agent. Find files quickly. Be concise.
```

| Location                          | Scope                 |
| --------------------------------- | --------------------- |
| `extensions/subagent/agents/*.md` | Bundled with package  |
| `~/.pi/agent/agents/*.md`         | Global (all projects) |
| `.pi/agents/*.md`                 | Project-local         |

### Frontmatter fields

| Field         | Description                                                             |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Unique agent name                                                       |
| `description` | LLM-readable — Main Agent uses this to decide when to summon            |
| `tools`       | Comma-separated tool list (e.g. `read,ls,find,bash`)                    |
| `model`       | Explicit model override                                                 |
| `thinking`    | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`      |
| `tier`        | Tier name (`fast`, `reasoning`) — resolves to model via settings        |
| `output`      | JSON Schema (YAML) the final answer must satisfy — see Output Contracts |

### Tier routing

Map tiers to models in `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "models": {
      "fast": "deepseek/deepseek-v4-flash",
      "reasoning": "deepseek/deepseek-v4-pro"
    },
    "thinking": {
      "fast": "low"
    },
    "maxCost": 2
  }
}
```

Change models in one place — all agents using that tier update automatically.

### Model precedence

When resolving which model an agent runs with:

1. **Per-invocation override** — `subagent(..., model="…")`
2. **Explicit `model:`** in the agent's frontmatter
3. **pi-quest role model** — a per-role model approved by `quest_assign_model`, read from shared project memory
4. **Tier mapping** in `settings.json`
5. **Unset** — the spawned `pi` inherits its own default

Thinking uses the same routing idea: per-invocation `thinking` → explicit agent
frontmatter → pi-quest role `thinkingLevel` → tier mapping → pi default. Invalid persisted
thinking values are ignored. The valid values are `off`, `minimal`, `low`, `medium`,
`high`, and `xhigh`.

## Works with pi-suite / pi-quest

pi-minions is the `subagent` tool that [pi-suite](https://github.com/dvictor357/pi-suite)'s **pi-quest** orchestrator expects. Quest's normal unsandboxed execution calls `subagent(agent="scout")`, `subagent(agent="worker", model="gpt-5.6-sol", thinking="medium")`, and similar handoffs. The bundled agents (`scout`, `planner`, `worker`, `quick-worker`, `reviewer`, `verifier`) cover every role quest's built-in teams reference, and ship together in this suite. Disable any separately installed pi-minions package to avoid duplicate registration.

Per-role models and thinking levels approved in a quest are honored here too — see
**Model precedence** above. The lookup is read-only and contract-versioned: with no
Quest-approved assignment, the runner falls back
to tier routing. Quest keeps restricted/isolated steps on its guarded legacy delegate
until pi-minions can enforce Quest sandbox policy inside the child process.

## License

MIT

## Peer messaging across runs

Use `subagent_message` to coordinate with peers in the same project:

```text
subagent_message(action="peers")
subagent_message(action="send", to="<exact peer ID>", text="The parser change affects validation.ts.")
subagent_message(action="read")
subagent_message(action="ack", ids=["<message ID>"])
```

`peers` returns your ID and recent peer registrations (`offset`/`limit` paginate).
Use exact IDs: two workers with the same role have different IDs; task summaries
help identify the intended worker. Orchestrator IDs
follow the pi session and survive resume/reload; child IDs are unique per invocation
and stable across its retries. Child IDs also appear in results and
`/subagent show <run>`. A new invocation gets a new child ID, so messages addressed
to an ended child do not transfer to a new worker automatically.

Inboxes live outside the repo at `getAgentDir()/subagent-mail/<cwdHash>/`, separate
from run history. Worktree and nested children inherit the original project's scope;
other projects cannot be selected through the messaging tool. Messages persist across
runs until the recipient acknowledges them. Reads are non-destructive, and only the
caller's own inbox can be read or acknowledged. Acknowledgment is idempotent.

Active agents see a pending-inbox notice on their next model request. Messaging
does not wake an idle/ended agent, start another run, or cause a paid model call.
Prefer peers marked `running` for live collaboration; that status records lifecycle
events and may remain stale after a crash. An orchestrator can read queued messages
when its pi session resumes. Peer text is task data, never user approval or permission
to bypass Quest sandbox policy. The guarded Quest SDK fallback has no peer tools.

Each message is limited to 4 KiB of UTF-8 text. Reads return at most ten messages.
An inbox rejects sends at 100 pending messages; simultaneous senders may briefly
exceed this soft cap. Acknowledge processed IDs before reading the next page.
Each subagent start prunes peers idle longer than `PEER_RETENTION_MS` (7 days,
`messaging.ts`), whatever their status, together with their inboxes and any unread
messages. A resumed orchestrator re-registers on its next turn.

Judge/exploration agents (`NO_MESSAGING_AGENTS`: `verifier`, `reviewer`, `scout`,
`planner`) run without messaging, so a concurrent worker cannot message the agent
judging it. They get no `subagent_message` tool, no peer registration, and no
inherited peer ID; `PI_SUBAGENT_MESSAGING=off` in their environment also disables
messaging for anything they spawn.
