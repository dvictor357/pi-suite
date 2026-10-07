import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageFromJsonl } from "./events";
import { formatReport } from "./report";
import {
	assertAuthUsable,
	pickAuth,
	populateAgentDir,
	providersUsed,
	sandboxSettings,
} from "./sandbox";
import { aggregate, armKey, median, pairedCompare, spendSplit, wilson } from "./stats";
import { TASKS } from "./tasks";
import type { BenchResult } from "./types";
import { descendantPids, parseTapCounts, runProcess, stripNodeModulesBin } from "./workspace";

const assistant = (usage: object, content: object[] = []) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", usage, content } });

test("usageFromJsonl sums assistant turns, tool calls, and sub-agent usage from both delegation paths", () => {
	const stream = [
		JSON.stringify({ type: "session", id: "x" }),
		JSON.stringify({ type: "message_end", message: { role: "user", content: "hi" } }),
		assistant({ input: 100, output: 10, cacheRead: 50, cost: { total: 0.01 } }, [
			{ type: "toolCall", name: "bash" },
			{ type: "toolCall", name: "subagent" },
		]),
		"not json",
		JSON.stringify({
			type: "tool_execution_end",
			toolName: "subagent",
			result: {
				details: {
					results: [
						{ agent: "worker", usage: { input: 1000, output: 100, cost: 0.02 } },
						{ agent: "verifier", usage: { input: 500, output: 50, cost: 0.01 } },
					],
				},
			},
		}),
		JSON.stringify({
			type: "tool_execution_end",
			toolName: "quest_delegate",
			result: {
				details: { ok: true, role: "worker", usage: { input: 300, output: 30, cost: 0.005 } },
			},
		}),
		JSON.stringify({
			type: "tool_execution_start",
			toolName: "quest_create",
			args: { complexity: "simple" },
		}),
		JSON.stringify({
			type: "tool_execution_end",
			toolName: "quest_plan",
			result: {
				content: [{ type: "text", text: "Plan saved. Tier raised simple → medium: 4 steps." }],
			},
		}),
		assistant({ input: 200, output: 20, cost: { total: 0.02 } }, [
			{ type: "toolCall", name: "bash" },
		]) + "\r",
		"",
	].join("\n");
	const u = usageFromJsonl(stream);
	assert.equal(u.turns, 2);
	assert.equal(u.input, 2100);
	assert.equal(u.output, 210);
	assert.equal(u.cacheRead, 50);
	assert.ok(Math.abs(u.cost - 0.065) < 1e-12);
	assert.equal(u.subagentRuns, 3);
	assert.ok(Math.abs(u.subagentCost - 0.035) < 1e-12);
	assert.deepEqual(u.toolCalls, { bash: 2, subagent: 1 });
	assert.ok(Math.abs(u.subagentCostByRole!.worker - 0.025) < 1e-12);
	assert.equal(u.subagentCostByRole!.verifier, 0.01);
	assert.equal(u.questTier, "medium", "quest_plan's raise overrides the declared tier");
});

test("spendSplit separates parent from sub-agent roles and tolerates rows without roles", () => {
	const withRoles = result({});
	withRoles.usage = {
		...withRoles.usage,
		cost: 0.5,
		subagentCost: 0.3,
		subagentCostByRole: { worker: 0.2, verifier: 0.1 },
		questTier: "complex",
	};
	const legacy = result({});
	legacy.usage = { ...legacy.usage, cost: 0.2, subagentCost: 0.05 };
	const split = spendSplit([withRoles, legacy]);
	assert.ok(Math.abs(split.parent - 0.35) < 1e-12);
	assert.deepEqual(Object.keys(split.byRole).sort(), ["unknown", "verifier", "worker"]);
	assert.equal(split.byRole.unknown, 0.05);
	assert.deepEqual(split.tiers, { complex: 1 });
});

test("usageFromJsonl keeps U+2028 inside a record", () => {
	const line = assistant({ input: 1, cost: { total: 0 } }, [{ type: "text", text: "a b" }]);
	assert.equal(usageFromJsonl(line).turns, 1);
});

