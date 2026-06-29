# Quest Kanban Upgrade Spec

## Goal

Upgrade `/quest kanban` from a simple status board into a richer project-management screen while keeping the implementation scoped and safe.

## Codebase scope

Primary files:

- `extensions/quest/kanban.ts` — board state, rendering, keyboard handling, helper functions, and optional action callback API.
- `extensions/quest/index.ts` — command wiring, quest state mutations, and callbacks passed into `QuestKanban`.

Related read-only contracts:

- `extensions/quest/types.ts` — source of `Quest`, `QuestTask`, status, timing, verification, git, and dependency fields.
- `extensions/quest/constants.ts` — source of status icons and retry constants.

Do not change `Quest` or `QuestTask` for this screen. Compute UI-only state from existing fields.

## Current-state constraints

The existing board:

- Has four fixed columns: TODO, DOING, DONE, FAILED.
- Supports arrow-key selection and `Esc` close.
- Renders raw `string[]` lines.
- Refreshes quest state from `extensions/quest/index.ts` during render.
- Shows only status icon, task index, and truncated content.

Missing high-value project-management affordances:

- Selected task detail inspection.
- Scrollable long context/result/verification output.
- Keyboard help.
- Progress and verification summary.
- Dependency, retry, model, branch, and commit visibility.
- Safe inline quest actions.
- Tests for pure kanban state/render behavior.

## Modes

### Board mode

Default mode. Shows quest-level progress plus task columns.

Required content:

- Header line: quest name, quest status, completed/total count, percent complete.
- Goal snippet: truncated to one line.
- Summary line: counts for pending, running, verifying, done, failed, skipped.
- Verification line: verified count, verification enabled/disabled, tasks with verify retries.
- Metadata line when present: team, planning mode, plan approval state, git commits, pause reason.
- Board columns/lists grouped by status.
- Footer with discoverable keys.

### Detail mode

Opens for the selected task. Detail content must be scrollable because `context`, `result`, and `verifyResult` can be long.

Required fields:

- Task number and full content.
- Status icon/status.
- Agent and model, if present.
- Dependencies as `#n status content` lines.
- Attempts and verification retries.
- Started/completed timestamps.
- Duration when both timestamps exist.
- Branch and commit hash when present.
- Full context.
- Full result or `(no result yet)`.
- Verification state and verify result or `(not verified yet)`.

Detail footer must show scroll position and keys.

### Help mode

Opens from board or detail and returns to the previous mode.

Required content:

- Keyboard map.
- Status icon legend.
- Safe action notes.
- Explicitly note destructive/task-mutating actions are not available from first-pass kanban.

## Keyboard map

### Global

- `q` — close the kanban overlay.
- `Esc` — close current mode; from board, close the overlay.
- `?` or `h` — toggle help.
- `r` — refresh quest data / rerender.

### Board mode

- `←` / `→` — move between columns.
- `↑` / `↓` — move between tasks in the selected column.
- `Home` — first task in selected column.
- `End` — last task in selected column.
- `Enter` or `d` — open selected task detail.
- `p` — pause active quest or resume paused quest when valid.
- `s` — start/resume quest when valid and approved.
- `a` — approve pending approval-mode quest when valid.

### Detail mode

- `↑` / `k` — scroll up.
- `↓` / `j` — scroll down.
- `PageUp` — scroll up by a page when supported.
- `PageDown` — scroll down by a page when supported.
- `Home` — top of detail.
- `End` — bottom of detail.
- `Esc` or `Backspace` — return to board.

### Help mode

- `Esc`, `Backspace`, `?`, or `h` — return to previous mode.
- `q` — close overlay.

## Focus and refresh behavior

- `QuestKanban` owns one focus target: the custom overlay.
- Board mode owns `selectedCol` and `selectedRow`.
- Detail mode owns `detailScroll`.
- Help mode stores `previousMode` and restores it when dismissed.
- When `setQuest()` receives fresh state, preserve selected task by global task index when possible.
- If the selected task disappeared or moved to another column, clamp to the closest valid column/row.
- If a selected column is empty, keep focus on the column and use row `0`.
- Opening detail with no selected task should show a useful empty state instead of crashing.

## Responsive layout

`render(width)` only receives width, not height. Therefore:

- Every line returned by `render(width)` must be at or below the requested visible width.
- Use predictable content budgets and scroll indicators for long content.
- Use ANSI-safe truncation helpers if color codes are present in measured strings.

