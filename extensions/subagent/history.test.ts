import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatRunDetail,
	formatRunList,
	listRuns,
	loadRun,
	MAX_RUNS_PER_PROJECT,
	newRunId,
	planRerun,
	projectHistoryDir,
	type RecordedResult,
	type RunRecord,
	runStatus,
	saveRun,
} from "./history.js";
import { executeWithHistory } from "./index.js";

let root: string;
let savedAgentDir: string | undefined;
const cwd = "/work/project";

// Point pi's agent dir (settings.json, history) at an empty temp dir so the
// user's real ~/.pi/agent/settings.json can't change test behavior.
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-history-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});
afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function assistant(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

function result(task: string, ok: boolean, output = `out:${task}`): RecordedResult {
	return {
		agent: "worker",
		task,
		exitCode: ok ? 0 : 1,
		messages: ok ? [assistant(output)] : [],
		stderr: ok ? "" : "boom",
		errorMessage: ok ? undefined : "boom",
		usage: { cost: 0.01, input: 10, output: 5, turns: 1 },
	};
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 1,
		id: newRunId(),
		cwd,
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: 1000,
		mode: "single",
		status: "succeeded",
		params: { agent: "worker", task: "t" },
		outputText: "",
		results: [result("t", true)],
		...overrides,
	};
}

describe("history storage", () => {
	it("round-trips a run and loads it by unique prefix", () => {
		const r = record({ id: "abc123-0001" });
		const file = saveRun(r, root);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(loadRun(cwd, "abc1", root).id).toBe("abc123-0001");
		expect(listRuns(cwd, 20, root).map((x) => x.id)).toEqual(["abc123-0001"]);
	});

	it("keeps projects apart", () => {
		saveRun(record(), root);
		expect(listRuns("/other/project", 20, root)).toEqual([]);
		expect(projectHistoryDir(cwd, root)).not.toBe(projectHistoryDir("/other/project", root));
	});

	it("reports missing and ambiguous ids", () => {
		saveRun(record({ id: "aaa-1" }), root);
		saveRun(record({ id: "aaa-2" }), root);
		expect(() => loadRun(cwd, "zzz", root)).toThrow(/No subagent run/);
		expect(() => loadRun(cwd, "aaa", root)).toThrow(/ambiguous/);
		expect(() => loadRun(cwd, "  ", root)).toThrow(/No subagent run/);
	});

	it("lists newest first and prunes to the retention limit", () => {
		const base = Date.parse("2026-01-01T00:00:00Z");
		for (let i = 0; i < MAX_RUNS_PER_PROJECT + 5; i++)
			saveRun(record({ id: newRunId(base + i * 1000) }), root);
		const files = fs.readdirSync(projectHistoryDir(cwd, root));
		expect(files).toHaveLength(MAX_RUNS_PER_PROJECT);
		const listed = listRuns(cwd, 3, root);
		const newest = (base + (MAX_RUNS_PER_PROJECT + 4) * 1000).toString(36);
		expect(listed[0].id.startsWith(`${newest}-`)).toBe(true);
		expect(listed[0].id > listed[1].id).toBe(true);
		// The five oldest were pruned.
		expect(files.some((f) => f.startsWith(`${base.toString(36)}-`))).toBe(false);
	});

	it("truncates huge message text instead of storing it whole", () => {
		const big = "x".repeat(100_000);
		saveRun(record({ id: "big-1", results: [result("t", true, big)] }), root);
		const loaded = loadRun(cwd, "big-1", root);
		const part = loaded.results[0].messages[0].content[0] as { text: string };
		expect(part.text.length).toBeLessThan(20_000);
		expect(part.text).toMatch(/\[truncated \d+ chars\]$/);
	});

	it("skips unreadable files", () => {
		saveRun(record({ id: "good-1" }), root);
		fs.writeFileSync(path.join(projectHistoryDir(cwd, root), "bad-1.json"), "{");
		expect(listRuns(cwd, 20, root).map((r) => r.id)).toEqual(["good-1"]);
	});
});

describe("runStatus", () => {
	it("classifies results", () => {
		expect(runStatus([result("a", true)], false)).toBe("succeeded");
		expect(runStatus([result("a", true), result("b", false)], false)).toBe("partial");
		expect(runStatus([result("a", false)], false)).toBe("failed");
		expect(runStatus([result("a", true)], true)).toBe("aborted");
		expect(runStatus([{ ...result("a", true), stopReason: "budget" }], false)).toBe("failed");
	});
});