test("wilson interval brackets the point estimate and handles edges", () => {
	assert.deepEqual(wilson(0, 0), [0, 0]);
	const [lo, hi] = wilson(5, 10);
	assert.ok(lo < 0.5 && hi > 0.5);
	assert.ok(Math.abs(lo - 0.2366) < 1e-3 && Math.abs(hi - 0.7634) < 1e-3);
	assert.equal(wilson(3, 3)[1], 1);
	assert.equal(wilson(0, 3)[0], 0);
});

test("median handles odd, even, and empty input", () => {
	assert.equal(median([]), 0);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("parseTapCounts reads node's TAP summary", () => {
	const tap = "TAP version 13\nok 1 - a\n# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n";
	assert.deepEqual(parseTapCounts(tap), { passed: 2, failed: 1 });
	assert.deepEqual(parseTapCounts("garbage"), { passed: null, failed: null });
});

const result = (over: Partial<BenchResult>): BenchResult => ({
	runId: "r",
	taskId: "t1",
	arm: "plain",
	model: "m",
	thinking: "high",
	trial: 1,
	agentExitCode: 0,
	timedOut: false,
	durationMs: 1000,
	usage: {
		input: 100,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.1,
		turns: 1,
		subagentRuns: 0,
		subagentCost: 0,
		toolCalls: {},
	},
	grade: { passed: true, testsPassed: 1, testsFailed: 0, exitCode: 0 },
	changedFiles: [],
	timestamp: 0,
	...over,
});
const fail = { passed: false, testsPassed: 0, testsFailed: 1, exitCode: 1 };

test("aggregate charges failed runs' spend to cost per pass", () => {
	const a = aggregate([result({}), result({ grade: fail })]);
	assert.equal(a.passes, 1);
	assert.equal(a.passRate, 0.5);
	assert.ok(Math.abs(a.costPerPass! - 0.2) < 1e-12);
	assert.equal(aggregate([result({ grade: fail })]).costPerPass, null);
});

test("a timed-out pass stays a correctness pass but is not an autonomous success", () => {
	const a = aggregate([
		result({ durationMs: 1000 }),
		result({ timedOut: true, agentExitCode: null, durationMs: 9000 }),
		result({ grade: fail }),
	]);
	assert.equal(a.passes, 2);
	assert.equal(a.timeouts, 1);
	assert.equal(a.autonomous, 1);
	// All three runs' spend is charged to the single autonomous success.
	assert.ok(Math.abs(a.costPerAutonomous! - 0.3) < 1e-12);
	assert.equal(a.medianAutonomousMs, 1000);

	const none = aggregate([result({ timedOut: true })]);
	assert.equal(none.autonomous, 0);
	assert.equal(none.costPerAutonomous, null);
	assert.equal(none.medianAutonomousMs, null);
});

test("pairedCompare counts per-task wins and skips unshared tasks", () => {
	const rows = [
		result({ taskId: "t1", arm: "plain", grade: fail }),
		result({ taskId: "t1", arm: "suite" }),
		result({ taskId: "t2", arm: "plain" }),
		result({ taskId: "t2", arm: "suite" }),
		result({ taskId: "t3", arm: "suite" }),
	];
	const c = pairedCompare(rows, "plain · m:high", "suite · m:high");
	assert.deepEqual([c.tasks, c.aWins, c.bWins, c.ties], [2, 0, 1, 1]);
	assert.equal(c.meanDelta, 0.5);
});

test("formatReport excludes harness errors and compares arms", () => {
	const text = formatReport([
		result({ arm: "plain", grade: fail }),
		result({ arm: "suite" }),
		result({ arm: "suite", harnessError: "spawn pi ENOENT" }),
	]);
	assert.match(text, /2 scored runs over 1 tasks \(1 harness errors excluded\)/);
	assert.match(text, /CI = Wilson 95%/);
	assert.match(text, /\| suite · m:high \| 1\/1 \| 100% \|/);
	assert.match(text, /\| 0 \| 1\/1 \| \$0\.1000 \| 1s \|$/m);
	assert.match(text, /## Spend split/);
	assert.match(text, /\*\*suite · m:high\*\* vs \*\*plain · m:high\*\*: wins 1, loses 0/);
	assert.equal(formatReport([]), "No runs recorded.");
});

test("pickAuth keeps only the providers a run uses", () => {
	const auth = pickAuth(
		{ deepseek: { type: "api_key", key: "k" }, "openai-codex": { type: "oauth", refresh: "r" } },
		["openai-codex"],
	);
	assert.deepEqual(Object.keys(auth), ["openai-codex"]);
});

test("providersUsed covers the model and every sub-agent tier", () => {
	const opts = { suiteRoot: "/s", model: "openai-codex/gpt-6.1-sol", thinking: "low" };
	const real = { subagent: { models: { fast: "deepseek/deepseek-flash" } } };
	assert.deepEqual(providersUsed(opts, real), ["openai-codex"]);
	assert.deepEqual(providersUsed({ ...opts, realTiers: true }, real), ["deepseek", "openai-codex"]);
});

test("assertAuthUsable blocks providers, missing creds, and near-expiry OAuth", () => {
	const real = mkdtempSync(join(tmpdir(), "bench-auth-"));
	const now = 1_000_000_000_000;
	const write = (auth: object, settings: object = {}) => {
		writeFileSync(join(real, "auth.json"), JSON.stringify(auth));
		writeFileSync(join(real, "settings.json"), JSON.stringify(settings));
	};
	const opts = {
		realAgentDir: real,
		suiteRoot: "/s",
		model: "openai-codex/gpt-6.1-sol",
		thinking: "low",
	};
	const hour = 3_600_000;
	try {
		write({ "openai-codex": { type: "oauth", expires: now + 2 * hour } });
		assert.doesNotThrow(() => assertAuthUsable(opts, ["deepseek"], hour, now));
		assert.throws(() => assertAuthUsable(opts, ["deepseek"], 3 * hour, now), /expires in 120 min/);
		write({ "openai-codex": { type: "oauth", expires: (now - hour) / 1000 } });
		assert.throws(() => assertAuthUsable(opts, [], hour, now), /expired 60 min ago/);
		write({});
		assert.throws(() => assertAuthUsable(opts, [], hour, now), /No credentials/);
		write(
			{ "openai-codex": { type: "oauth", expires: now + 9 * hour }, deepseek: { type: "api_key" } },
			{ subagent: { models: { fast: "deepseek/deepseek-flash" } } },
		);
		assert.throws(
			() => assertAuthUsable({ ...opts, realTiers: true }, ["deepseek"], hour, now),
			/deepseek are blocked/,
		);
		assert.throws(
			() =>
				assertAuthUsable({ ...opts, model: "deepseek/deepseek-flash" }, ["deepseek"], hour, now),
			/blocked/,
		);
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

test("sandboxSettings pins every sub-agent tier and loads pi-suite only for suite arms", () => {
	const opts = { suiteRoot: "/suite", model: "deepseek/deepseek-flash", thinking: "high" };
	const real = { subagent: { models: { planning: "openai-codex/x" } }, packages: ["git:x"] };
	const plain = sandboxSettings({ id: "plain", description: "", suite: false }, opts, real);
	const suite = sandboxSettings({ id: "suite", description: "", suite: true }, opts, real);
	assert.deepEqual(plain.packages, []);
	assert.deepEqual(suite.packages, ["/suite"]);
	assert.equal(suite.defaultProvider, "deepseek");
	assert.equal(suite.defaultModel, "deepseek-flash");
	assert.deepEqual((suite.subagent as { models: object }).models, {
		fast: "deepseek/deepseek-flash",
		reasoning: "deepseek/deepseek-flash",
		planning: "deepseek/deepseek-flash",
	});
	const realTiers = sandboxSettings(
		{ id: "suite", description: "", suite: true },
		{ ...opts, realTiers: true },
		real,
	);
	assert.deepEqual(realTiers.subagent, real.subagent);
});

test("task manifest ids are unique and every task names test files", () => {
	assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
	for (const t of TASKS) {
		assert.ok(t.testFiles.length > 0, t.id);
		assert.ok(
			t.testFiles.every((f) => f.endsWith(".test.ts")),
			t.id,
		);
	}
});

test("stripNodeModulesBin drops npm-run bin dirs and keeps the rest", () => {
	assert.equal(
		stripNodeModulesBin("/repo/node_modules/.bin:/usr/bin:/a/node_modules/.bin:/opt/bin", ":"),
		"/usr/bin:/opt/bin",
	);
	assert.equal(stripNodeModulesBin(undefined, ":"), "");
});

test("populateAgentDir copies agents and only the run's credentials", () => {
	const real = mkdtempSync(join(tmpdir(), "bench-real-"));
	const sandbox = mkdtempSync(join(tmpdir(), "bench-sandbox-"));
	try {
		mkdirSync(join(real, "agents"));
		writeFileSync(join(real, "agents", "worker.md"), "original");
		writeFileSync(
			join(real, "auth.json"),
			JSON.stringify({ p: { type: "oauth" }, deepseek: { type: "api_key", key: "k" } }),
		);
		populateAgentDir(
			sandbox,
			{ id: "suite", description: "", suite: true },
			{ realAgentDir: real, suiteRoot: "/suite", model: "p/m", thinking: "high" },
		);
		assert.equal(lstatSync(join(sandbox, "agents")).isSymbolicLink(), false);
		assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(sandbox, "auth.json"), "utf8"))), [
			"p",
		]);
		writeFileSync(join(sandbox, "agents", "worker.md"), "edited by agent");
		assert.equal(readFileSync(join(real, "agents", "worker.md"), "utf8"), "original");
	} finally {
		rmSync(real, { recursive: true, force: true });
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("armKey labels suite arms with the pi-suite revision they loaded", () => {
	assert.equal(armKey({ arm: "plain", model: "m", thinking: "low" }), "plain · m:low");
	assert.equal(
		armKey({ arm: "quest", model: "m", thinking: "low", suiteRev: "abc1234" }),
		"quest@abc1234 · m:low",
	);
});

test("descendantPids walks the whole tree, not just direct children", () => {
	const table = ["  1   0", " 10   1", " 11  10", " 12  11", " 13  10", " 20   1", "garbage"].join(
		"\n",
	);
	assert.deepEqual(descendantPids(table, 10).sort(), [11, 12, 13]);
	assert.deepEqual(descendantPids(table, 99), []);
});

test("runProcess timeout kills a detached grandchild and returns promptly", async () => {
	// The child spawns a detached grandchild (own process group) that would
	// outlive a plain group kill, then both sleep far past the timeout.
	const script = `
		const { spawn } = require("node:child_process");
		const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });
		console.log("grandchild " + g.pid);
		setTimeout(() => {}, 60000);
	`;
	const started = Date.now();
	const out = await runProcess(process.execPath, ["-e", script], {
		cwd: tmpdir(),
		env: process.env,
		timeoutMs: 500,
	});
	assert.equal(out.timedOut, true);
	assert.ok(Date.now() - started < 10_000, "resolved without waiting for the grandchild");
	const pid = Number(out.stdout.match(/grandchild (\d+)/)?.[1]);
	assert.ok(pid > 0);
	await new Promise((r) => setTimeout(r, 200));
	assert.throws(() => process.kill(pid, 0), "grandchild was killed");
});

test("usageFromJsonl reports a provider error only when it ended the run", () => {
	const err = (msg: string) =>
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: msg, content: [] },
		});
	const ok = assistant({ input: 1, cost: { total: 0 } });
	assert.equal(
		usageFromJsonl([ok, err("Codex error: The usage limit has been reached")].join("\n"))
			.finalError,
		"Codex error: The usage limit has been reached",
	);
	assert.equal(usageFromJsonl([err("transient"), ok].join("\n")).finalError, undefined);
});
