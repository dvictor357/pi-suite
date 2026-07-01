import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { FORMAT_DIRECTIVE, FORMAT_DIRECTIVE_COMPACT, formatDirectiveFor } from "./constants";

describe("formatDirectiveFor", () => {
	test("the compact directive is materially shorter than the full one", () => {
		assert.ok(
			FORMAT_DIRECTIVE_COMPACT.length < FORMAT_DIRECTIVE.length / 2,
			`compact ${FORMAT_DIRECTIVE_COMPACT.length} vs full ${FORMAT_DIRECTIVE.length}`,
		);
	});

	test("large / unknown models get the full directive", () => {
		assert.equal(formatDirectiveFor(undefined), FORMAT_DIRECTIVE);
		assert.equal(
			formatDirectiveFor({ id: "claude-opus-4-8", contextWindow: 200000 }),
			FORMAT_DIRECTIVE,
		);
	});

	test("constrained (small or low-context) models get the compact directive", () => {
		assert.equal(formatDirectiveFor({ id: "claude-haiku-4-5" }), FORMAT_DIRECTIVE_COMPACT);
		assert.equal(
			formatDirectiveFor({ id: "local", contextWindow: 8192 }),
			FORMAT_DIRECTIVE_COMPACT,
		);
	});
});
