import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentsFromDir, type AgentConfig } from "./agents.js";
import {
	checkContract,
	contractInstructions,
	extractJson,
	substitutePrevious,
	validateOutput,
} from "./contract.js";
import { planRerun, type RunRecord } from "./history.js";
import {
	enforceOutputContract,
	executeWithHistory,
	runAgentWithRetry,
	type SingleResult,
	type SubagentDetails,
} from "./index.js";

const filesSchema = {
	type: "object",
	required: ["files", "count"],
	properties: {
		files: { type: "array", items: { type: "string" } },
		count: { type: "integer", minimum: 0 },
	},
	additionalProperties: false,
};

describe("extractJson", () => {
	it("prefers the last fenced block that parses", () => {
		const text = 'Plan:\n```json\n{"draft": true}\n```\nFinal:\n```json\n{"final": 1}\n```\n';
		expect(extractJson(text)).toEqual({ ok: true, value: { final: 1 } });
	});

	it("skips a broken last block for an earlier valid one", () => {
		const text = '```json\n{"a": 1}\n```\n```json\n{oops\n```';
		expect(extractJson(text)).toEqual({ ok: true, value: { a: 1 } });
	});

	it("accepts a bare JSON message and embedded JSON", () => {
		expect(extractJson("  [1, 2]  ")).toEqual({ ok: true, value: [1, 2] });
		expect(extractJson('Result: {"x": "y"} — done')).toEqual({
			ok: true,
			value: { x: "y" },
		});
	});

	it("reports empty and unparseable messages", () => {
		expect(extractJson("   ")).toEqual({
			ok: false,
			error: "final message is empty",
		});
		const bad = extractJson("no json here");
		expect(bad.ok).toBe(false);
	});
});

describe("validateOutput / checkContract", () => {
	it("returns no errors for a valid value", () => {
		expect(validateOutput(filesSchema, { files: ["a"], count: 1 })).toEqual([]);
	});

	it("lists errors with JSON pointer paths", () => {
		const errors = validateOutput(filesSchema, {
			files: [1],
			count: -1,
			extra: true,
		});
		expect(errors).toEqual(
			expect.arrayContaining([
				"/files/0: must be string",
				"/count: must be >= 0",
				"(root): must not have additional properties",
			]),
		);
	});

	it("combines extraction and validation", () => {
		expect(checkContract(filesSchema, '```json\n{"files":[],"count":0}\n```')).toEqual({
			ok: true,
			value: { files: [], count: 0 },
		});
		const missing = checkContract(filesSchema, '{"files":[]}');
		expect(missing.ok).toBe(false);
	});

	it("embeds the schema in the task instructions", () => {
		const text = contractInstructions(filesSchema);
		expect(text).toMatch(/OUTPUT CONTRACT/);
		expect(text).toContain('"additionalProperties": false');
	});
});

describe("substitutePrevious", () => {
	const structured = { files: ["a.ts", "b.ts"], meta: { owner: "me" } };

	it("fills {previous} with text and paths with values", () => {
		expect(
			substitutePrevious(
				"all={previous} first={previous.files.0} owner={previous.meta.owner} files={previous.files}",
				"TEXT",
				structured,
			),
		).toEqual({
			ok: true,
			text: 'all=TEXT first=a.ts owner=me files=["a.ts","b.ts"]',
		});
	});

	it("fails on missing paths and on paths without structured output", () => {
		expect(substitutePrevious("{previous.nope}", "", structured)).toEqual({
			ok: false,
			error: "{previous.nope}: path not found in the previous step's output",
		});
		expect(substitutePrevious("{previous.files.9}", "", structured).ok).toBe(false);
		expect(substitutePrevious("{previous.files}", "plain", undefined)).toEqual({
			ok: false,
			error: expect.stringMatching(/needs structured output/),
		});
	});

	it("does not treat inherited properties as fields", () => {
		expect(substitutePrevious("{previous.toString}", "", {}).ok).toBe(false);
	});
});

function textResult(text: string, cost = 0.01): SingleResult {
	return {
		agent: "worker",
		agentSource: "bundled",
		task: "t",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as never],
		stderr: "",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost,
			contextTokens: 15,
			turns: 1,
		},
	};
}

