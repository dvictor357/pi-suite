import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setImmediate } from "node:timers/promises";
import {
	enqueueUiPrompt,
	matchModel,
	formatModelLabel,
	promptModelAssignment,
	toModelLike,
	type ModelAssignment,
	type ModelLike,
} from "./models";

const MODELS: ModelLike[] = [
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" },
	{ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
	{ id: "gpt-5", name: "GPT-5", provider: "openai" },
	// Same id offered by two providers — only resolvable when qualified.
	{ id: "shared-model", name: "Shared A", provider: "providera" },
	{ id: "shared-model", name: "Shared B", provider: "providerb" },
];

test("matchModel resolves a bare id", () => {
	assert.equal(matchModel(MODELS, "deepseek-v4-flash")?.provider, "deepseek");
});

test("matchModel is case-insensitive and trims", () => {
	assert.equal(matchModel(MODELS, "  Claude-Opus-4-5 ")?.provider, "anthropic");
});

test("matchModel resolves by display name", () => {
	assert.equal(matchModel(MODELS, "GPT-5")?.id, "gpt-5");
});

test("matchModel accepts provider/id and provider:id qualifiers", () => {
	assert.equal(matchModel(MODELS, "providera/shared-model")?.name, "Shared A");
	assert.equal(matchModel(MODELS, "providerb:shared-model")?.name, "Shared B");
});

test("matchModel returns undefined for an ambiguous bare id", () => {
	assert.equal(matchModel(MODELS, "shared-model"), undefined);
});

test("matchModel returns undefined for an unknown model", () => {
	assert.equal(matchModel(MODELS, "no-such-model"), undefined);
});

test("matchModel returns undefined for empty/whitespace input", () => {
	assert.equal(matchModel(MODELS, ""), undefined);
	assert.equal(matchModel(MODELS, "   "), undefined);
});

test("matchModel respects the provider qualifier (no cross-provider match)", () => {
	assert.equal(matchModel(MODELS, "openai/claude-opus-4-5"), undefined);
});

test("formatModelLabel shows id and provider", () => {
	assert.equal(
		formatModelLabel({ id: "gpt-5", name: "GPT-5", provider: "openai" }),
		"gpt-5 · openai",
	);
});

test("toModelLike projects only id/name/provider and stringifies provider", () => {
	const projected = toModelLike({
		id: "x",
		name: "X",
		provider: "anthropic",
		// extra fields that should be dropped
		contextWindow: 200000,
	} as unknown as { id: string; name: string; provider: string });
	assert.deepEqual(projected, { id: "x", name: "X", provider: "anthropic" });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("promptModelAssignment serializes concurrent prompts", async () => {
	const firstChoice = deferred<string | undefined>();
	const secondChoice = deferred<string | undefined>();
	const choices = [firstChoice, secondChoice];
	const titles: string[] = [];

	const ctx = {
		hasUI: false,
		modelRegistry: { getAvailable: () => MODELS.slice(0, 2) },
		ui: {
			notify: () => {},
			select: async (title: string) => {
				titles.push(title);
				const next = choices.shift();
				return next ? next.promise : undefined;
			},
		},
	} as unknown as ExtensionContext;

	const first = promptModelAssignment(ctx, {
		role: "scout",
		proposed: "deepseek-v4-flash",
		thinkingLevel: "low",
	});
	const second = promptModelAssignment(ctx, { role: "worker", proposed: "claude-opus-4-5" });

	await setImmediate();
	assert.equal(titles.length, 1);
	assert.match(titles[0], /scout/);
	assert.match(titles[0], /Thinking: low/);

	firstChoice.resolve(`${formatModelLabel(MODELS[0])}  ← orchestrator's pick`);
	assert.deepEqual(await first, {
		outcome: "assigned",
		model: MODELS[0],
	} satisfies ModelAssignment);

	await setImmediate();
	assert.equal(titles.length, 2);
	assert.match(titles[1], /worker/);

	secondChoice.resolve(`${formatModelLabel(MODELS[1])}  ← orchestrator's pick`);
	assert.deepEqual(await second, {
		outcome: "assigned",
		model: MODELS[1],
	} satisfies ModelAssignment);
});

// Regression: quest_assign_ladder's confirm() used to bypass the prompt queue,
// so when dispatched alongside quest_assign_model in one model response its
// overlay was orphaned and the turn hung on "Working…". Both prompt kinds must
// share one queue: the confirm must wait behind the in-flight assignment.
test("enqueueUiPrompt serializes a confirm behind a model-assignment prompt", async () => {
	const assignChoice = deferred<string | undefined>();
	const confirmAnswer = deferred<boolean>();
	const order: string[] = [];

	const ctx = {
		hasUI: false,
		modelRegistry: { getAvailable: () => MODELS.slice(0, 2) },
		ui: {
			notify: () => {},
			select: async () => {
				order.push("assign:start");
				return assignChoice.promise;
			},
			confirm: async () => {
				order.push("confirm:start");
				return confirmAnswer.promise;
			},
		},
	} as unknown as ExtensionContext;

	const assign = promptModelAssignment(ctx, { role: "worker", proposed: "deepseek-v4-flash" });
	// Mirrors register-delegate's ladder confirm going through the shared queue.
	const confirm = enqueueUiPrompt(() =>
		(ctx.ui as unknown as { confirm: () => Promise<boolean> }).confirm(),
	);

	await setImmediate();
	// The confirm must not have opened while the assignment is still in flight.
	assert.deepEqual(order, ["assign:start"]);

	assignChoice.resolve(`${formatModelLabel(MODELS[0])}  ← orchestrator's pick`);
	await assign;
	await setImmediate();
	assert.deepEqual(order, ["assign:start", "confirm:start"]);

	confirmAnswer.resolve(true);
	assert.equal(await confirm, true);
});
