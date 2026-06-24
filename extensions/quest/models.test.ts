import { test } from "node:test";
import assert from "node:assert/strict";
import { matchModel, formatModelLabel, toModelLike, type ModelLike } from "./models";

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