Suggested board layouts:

- `>= 112` columns: four columns side-by-side.
- `72–111` columns: two rows of two columns.
- `< 72` columns: single-column grouped list.

If full responsive wrapping is too large for the first implementation, keep four columns but harden narrow-width behavior and add tests that no rendered line exceeds the width.

## Task-cell metadata

Cells should remain compact. Show metadata only when width allows.

Required minimum:

- Status icon.
- `#<taskIndex + 1>`.
- Truncated task content.

Optional compact markers:

- Agent: `@worker`, `@planner`, etc.
- Dependencies: `dep:2` or `←2`.
- Attempts: `try:2` when attempts > 0.
- Verification: `✓v`, `v?`, or `vr:1`.
- Git: `git` or short branch/commit marker.

Full values belong in detail mode, not cells.

## Quest-level metadata

Compute from existing `Quest` fields:

- Total tasks.
- Done count.
- Pending/running/verifying/done/failed/skipped counts.
- Verified count.
- Tasks with verify retries > 0.
- Commits count.
- Team name when present.
- Plan approval state.
- `verifyOnComplete` state.
- Pause reason when present.
- Created/completed/update timing if useful and available.

## Safe inline actions

`kanban.ts` must not import quest storage or call `persist()` directly. It may expose optional callbacks supplied by `index.ts`.

Recommended callback shape:

```ts
export interface QuestKanbanActions {
  refresh?: () => void;
  pauseOrResume?: () => void;
  startOrResume?: () => void;
  approve?: () => void;
}
```

First-pass safe actions:

- Refresh.
- Pause active quest.
- Resume paused quest.
- Start/resume approved non-active quest.
- Approve approval-mode plan when valid.

Out of scope for first pass:

- Cancel/archive quest.
- Delete/edit/reorder tasks.
- Mark tasks done/failed/skipped.
- Retry a failed task.
- Commit recording.
- Model assignment.
- Delegation trigger.

Reason: those actions are destructive, semantically complex, or require confirmation/model/tool flows outside the compact board.

## `index.ts` wiring

Refactor the duplicated `/quest` and `/quest kanban` `ctx.ui.custom()` setup into one helper, for example:

```ts
async function openQuestKanban(ctx: CommandContext, initialQuest: Quest): Promise<void> {
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const kanban = new QuestKanban(initialQuest, theme, {
        actions: {
          refresh: () => tui.requestRender(),
          pauseOrResume: () => {
            /* reuse existing pause/resume semantics */
          },
          startOrResume: () => {
            /* reuse existing start/resume semantics */
          },
          approve: () => {
            /* reuse existing approve semantics */
          },
        },
      });
      kanban.onClose = () => done(undefined);
      return {
        render: (width: number) => {
          const fresh = loadQuest(ctx.cwd);
          if (fresh) kanban.setQuest(fresh);
          return kanban.render(width);
        },
        invalidate: () => kanban.invalidate(),
        handleInput: (data: string) => {
          kanban.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}
```

Keep actual quest mutations in `index.ts` and call `persist(ctx, quest)` there.

## Test plan

Add `extensions/quest/kanban.test.ts` with SDK-free tests.

Use a fake theme object that returns plain strings for `fg`, `bg`, and `bold`.

Required tests:

- Column grouping for all task statuses.
- Progress summary counts.
- Selected task lookup returns the correct global index/task.
- Selection clamps after quest refresh.
- Enter opens detail when a task is selected.
- Detail scroll keys change scroll offset and clamp at bounds.
- Help opens and returns to previous mode.
- Empty-state render does not throw.
- Narrow-width render does not exceed requested width after stripping ANSI codes.
- Metadata labels include dependencies, attempts, verification, branch/commit when present.
- Action keys call callbacks only when callbacks are provided.

## Acceptance criteria

- `/quest kanban` remains available and backward compatible.
- `/quest` with no subcommand still opens the kanban when UI is available.
- Board mode shows quest-level progress and useful compact metadata.
- Selected task detail is accessible and scrollable.
- Help overlay documents all keys.
- First-pass inline actions are safe and callback-driven.
- No `Quest`/`QuestTask` storage contract change.
- Impact remains mostly limited to `kanban.ts`, `index.ts`, docs, and tests.
- `npm run typecheck`, `npm test`, and `npm run format:check` pass.
