import test from "node:test";
import assert from "node:assert/strict";
import { mergeTodoItems } from "./merge";
import type { TodoItem } from "../../core";

const item = (over: Partial<TodoItem> & { content: string }): TodoItem => ({
	status: "pending",
	agent: undefined,
	context: undefined,
	result: undefined,
	source: undefined,
	sourceId: undefined,
	sourceIndex: undefined,
	level: undefined,
	createdAt: 100,
	completedAt: null,
	...over,
});

test("resubmitting without agent/context/result preserves previous values", () => {
	const prev = [
		item({
			content: "fix auth",
			status: "delegated",
			agent: "worker",
			context: "do it",
			result: undefined,
		}),
	];
	const next = mergeTodoItems(
		[item({ content: "fix auth", status: "completed", result: "done" })],
		prev,
	);
	assert.equal(next[0].agent, "worker", "agent preserved from previous item");
	assert.equal(next[0].context, "do it", "context preserved from previous item");
	assert.equal(next[0].result, "done", "new result wins");
	assert.equal(next[0].status, "completed");
});

test("resubmitting with explicit agent/context overrides previous", () => {
	const prev = [
		item({ content: "fix auth", status: "delegated", agent: "worker", context: "old ctx" }),
	];
	const next = mergeTodoItems(
		[item({ content: "fix auth", status: "delegated", agent: "verifier", context: "new ctx" })],
		prev,
	);
	assert.equal(next[0].agent, "verifier");
	assert.equal(next[0].context, "new ctx");
});

test("quest metadata survives a plain status flip", () => {
	const prev = [
		item({
			content: "step 2",
			status: "pending",
			source: "quest",
			sourceId: "quest-abc",
			sourceIndex: 1,
			level: 0,
		}),
	];
	const next = mergeTodoItems([item({ content: "step 2", status: "in_progress" })], prev);
	assert.equal(next[0].source, "quest");
	assert.equal(next[0].sourceId, "quest-abc");
	assert.equal(next[0].sourceIndex, 1);
	assert.equal(next[0].level, 0);
});

test("createdAt is preserved, completedAt stamped once on completion", () => {
	const prev = [item({ content: "ship it", status: "pending", createdAt: 500 })];
	const next = mergeTodoItems([item({ content: "ship it", status: "completed" })], prev);
	assert.equal(next[0].createdAt, 500, "createdAt preserved");
	assert.ok(next[0].completedAt != null && next[0].completedAt > 0, "fresh completedAt stamped");

	const again = mergeTodoItems([item({ content: "ship it", status: "completed" })], next);
	assert.equal(again[0].completedAt, next[0].completedAt, "completedAt not re-stamped");
});

test("new items get createdAt; leaving completed resets completedAt", () => {
	const next = mergeTodoItems([item({ content: "brand new", status: "pending" })], []);
	assert.ok(next[0].createdAt > 0);
	const reopened = mergeTodoItems([item({ content: "brand new", status: "pending" })], next);
	assert.equal(reopened[0].completedAt, null);
});
