import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_RETRIES,
	MAX_BURST,
	MAX_VERIFY_RETRIES,
	MAX_DEPENDENCY_DEPTH,
	MAX_ESCALATIONS,
	DEFAULT_RETRY_POLICY,
} from "./retry-policy";

describe("retry-policy", () => {
	it("MAX_RETRIES is a positive integer", () => {
		assert.ok(Number.isInteger(MAX_RETRIES) && MAX_RETRIES > 0);
	});

	it("MAX_BURST is a positive integer >= MAX_RETRIES", () => {
		assert.ok(Number.isInteger(MAX_BURST) && MAX_BURST >= MAX_RETRIES);
	});

	it("MAX_VERIFY_RETRIES is a non-negative integer", () => {
		assert.ok(Number.isInteger(MAX_VERIFY_RETRIES) && MAX_VERIFY_RETRIES >= 0);
	});

	it("MAX_DEPENDENCY_DEPTH is a positive integer", () => {
		assert.ok(Number.isInteger(MAX_DEPENDENCY_DEPTH) && MAX_DEPENDENCY_DEPTH > 0);
	});

	it("MAX_ESCALATIONS is a non-negative integer", () => {
		assert.ok(Number.isInteger(MAX_ESCALATIONS) && MAX_ESCALATIONS >= 0);
	});

	it("DEFAULT_RETRY_POLICY matches the exported constants", () => {
		assert.strictEqual(DEFAULT_RETRY_POLICY.maxRetries, MAX_RETRIES);
		assert.strictEqual(DEFAULT_RETRY_POLICY.maxBurst, MAX_BURST);
		assert.strictEqual(DEFAULT_RETRY_POLICY.maxVerifyRetries, MAX_VERIFY_RETRIES);
		assert.strictEqual(DEFAULT_RETRY_POLICY.maxDependencyDepth, MAX_DEPENDENCY_DEPTH);
		assert.strictEqual(DEFAULT_RETRY_POLICY.maxEscalations, MAX_ESCALATIONS);
	});
});
