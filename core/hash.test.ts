import { test } from "node:test";
import assert from "node:assert/strict";
import { cwdHash } from "./hash";

// cwdHash is part of the cross-extension contract: all three extensions must
// produce the SAME hash for the same cwd, or they silently read/write different
// files for one project. These values are a regression lock — if they change,
// every extension's on-disk state is re-keyed and CONTRACT_VERSION must bump.
test("cwdHash is stable for known inputs (contract lock)", () => {
	assert.equal(cwdHash("/home/alice/project"), "9c2098df26004b24");
	assert.equal(cwdHash("/home/bob/project"), "a8cafb6759007a49");
	assert.equal(cwdHash(""), "e3b0c44298fc1c14");
});

test("cwdHash is deterministic and 16 hex chars", () => {
	const a = cwdHash("/some/path");
	const b = cwdHash("/some/path");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{16}$/);
});

test("cwdHash distinguishes different paths", () => {
	assert.notEqual(cwdHash("/a"), cwdHash("/b"));
});