describe("planRerun", () => {
	it("keeps only failed parallel tasks and stored options", () => {
		const r = record({
			mode: "parallel",
			params: {
				retries: 1,
				maxCost: 2,
				tasks: [
					{ agent: "worker", task: "a" },
					{ agent: "worker", task: "b" },
					{ agent: "worker", task: "c" },
				],
			},
			results: [result("a", true), result("b", false), result("c", false)],
		});
		const plan = planRerun(r, "failed", { maxCost: 5, tasks: [] });
		if ("error" in plan) throw new Error(plan.error);
		expect(plan.params).toEqual({
			retries: 1,
			maxCost: 5, // override wins
			tasks: [
				{ agent: "worker", task: "b" },
				{ agent: "worker", task: "c" },
			], // mode fields are never overridden
		});
		expect(plan.summary).toMatch(/^2 of 3 parallel tasks/);
	});

	it("treats missing parallel results (aborted run) as unfinished", () => {
		const r = record({
			mode: "parallel",
			params: {
				tasks: [
					{ agent: "w", task: "a" },
					{ agent: "w", task: "b" },
				],
			},
			results: [result("a", true)],
		});
		const plan = planRerun(r, "failed");
		expect("params" in plan && plan.params.tasks).toEqual([{ agent: "w", task: "b" }]);
	});

	it("resumes a chain at the first failed step with the stored {previous}", () => {
		const r = record({
			mode: "chain",
			params: {
				chain: [
					{ agent: "scout", task: "find" },
					{ agent: "worker", task: "fix {previous}" },
					{ agent: "reviewer", task: "review {previous}" },
				],
			},
			results: [result("find", true, "FOUND"), result("fix FOUND", false)],
		});
		const plan = planRerun(r, "failed");
		if ("error" in plan) throw new Error(plan.error);
		expect(plan.params.chain).toEqual([
			{ agent: "worker", task: "fix FOUND" },
			{ agent: "reviewer", task: "review {previous}" },
		]);
		expect(plan.summary).toMatch(/^chain from step 2 of 3/);
	});

	it("resumes a chain that stopped early without a recorded failure", () => {
		const r = record({
			mode: "chain",
			params: {
				chain: [
					{ agent: "a", task: "one" },
					{ agent: "b", task: "two {previous}" },
				],
			},
			results: [result("one", true, "ONE")],
		});
		const plan = planRerun(r, "failed");
		expect("params" in plan && plan.params.chain).toEqual([{ agent: "b", task: "two ONE" }]);
	});

	it("re-runs only failed pipeline items", () => {
		const r = record({
			mode: "pipeline",
			params: { items: ["x", "y"], stages: [{ agent: "w", task: "{item}" }] },
			results: [result("x", false), result("y", true)],
		});
		const plan = planRerun(r, "failed");
		expect("params" in plan && plan.params).toEqual({
			items: ["x"],
			stages: [{ agent: "w", task: "{item}" }],
		});
	});

	it("refuses when nothing failed, unless scope is all", () => {
		const r = record();
		expect(planRerun(r, "failed")).toEqual({
			error: expect.stringMatching(/no failed work/),
		});
		const all = planRerun(r, "all");
		expect("params" in all && all.params).toEqual({
			agent: "worker",
			task: "t",
		});
	});
});

