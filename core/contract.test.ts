import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, isFutureContract } from "./contract";

test("isFutureContract is true only when the blob's version exceeds the code's", () => {
	assert.equal(isFutureContract({ contractVersion: CONTRACT_VERSION + 1 }), true);
	assert.equal(
		isFutureContract({ contractVersion: CONTRACT_VERSION }),
		false,
		"same version is fine",
	);
	assert.equal(isFutureContract({ contractVersion: CONTRACT_VERSION - 1 }), false, "older is fine");
});

test("isFutureContract treats unversioned / empty / nullish blobs as not-future", () => {
	assert.equal(isFutureContract({}), false, "pre-versioning file is read & upgraded, not rejected");
	assert.equal(isFutureContract(null), false);
	assert.equal(isFutureContract(undefined), false);
	assert.equal(isFutureContract({ contractVersion: undefined }), false);
});
