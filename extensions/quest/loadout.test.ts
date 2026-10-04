import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	nextActiveTools,
	QUEST_RUN_TOOLS,
	questIsLive,
	startsInactive,
	syncQuestLoadout,
} from "./loadout";

describe("quest tool loadout", () => {
	test("entry points and cheap reports stay declared; run tools start inactive", () => {
		for (const name of ["quest_create", "quest_status", "quest_history", "quest_eval_stats"]) {
			assert.equal(startsInactive(name), false, name);
		}
		for (const name of ["quest_plan", "quest_update", "quest_approve", "quest_delegate"]) {
			assert.equal(startsInactive(name), true, name);
		}
		assert.equal(startsInactive("read"), false, "never touches other extensions' tools");
	});

	test("a quest is live while planning, active, or paused", () => {
		assert.equal(questIsLive(null), false);
		assert.equal(questIsLive({ status: "planning" }), true);
		assert.equal(questIsLive({ status: "active" }), true);
		assert.equal(questIsLive({ status: "paused" }), true);
		assert.equal(questIsLive({ status: "done" }), false);
		assert.equal(questIsLive({ status: "idle" }), false);
	});

	test("switching on appends missing run tools and preserves everything else", () => {
		const next = nextActiveTools(["read", "bash", "quest_create"], true)!;
		assert.deepEqual(next.slice(0, 3), ["read", "bash", "quest_create"]);
		assert.deepEqual(next.slice(3), [...QUEST_RUN_TOOLS]);
		assert.equal(nextActiveTools(next, true), null, "already on: no change");
	});

	test("switching off removes only run tools", () => {
		const on = ["read", "quest_plan", "bash", "quest_update", "todo_write"];
		assert.deepEqual(nextActiveTools(on, false), ["read", "bash", "todo_write"]);
		assert.equal(nextActiveTools(["read", "bash"], false), null, "already off: no change");
	});

	test("syncQuestLoadout applies changes, skips no-ops, and tolerates old/failing APIs", () => {
		let active = ["read", "quest_create"];
		let sets = 0;
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				sets++;
				active = names;
			},
		};
		syncQuestLoadout(pi, { status: "active" });
		assert.ok(active.includes("quest_plan"));
		syncQuestLoadout(pi, { status: "active" });
		assert.equal(sets, 1, "no redundant tool-set change (keeps the prompt cache)");
		syncQuestLoadout(pi, null);
		assert.deepEqual(active, ["read", "quest_create"]);

		assert.doesNotThrow(() => syncQuestLoadout({}, { status: "active" }));
		assert.doesNotThrow(() =>
			syncQuestLoadout(
				{
					getActiveTools: () => {
						throw new Error("boom");
					},
					setActiveTools: () => {},
				},
				{ status: "active" },
			),
		);
	});
});