describe("formatting", () => {
	it("lists and details runs", () => {
		const r = record({
			id: "abc-1",
			mode: "parallel",
			status: "partial",
			results: [result("a", true), result("b", false)],
			rerunOf: "old-1",
		});
		const list = formatRunList([r], Date.parse(r.startedAt) + 120_000);
		expect(list).toMatch(
			/abc-1 +2m ago +parallel partial +1\/2 ok +worker +\$0\.0200 +\(rerun of old-1\)/,
		);
		const detail = formatRunDetail(r);
		expect(detail).toMatch(/#2 worker · failed/);
		expect(detail).toMatch(/boom/);
		expect(formatRunList([])).toMatch(/No subagent runs/);
	});
});

describe("executeWithHistory", () => {
	let savedArgv1: string;
	let fakePi: string;
	let workDir: string;

	beforeEach(() => {
		savedArgv1 = process.argv[1];
		workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-hist-cwd-")));
		fakePi = path.join(workDir, "fake-pi.mjs");
		// Stub child: tasks containing "fail" exit 1 once, then succeed (marker file).
		fs.writeFileSync(
			fakePi,
			`import * as fs from "node:fs";
const task = process.argv[process.argv.length - 1];
const marker = ${JSON.stringify(workDir)} + "/failed-once";
if (task.includes("hang")) setInterval(() => {}, 1000);
else if (task.includes("fail") && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, "");
  process.stderr.write("boom");
  process.exit(1);
}
else process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",
  content: [{ type: "text", text: "done " + task }], usage: { input: 1, output: 1, cost: { total: 0.01 } }, stopReason: "stop" } }) + "\\n");
`,
		);
		process.argv[1] = fakePi;
	});
	afterEach(() => {
		process.argv[1] = savedArgv1;
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	const ctx = () => ({ cwd: workDir, hasUI: false }) as any;
	const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? "";

	it("records a failed run and re-runs only the failed task", async () => {
		const first = await executeWithHistory(
			{
				tasks: [
					{ agent: "scout", task: "ok one" },
					{ agent: "scout", task: "will fail" },
				],
			},
			undefined,
			undefined,
			ctx(),
			root,
		);
		const id = text(first).match(/Run id: (\S+)\./)?.[1];
		expect(id).toBeDefined();
		const stored = loadRun(workDir, id!, root);
		expect(stored.status).toBe("partial");

		const second = await executeWithHistory(
			{ rerun: id!.slice(0, 6) },
			undefined,
			undefined,
			ctx(),
			root,
		);
		expect(text(second)).toMatch(/^Re-running 1 of 2 parallel tasks/);
		expect(text(second)).toMatch(/Parallel: 1\/1 succeeded/);
		expect(text(second)).toMatch(/done Task: will fail/);
		expect(text(second)).not.toMatch(/Run id:/);

		const runs = listRuns(workDir, 20, root);
		expect(runs).toHaveLength(2);
		expect(runs[0].rerunOf).toBe(id);
		expect(runs[0].status).toBe("succeeded");
	});

	it("rejects rerun combined with a mode, and unknown ids", async () => {
		const mixed = await executeWithHistory(
			{ rerun: "x", agent: "scout", task: "t" },
			undefined,
			undefined,
			ctx(),
			root,
		);
		expect(text(mixed)).toMatch(/cannot be combined/);
		const missing = await executeWithHistory({ rerun: "nope" }, undefined, undefined, ctx(), root);
		expect(text(missing)).toMatch(/No subagent run matching "nope"/);
	});

	it("records an aborted run so its unfinished work can be re-run", async () => {
		const controller = new AbortController();
		const pending = executeWithHistory(
			{
				tasks: [
					{ agent: "scout", task: "ok one" },
					{ agent: "scout", task: "hang forever" },
				],
			},
			controller.signal,
			undefined,
			ctx(),
			root,
		);
		setTimeout(() => controller.abort(), 300);
		await expect(pending).rejects.toThrow(/aborted/);
		const [run] = listRuns(workDir, 20, root);
		expect(run.status).toBe("aborted");
		const plan = planRerun(run, "failed");
		expect("params" in plan && plan.params.tasks).toEqual([
			{ agent: "scout", task: "hang forever" },
		]);
	}, 15000);

	it("does not record calls that ran nothing", async () => {
		await executeWithHistory({}, undefined, undefined, ctx(), root);
		expect(listRuns(workDir, 20, root)).toEqual([]);
	});
});

describe("/subagent command", () => {
	async function setup() {
		const { default: ext } = await import("./index.js");
		let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
		const sent: string[] = [];
		ext({
			registerTool() {},
			on() {},
			registerCommand(_name: string, opts: { handler: typeof handler }) {
				handler = opts.handler;
			},
			sendUserMessage(text: string) {
				sent.push(text);
			},
		} as any);
		const notes: Array<[string, string]> = [];
		const ctx = {
			cwd,
			ui: { notify: (msg: string, level: string) => notes.push([msg, level]) },
		};
		return { run: (args: string) => handler(args, ctx), notes, sent };
	}

	it("lists, shows, and asks the agent to re-run failed work", async () => {
		// The command uses the default historyRoot() → $PI_CODING_AGENT_DIR/subagent-runs.
		const histRoot = path.join(root, "agent", "subagent-runs");
		saveRun(
			record({
				id: "cmd-1",
				mode: "parallel",
				status: "partial",
				params: {
					tasks: [
						{ agent: "worker", task: "a" },
						{ agent: "worker", task: "b" },
					],
				},
				results: [result("a", true), result("b", false)],
			}),
			histRoot,
		);
		const { run, notes, sent } = await setup();

		await run("runs");
		expect(notes.pop()?.[0]).toMatch(/cmd-1 .* parallel partial/);

		await run("show cmd");
		expect(notes.pop()?.[0]).toMatch(/^Run cmd-1 · parallel · partial/);

		await run("rerun cmd-1");
		expect(sent).toEqual([
			'Re-run 1 of 2 parallel tasks from run cmd-1 by calling the subagent tool with {"rerun":"cmd-1"}, then report the results.',
		]);

		await run("rerun missing");
		expect(notes.pop()).toEqual([
			expect.stringMatching(/No subagent run matching "missing"/),
			"error",
		]);

		await run("show");
		expect(notes.pop()).toEqual(["Usage: /subagent show <run id>", "warning"]);
	});
});
