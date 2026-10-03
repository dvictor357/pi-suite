# bench — offline eval harness

Answers one question with numbers instead of vibes: **does pi-suite make the agent better, and at what cost?**

Production eval rows (`~/.pi/agent/quests/*/evals`) can't answer that. The verifier is an LLM grading its own team, so nearly every row says `verified: true`. Here, grading is done by real tests the agent never sees.

## How it works

Each task replays a real pi-suite commit, SWE-bench style:

1. Snapshot the commit's **parent** into a temp dir as a fresh one-commit repo (no history, so the agent can't `git show` the answer). `node_modules` is symlinked from this repo.
2. Run `pi --mode json -p` on an issue-style prompt (`tasks.ts`) inside a sandbox `HOME` whose `.pi/agent` holds only what the arm allows.
3. Copy the commit's own test files over the workspace (hidden until now) and run them. **Pass = every test in those files passes.** Pre-existing tests in the same files act as regression checks.
4. Append one row to `bench/results/<stamp>/results.jsonl`. Transcripts and grader output go next to it.

Cost and tokens come from the JSON event stream: assistant `message_end` usage, plus sub-agent usage from `subagent` tool results (child processes) and `quest_delegate` results (in-process runs). Neither shows up in the main agent's message usage.

## Arms

| Arm     | What it is                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------- |
| `plain` | pi with `--no-extensions`: one agent, built-in tools                                                     |
| `suite` | pi with this repo's pi-suite loaded (memory, todo, quest tools, pi-minions sub-agents)                   |
| `quest` | `suite`, plus a prompt prefix telling the agent to run the task as a pi-quest (plan → delegate → verify) |

Suite arms load pi-suite from a frozen `git archive` of `--suite-rev` (default `HEAD`), so editing quest code while a batch runs can't contaminate it. Uncommitted changes aren't loaded unless you pass `--suite-rev worktree`. The report labels suite arms `suite@<sha>`, so two pi-suite versions compare side by side: run the same tasks with `--suite-rev <old>` and `--suite-rev <new>`, then pass both result files to `report`.

By default every sub-agent tier is pinned to the run's model, so `suite` vs `plain` measures the harness, not a stronger model hidden in a tier. `--real-tiers` uses your `settings.json` tiers instead.

`suite` has the tools available but leaves it to the agent to use them. `quest` forces orchestration, so `quest` vs `suite` isolates what the orchestration itself costs and buys.

## Commands

```bash
npm run bench -- validate                       # every task fails on parent, passes on commit ($0)
npm run bench -- run --dry-run                  # list the runs without spending anything
npm run bench -- run --tasks verify-prose --trials 1 --keep   # one cheap smoke run
npm run bench -- run                            # full matrix: 10 tasks × 3 arms × 3 trials
npm run bench -- run --model openai-codex/gpt-6-sol --thinking high --arms suite
npm run bench -- report bench/results/<stamp>   # re-render a report
```

Knobs (trials, default model `openai-codex/gpt-6.1-sol` at `low`, blocked providers, timeouts, concurrency) live in `config.ts`.

## Safety

- Every run gets its own `HOME` and `PI_CODING_AGENT_DIR`. Nothing touches the real `~/.pi/agent`, including `npm test` runs the agent makes in old commits that predate test isolation.
- The sandbox `auth.json` holds only the providers the run uses (the model plus every sub-agent tier). Providers in `BENCH.blockedProviders` (deepseek, which is prepaid credit) are refused outright and their keys are never copied.
- OAuth tokens are never refreshed inside a sandbox, because that would rotate the refresh token and log you out for real. Before every run the harness checks that the token stays valid past `agentTimeoutMs` plus a margin. If it won't, the batch stops early. Refresh with any short pi call outside the bench, then run again.
- User packages, skills and `APPEND_SYSTEM.md` are not loaded. Arms differ only in what the arm declares.
- `run` spends real money: tasks × arms × trials agent runs.

## Adding a task

Pick a commit that adds or changes tests along with source. Write a prompt in `tasks.ts` that states the problem and any interface the tests import (module path, export name, exact output format), but not the implementation. Then run `validate`. The task must be `ok` (fails on parent, passes on commit) before it counts.

## Reading results

Small N lies. The report prints Wilson intervals. If two arms' intervals overlap, the data hasn't separated them yet. Add trials or tasks before drawing conclusions. The paired per-task section is the fairest comparison, because task difficulty dominates the variance.
