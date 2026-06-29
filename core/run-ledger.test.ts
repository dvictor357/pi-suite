import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RunLedger, runLedgerPath, runsDir, type RunEvent } from "./run-ledger";
import { cwdHash } from "./hash";
import { setErrorSink } from "./fs";

const CWD = "/tmp/test-project-pi";
const SLUG = "my-quest";

describe("run-ledger", () => {
	const tmp = join(tmpdir(), `pi-suite-run-ledger-${process.pid}`);

	before(() => {
		mkdirSync(tmp, { recursive: true });
		setErrorSink(() => {});
	});

	after(() => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* cleanup */
		}
	});

	it("runLedgerPath builds the correct path", () => {
		const p = runLedgerPath(CWD, SLUG);
		assert.ok(p.endsWith(join("runs", SLUG, "run.jsonl")));
		assert.ok(p.includes(cwdHash(CWD)));
	});

	it("runsDir scopes by cwdHash", () => {
		const a = runsDir("/project-a");
		const b = runsDir("/project-b");
		assert.notStrictEqual(a, b);
	});

	it("writes a dir with a real cwd (skipped)", { skip: "needs real cwd" }, () => {
		// kept for documentation — real cwd needs dir to exist
	});

	it("RunLedger.record appends a JSON line", () => {
		// Use tmpdir so we own the output fully.
		const cwdBase = join(tmp, "test-cwd");
		const ledger = new RunLedger(cwdBase, "test-quest");

		const event: RunEvent = {
			kind: "task_start",
			taskIndex: 0,
			taskContent: "write tests",
			agent: "worker",
			model: "test-model",
			timestamp: 1700000000000,
		};
		ledger.record(event);
		ledger.record({ ...event, kind: "task_complete", taskIndex: 0, result: "all green" });

		const path = runLedgerPath(cwdBase, "test-quest");
		assert.ok(existsSync(path));

		const lines = readFileSync(path, "utf8").trim().split("\n");
		assert.strictEqual(lines.length, 2);

		const parsed1 = JSON.parse(lines[0]);
		assert.strictEqual(parsed1.kind, "task_start");
		assert.strictEqual(parsed1.taskContent, "write tests");

		const parsed2 = JSON.parse(lines[1]);
		assert.strictEqual(parsed2.kind, "task_complete");
		assert.strictEqual(parsed2.result, "all green");
	});

	it("RunLedger.record never throws on invalid paths", () => {
		const ledger = new RunLedger("/dev/null/nonexistent", "bad");
		// Should not throw
		ledger.record({ kind: "task_start", taskIndex: 0, taskContent: "x", agent: "x", timestamp: 1 });
	});
});
