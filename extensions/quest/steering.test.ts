import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wasTurnAborted } from "./steering";

describe("wasTurnAborted", () => {
	test("true when the final assistant turn was aborted (Esc)", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", stopReason: "aborted", content: [] },
		];
		assert.equal(wasTurnAborted(messages), true);
	});

	test("false for a normally completed turn", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", stopReason: "stop", content: [] },
		];
		assert.equal(wasTurnAborted(messages), false);
	});

	test("false for a turn that ended on tool use", () => {
		assert.equal(wasTurnAborted([{ role: "assistant", stopReason: "toolUse" }]), false);
	});

	test("inspects the last assistant message, not trailing tool results", () => {
		const messages = [
			{ role: "assistant", stopReason: "aborted" },
			{ role: "toolResult", content: "…" },
		];
		assert.equal(wasTurnAborted(messages), true);
	});

	test("ignores non-assistant messages with no stopReason", () => {
		assert.equal(wasTurnAborted([{ role: "user", content: "hi" }]), false);
	});

	test("safe on empty / undefined input", () => {
		assert.equal(wasTurnAborted([]), false);
		assert.equal(wasTurnAborted(undefined), false);
	});
});
