import { test } from "node:test";
import assert from "node:assert/strict";
import type { TodoItem } from "../../core";
import { displayOrder, visibleOrder, indent, treePrefix } from "./display";

function item(content: string, status: TodoItem["status"], level?: number): TodoItem {
	return { content, status, level, createdAt: 1, completedAt: null };
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

// ── visibleOrder ────────────────────────────────────────────────────────────

test("visibleOrder falls back to displayOrder when no items have level > 0", () => {
	const flat = [item("done", "completed"), item("todo", "pending"), item("active", "in_progress")];
	const shown = visibleOrder(flat);
	const expected = displayOrder(flat);
	assert.deepEqual(
		shown.map((i) => i.content),
		expected.map((i) => i.content),
		"flat list uses status order",
	);
});

test("visibleOrder preserves input order when tree items are present", () => {
	const tree = [
		item("parent A", "pending", 0),
		item("child A1", "pending", 1),
		item("child A2", "pending", 1),
		item("parent B", "pending", 0),
		item("child B1", "pending", 1),
	];
	const shown = visibleOrder(tree);
	assert.deepEqual(
		shown.map((i) => i.content),
		["parent A", "child A1", "child A2", "parent B", "child B1"],
	);
});

test("visibleOrder handles multiple nesting levels", () => {
	const deep = [
		item("L0a", "pending", 0),
		item("L1a", "pending", 1),
		item("L2a", "pending", 2),
		item("L1b", "pending", 1),
		item("L0b", "pending", 0),
		item("L1c", "pending", 1),
	];
	const shown = visibleOrder(deep);
	// All children nest under nearest preceding L0 parent
	assert.deepEqual(
		shown.map((i) => i.content),
		["L0a", "L1a", "L2a", "L1b", "L0b", "L1c"],
	);
});

test("visibleOrder keeps uneven levels instead of dropping todos", () => {
	const uneven = [
		item("orphan", "pending", 1),
		item("parent", "pending", 0),
		item("deep child", "pending", 2),
	];
	const shown = visibleOrder(uneven);
	assert.deepEqual(
		shown.map((i) => i.content),
		["orphan", "parent", "deep child"],
	);
});

test("visibleOrder mixed statuses in tree keep grouping", () => {
	const mixed = [
		item("parent A", "completed", 0),
		item("child A1", "pending", 1),
		item("child A2", "in_progress", 1),
		item("parent B", "pending", 0),
		item("child B1", "completed", 1),
	];
	const shown = visibleOrder(mixed);
	// Tree grouping preserved regardless of status
	assert.deepEqual(
		shown.map((i) => i.content),
		["parent A", "child A1", "child A2", "parent B", "child B1"],
	);
});

// ── indent ──────────────────────────────────────────────────────────────────

test("indent returns empty string for level 0", () => {
	assert.equal(indent(0), "");
});

test("indent returns two spaces per level", () => {
	assert.equal(indent(1), "  ");
	assert.equal(indent(2), "    ");
	assert.equal(indent(3), "      ");
});

test("indent clamps at 8 levels", () => {
	assert.equal(indent(8), "  ".repeat(8));
	assert.equal(indent(9), "  ".repeat(8));
	assert.equal(indent(100), "  ".repeat(8));
});

test("indent clamps negative to 0", () => {
	assert.equal(indent(-1), "");
	assert.equal(indent(-5), "");
});

// ── treePrefix ──────────────────────────────────────────────────────────────

test("treePrefix renders branch connectors for siblings", () => {
	const items = [
		item("parent", "pending", 0),
		item("child one", "pending", 1),
		item("child two", "pending", 1),
	];
	assert.equal(treePrefix(items, 0), "");
	assert.equal(treePrefix(items, 1), "├─ ");
	assert.equal(treePrefix(items, 2), "└─ ");
});

test("treePrefix renders nested continuation lines", () => {
	const items = [
		item("parent", "pending", 0),
		item("child", "pending", 1),
		item("grandchild one", "pending", 2),
		item("grandchild two", "pending", 2),
		item("sibling", "pending", 1),
	];
	assert.equal(treePrefix(items, 2), "│  ├─ ");
	assert.equal(treePrefix(items, 3), "│  └─ ");
	assert.equal(treePrefix(items, 4), "└─ ");
});
