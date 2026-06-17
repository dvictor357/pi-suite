import { test } from "node:test";
import assert from "node:assert/strict";
import type { TodoItem } from "../../core";
import { displayOrder } from "./display";

function item(content: string, status: TodoItem["status"]): TodoItem {
	return { content, status, createdAt: 1, completedAt: null };
}

test("displayOrder sorts by status: in_progress, delegated, pending, completed", () => {
	const stored = [
		item("done-one", "completed"),
		item("todo-one", "pending"),
		item("active", "in_progress"),
		item("farmed", "delegated"),
	];
	const shown = displayOrder(stored);
	assert.deepEqual(
		shown.map((i) => i.content),
		["active", "farmed", "todo-one", "done-one"],
	);
});

test("the index a user reads off the display resolves to that same item", () => {
	// This is the bug #1 contract: display and /todo <idx> share displayOrder,
	// so position N in the shown list is the item the command acts on.
	const stored = [item("c", "completed"), item("a", "in_progress"), item("p", "pending")];
	const shown = displayOrder(stored);
	assert.equal(shown[0].content, "a", "index 0 = the in_progress item shown first");
	assert.equal(shown[1].content, "p");
	assert.equal(shown[2].content, "c");
});

test("displayOrder returns a shallow copy with the same item references", () => {
	const stored = [item("x", "pending")];
	const shown = displayOrder(stored);
	assert.notEqual(shown, stored, "new array");
	assert.equal(shown[0], stored[0], "same item reference — mutating it persists to the list");
});