describe("enforceOutputContract", () => {
	it("accepts a valid answer without a repair run", async () => {
		let repairs = 0;
		const result = await enforceOutputContract(
			textResult('{"files":["a"],"count":1}'),
			filesSchema,
			"task",
			async () => {
				repairs++;
				return textResult("");
			},
		);
		expect(repairs).toBe(0);
		expect(result.structured).toEqual({ files: ["a"], count: 1 });
	});

	it("repairs once and merges usage", async () => {
		const tasks: string[] = [];
		const result = await enforceOutputContract(
			textResult("files are a and b"),
			filesSchema,
			"find files",
			async (task) => {
				tasks.push(task);
				return textResult('{"files":["a","b"],"count":2}', 0.002);
			},
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toContain("files are a and b");
		expect(tasks[0]).toContain("find files");
		expect(result.structured).toEqual({ files: ["a", "b"], count: 2 });
		expect(result.usage.turns).toBe(2);
		expect(result.usage.cost).toBeCloseTo(0.012);
		expect(result.messages).toHaveLength(2);
	});

	it("marks invalid_output when the repair is still wrong", async () => {
		const result = await enforceOutputContract(textResult("nope"), filesSchema, "t", async () =>
			textResult('{"files":"a"}'),
		);
		expect(result.stopReason).toBe("invalid_output");
		expect(result.structured).toBeUndefined();
		expect(result.errorMessage).toMatch(/\/files: must be array/);
	});

	it("marks invalid_output when the repair run itself fails", async () => {
		const result = await enforceOutputContract(textResult("nope"), filesSchema, "t", async () => ({
			...textResult(""),
			exitCode: 1,
			errorMessage: "boom",
		}));
		expect(result.stopReason).toBe("invalid_output");
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toMatch(/repair run failed: boom/);
	});
});

describe("agent frontmatter output", () => {
	it("parses a nested YAML schema and ignores non-mappings", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-agents-"));
		try {
			fs.writeFileSync(
				path.join(dir, "lister.md"),
				[
					"---",
					"name: lister",
					"description: lists files",
					"output:",
					"  type: object",
					"  required: [files]",
					"  properties:",
					"    files:",
					"      type: array",
					"      items: { type: string }",
					"---",
					"Prompt.",
				].join("\n"),
			);
			fs.writeFileSync(
				path.join(dir, "plain.md"),
				"---\nname: plain\ndescription: d\noutput: json\n---\nPrompt.",
			);
			const agents = loadAgentsFromDir(dir, "user");
			const lister = agents.find((a) => a.name === "lister");
			expect(lister?.output).toEqual({
				type: "object",
				required: ["files"],
				properties: { files: { type: "array", items: { type: "string" } } },
			});
			expect(agents.find((a) => a.name === "plain")?.output).toBeUndefined();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("planRerun with structured chain output", () => {
	it("resumes with {previous.path} filled from the stored value", () => {
		const record: RunRecord = {
			version: 1,
			id: "r-1",
			cwd: "/x",
			startedAt: "",
			finishedAt: "",
			durationMs: 0,
			mode: "chain",
			status: "partial",
			params: {
				chain: [
					{ agent: "scout", task: "list" },
					{ agent: "worker", task: "fix {previous.files.0}" },
				],
			},
			outputText: "",
			results: [
				{
					...textResult("ignored"),
					structured: { files: ["a.ts"] },
				},
				{ ...textResult(""), exitCode: 1 },
			],
		};
		const plan = planRerun(record, "failed");
		expect("params" in plan && plan.params.chain).toEqual([{ agent: "worker", task: "fix a.ts" }]);
	});
});

// ── Real spawns through a stub `pi` ─────────────────────────────────────────

describe("contracts end to end", () => {
	let savedArgv1: string;
	let savedAgentDir: string | undefined;
	let dir: string;

	beforeEach(() => {
		savedArgv1 = process.argv[1];
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-contract-")));
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		const stub = path.join(dir, "fake-pi.mjs");
		// Answers depend on markers in the task:
		//   EMIT_JSON  → valid JSON in a fenced block
		//   PROSE      → prose (invalid), but the repair run returns valid JSON
		//   HOPELESS   → invalid even when repairing
		//   otherwise  → echo the task's first line
		fs.writeFileSync(
			stub,
			`const task = process.argv[process.argv.length - 1];
const repairing = task.includes("does not satisfy its output contract");
let text;
if (task.includes("HOPELESS")) text = "still not json";
else if (task.includes("EMIT_JSON") || (repairing && task.includes("PROSE")))
  text = "Done.\\n\\n\`\`\`json\\n" + JSON.stringify({ files: ["a.ts", "b.ts"], count: 2 }) + "\\n\`\`\`";
else if (task.includes("PROSE")) text = "I found a.ts and b.ts.";
else text = "echo: " + task.split("\\n")[0];
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",
  content: [{ type: "text", text }], usage: { input: 1, output: 1, cost: { total: 0.001 } }, stopReason: "stop" } }) + "\\n");
`,
		);
		process.argv[1] = stub;
	});
	afterEach(() => {
		process.argv[1] = savedArgv1;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const agents: AgentConfig[] = [
		{
			name: "worker",
			description: "",
			systemPrompt: "",
			source: "bundled",
			filePath: "",
		},
	];
	const makeDetails = (results: SingleResult[]): SubagentDetails => ({
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		bundledAgentsDir: null,
		results,
	});
	const run = (task: string) =>
		runAgentWithRetry(
			dir,
			agents,
			"worker",
			task,
			undefined,
			{ output: filesSchema },
			undefined,
			undefined,
			undefined,
			makeDetails,
			0,
			10000,
		);

	it("validates a good answer and keeps the caller's task text", async () => {
		const result = await run("EMIT_JSON please");
		expect(result.structured).toEqual({ files: ["a.ts", "b.ts"], count: 2 });
		expect(result.task).toBe("EMIT_JSON please");
		expect(result.usage.turns).toBe(1);
	});

	it("repairs a prose answer with one extra run", async () => {
		const result = await run("PROSE please");
		expect(result.stopReason).toBe("stop");
		expect(result.structured).toEqual({ files: ["a.ts", "b.ts"], count: 2 });
		expect(result.usage.turns).toBe(2);
	});

	it("fails as invalid_output when repair does not help", async () => {
		const result = await run("HOPELESS");
		expect(result.stopReason).toBe("invalid_output");
		expect(result.usage.turns).toBe(2);
	});

	it("pipes structured fields between chain steps", async () => {
		const ctx = { cwd: dir, hasUI: false } as never;
		const out = await executeWithHistory(
			{
				chain: [
					{
						agent: "worker",
						task: "EMIT_JSON list files",
						output: filesSchema,
					},
					{
						agent: "worker",
						task: "fix {previous.files.1} (count {previous.count})",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const first = out.content[0];
		expect(first.type === "text" && first.text).toMatch(/^echo: Task: fix b\.ts \(count 2\)$/);
		expect(out.details.results[0].structured).toEqual({
			files: ["a.ts", "b.ts"],
			count: 2,
		});
	});

	it("fails a chain step whose path is missing, without spawning", async () => {
		const ctx = { cwd: dir, hasUI: false } as never;
		const out = await executeWithHistory(
			{
				chain: [
					{ agent: "worker", task: "EMIT_JSON", output: filesSchema },
					{ agent: "worker", task: "use {previous.owner}" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const first = out.content[0];
		expect(first.type === "text" && first.text).toMatch(
			/Chain stopped at step 2 \(worker\): \{previous\.owner\}: path not found/,
		);
		expect(out.details.results[1].usage.turns).toBe(0);
	});

	it("returns pretty JSON as the single-mode answer", async () => {
		const ctx = { cwd: dir, hasUI: false } as never;
		const out = await executeWithHistory(
			{ agent: "worker", task: "EMIT_JSON", output: filesSchema },
			undefined,
			undefined,
			ctx,
		);
		const first = out.content[0];
		expect(first.type === "text" && JSON.parse(first.text)).toEqual({
			files: ["a.ts", "b.ts"],
			count: 2,
		});
	});
});
