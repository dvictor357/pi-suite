import { test } from "node:test";
import assert from "node:assert/strict";
import { asRecord, strArray, boolOr, numOr, strOr, optStr, optNum, oneOf } from "./coerce";

test("asRecord returns objects, {} for non-objects/arrays/null", () => {
	assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
	assert.deepEqual(asRecord([1, 2]), {});
	assert.deepEqual(asRecord(null), {});
	assert.deepEqual(asRecord("x"), {});
	assert.deepEqual(asRecord(undefined), {});
});

test("strArray keeps only string elements", () => {
	assert.deepEqual(strArray(["a", 1, "b", null, "c"]), ["a", "b", "c"]);
	assert.deepEqual(strArray("a"), []);
	assert.deepEqual(strArray(undefined), []);
});

test("boolOr / numOr fall back on wrong types", () => {
	assert.equal(boolOr(true, false), true);
	assert.equal(boolOr("true", false), false);
	assert.equal(numOr(5, 0), 5);
	assert.equal(numOr(Number.NaN, 7), 7);
	assert.equal(numOr("5", 7), 7);
});

test("strOr trims, falls back on empty/whitespace/non-string", () => {
	assert.equal(strOr("  hi ", "d"), "hi");
	assert.equal(strOr("   ", "d"), "d");
	assert.equal(strOr(42, "d"), "d");
});

test("optStr / optNum pass through valid values, else undefined", () => {
	assert.equal(optStr("x"), "x");
	assert.equal(optStr(""), "");
	assert.equal(optStr(1), undefined);
	assert.equal(optNum(3), 3);
	assert.equal(optNum(Number.POSITIVE_INFINITY), undefined);
	assert.equal(optNum("3"), undefined);
});

test("oneOf narrows membership", () => {
	const modes = ["none", "restricted", "isolated"] as const;
	assert.equal(oneOf("restricted", modes), true);
	assert.equal(oneOf("nope", modes), false);
	assert.equal(oneOf(3, modes), false);
});
