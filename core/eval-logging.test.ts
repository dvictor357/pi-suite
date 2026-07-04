import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { createEvalLog, evalLogPath, type EvalEntry } from "./eval-logging";
import { cwdHash } from "./hash";
import { setErrorSink } from "./fs";

describe("eval-logging", () => {
	const tmp = join(tmpdir(), `pi-suite-eval-${process.pid}`);

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

	it("evalLogPath scopes by cwdHash and quest slug", () => {
		const p = evalLogPath("/some/project", "build-feature");
		assert.ok(p.includes("evals"));
		assert.ok(p.includes("build-feature"));
		assert.ok(p.includes(cwdHash("/some/project")));
	});

	it("createEvalLog appends a JSON line", () => {
		const cwdBase = join(tmp, "eval-test-cwd");
		const log = createEvalLog(cwdBase, "user-auth");

		const entry: EvalEntry = {
			quest: "Add user auth",
			questSlug: "user-auth",
			taskIndex: 0,
			taskContent: "Set up Passport.js",
			agent: "worker",
			model: "demo-model",
			status: "done",
			verified: true,
			verifyEvidence: "middleware tested, 3 routes covered",
			durationMs: 48000,
			tokensIn: 12000,
			tokensOut: 2300,
			attempts: 1,
			timestamp: 1700000000000,
		};
		log(entry);

		const path = evalLogPath(cwdBase, "user-auth");
		assert.ok(existsSync(path));

		const parsed = JSON.parse(readFileSync(path, "utf8").trim());
		assert.strictEqual(parsed.status, "done");
		assert.strictEqual(parsed.verified, true);
		assert.strictEqual(parsed.durationMs, 48000);
		assert.strictEqual(parsed.attempts, 1);
	});

	it("createEvalLog never throws on bad paths", () => {
		const log = createEvalLog("/dev/null/fake", "nope");
		log({
			quest: "x",
			questSlug: "x",
			taskIndex: 0,
			taskContent: "x",
			agent: "x",
			status: "done",
			verified: false,
			verifyEvidence: null,
			durationMs: 0,
			tokensIn: 0,
			tokensOut: 0,
			attempts: 0,
			timestamp: 0,
		});
	});
});
