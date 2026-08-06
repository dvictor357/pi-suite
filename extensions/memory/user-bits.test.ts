import test from "node:test";
import assert from "node:assert/strict";
import { buildUserPromptBits } from "./user-bits";
import type { UserMemory } from "../../core";

const user = (over: Partial<UserMemory>): UserMemory => ({
	communication: null,
	commitStyle: null,
	indent: null,
	quotes: null,
	preferredPackageManager: null,
	errorHandling: null,
	shell: null,
	conventions: [],
	facts: [],
	lastModified: 0,
	...over,
});

test("user with only communication set still yields prompt bits", () => {
	const bits = buildUserPromptBits(user({ communication: "Respond in English by default" }));
	assert.equal(bits.length, 1, "gate input: at least one bit");
	assert.match(bits[0], /Respond in English/);
});

test("shell and preferredPackageManager are injected", () => {
	const bits = buildUserPromptBits(
		user({ shell: "zsh", preferredPackageManager: "npm", commitStyle: "conventional" }),
	);
	assert.ok(bits.includes("shell: zsh"), "shell bit present");
	assert.ok(bits.includes("package manager: npm"), "package manager bit present");
	assert.ok(bits.includes("conventional commits"), "commit style bit present");
});

test("empty user yields no bits", () => {
	assert.deepEqual(buildUserPromptBits(user({})), []);
});

test("null-valued preferences do not render", () => {
	const bits = buildUserPromptBits(
		user({ communication: null, commitStyle: null, indent: null, shell: null }),
	);
	assert.deepEqual(bits, []);
});
