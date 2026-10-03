/**
 * Bench CLI.
 *
 *   npm run bench -- validate [--tasks a,b]          check every task is fail→pass (no API calls)
 *   npm run bench -- run [--arms plain,suite] [--tasks a,b] [--trials N]
 *                        [--model provider/id] [--thinking level] [--concurrency N]
 *                        [--real-tiers] [--share-auth] [--keep] [--dry-run]
 *   npm run bench -- report <results dir or .jsonl>
 *
 * `run` spends real API money: (#tasks × #arms × trials) agent runs.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ARMS, BENCH, PROMPT_FOOTER } from "./config";
import { usageFromJsonl } from "./events";
import { formatReport } from "./report";
import { populateAgentDir } from "./sandbox";
import { TASKS } from "./tasks";
import type { BenchArm, BenchResult, BenchTask } from "./types";
import {
	changedFiles,
	createWorkspace,
	gradeWorkspace,
	injectHiddenTests,
	runProcess,
	workspaceEnv,
} from "./workspace";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI = process.env.BENCH_PI || "pi";

function pickById<T extends { id: string }>(
	all: readonly T[],
	csv: string | undefined,
	kind: string,
) {
	if (!csv) return [...all];
	const ids = csv.split(",").map((s) => s.trim());
	const unknown = ids.filter((id) => !all.some((t) => t.id === id));
	if (unknown.length) {
		throw new Error(
			`Unknown ${kind}: ${unknown.join(", ")}. Known: ${all.map((t) => t.id).join(", ")}`,
		);
	}
	return all.filter((t) => ids.includes(t.id));
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// ── validate ────────────────────────────────────────────────────────────────

async function validate(tasks: BenchTask[]): Promise<boolean> {
	let ok = true;
	await pool(tasks, 4, async (task) => {
		const grade = async (rev: string) => {
			const root = mkdtempSync(join(tmpdir(), "pi-bench-validate-"));
			try {
				const ws = createWorkspace(REPO, rev, root);
				injectHiddenTests(REPO, task.commit, ws.dir, task.testFiles);
				return await gradeWorkspace(ws, task.testFiles, BENCH.gradeTimeoutMs);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		};
		const before = await grade(`${task.commit}^`);
		const after = await grade(task.commit);
		const good = !before.passed && after.passed;
		if (!good) ok = false;
		console.log(
			`${good ? "ok  " : "BAD "} ${task.id.padEnd(22)} base: ${before.testsPassed ?? "?"} pass / ${before.testsFailed ?? "?"} fail` +
				`   solution: ${after.testsPassed ?? "?"} pass / ${after.testsFailed ?? "?"} fail`,
		);
	});
	return ok;
}

// ── run ─────────────────────────────────────────────────────────────────────

interface RunOptions {
	tasks: BenchTask[];
	arms: BenchArm[];
	trials: number;
	model: string;
	thinking: string;
	concurrency: number;
	realTiers: boolean;
	shareAuth: boolean;
	keep: boolean;
	dryRun: boolean;
}

interface Job {
	task: BenchTask;
	arm: BenchArm;
	trial: number;
}

async function runOne(job: Job, opts: RunOptions, outDir: string): Promise<BenchResult> {
	const { task, arm, trial } = job;
	const runId = `${task.id}.${arm.id}.${trial}`;
	const root = mkdtempSync(join(tmpdir(), "pi-bench-"));
	const started = Date.now();
	const base: Omit<BenchResult, "durationMs" | "usage" | "grade" | "changedFiles"> = {
		runId,
		taskId: task.id,
		arm: arm.id,
		model: opts.model,
		thinking: opts.thinking,
		trial,
		agentExitCode: null,
		timedOut: false,
		timestamp: started,
	};
	try {
		const ws = createWorkspace(REPO, `${task.commit}^`, root);
		populateAgentDir(join(ws.home, ".pi", "agent"), arm, {
			suiteRoot: REPO,
			model: opts.model,
			thinking: opts.thinking,
			realTiers: opts.realTiers,
			shareAuth: opts.shareAuth,
		});
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-approve",
			"--model",
			opts.model,
			"--thinking",
			opts.thinking,
			...(arm.suite ? [] : ["--no-extensions"]),
			(arm.promptPrefix ?? "") + task.prompt + "\n" + PROMPT_FOOTER,
		];
		const agent = await runProcess(PI, args, {
			cwd: ws.dir,
			env: workspaceEnv(ws),
			timeoutMs: BENCH.agentTimeoutMs,
		});
		const durationMs = Date.now() - started;
		writeFileSync(join(outDir, "transcripts", `${runId}.jsonl`), agent.stdout);
		if (agent.stderr.trim()) {
			writeFileSync(join(outDir, "transcripts", `${runId}.stderr.txt`), agent.stderr);
		}
		const changed = changedFiles(ws.dir);
		injectHiddenTests(REPO, task.commit, ws.dir, task.testFiles);
		const grade = await gradeWorkspace(ws, task.testFiles, BENCH.gradeTimeoutMs);
		writeFileSync(join(outDir, "transcripts", `${runId}.grade.txt`), grade.output);
		const { output: _output, ...gradeResult } = grade;
		const usage = usageFromJsonl(agent.stdout);
		// An agent that never produced a turn didn't attempt the task (bad flag,
		// extension load failure, auth): a harness problem, not a failed attempt.
		const harnessError =
			usage.turns === 0 && !agent.timedOut
				? `agent produced no turns (exit ${agent.exitCode}): ${agent.stderr.trim().split("\n")[0] ?? ""}`
				: undefined;
		return {
			...base,
			agentExitCode: agent.exitCode,
			timedOut: agent.timedOut,
			durationMs,
			usage,
			grade: gradeResult,
			changedFiles: changed,
			...(harnessError ? { harnessError } : {}),
		};
	} catch (err) {
		return {
			...base,
			durationMs: Date.now() - started,
			usage: usageFromJsonl(""),
			grade: { passed: false, testsPassed: null, testsFailed: null, exitCode: null },
			changedFiles: [],
			harnessError: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (opts.keep) console.log(`  kept ${runId}: ${root}`);
		else rmSync(root, { recursive: true, force: true });
	}
}

async function run(opts: RunOptions): Promise<void> {
	const jobs: Job[] = [];
	for (let trial = 1; trial <= opts.trials; trial++) {
		for (const task of opts.tasks) for (const arm of opts.arms) jobs.push({ task, arm, trial });
	}
	console.log(
		`${jobs.length} runs: ${opts.tasks.length} tasks × ${opts.arms.length} arms × ${opts.trials} trials` +
			` on ${opts.model}:${opts.thinking}${opts.realTiers ? " (real sub-agent tiers)" : ""}`,
	);
	if (opts.dryRun) {
		for (const j of jobs) console.log(`  ${j.task.id} · ${j.arm.id} · trial ${j.trial}`);
		return;
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = join(REPO, "bench", "results", stamp);
	mkdirSync(join(outDir, "transcripts"), { recursive: true });
	const resultsPath = join(outDir, "results.jsonl");
	const results: BenchResult[] = [];
	let done = 0;
	await pool(jobs, opts.concurrency, async (job) => {
		const r = await runOne(job, opts, outDir);
		results.push(r);
		appendFileSync(resultsPath, JSON.stringify(r) + "\n");
		done++;
		const verdict = r.harnessError
			? `HARNESS ERROR ${r.harnessError}`
			: `${r.grade.passed ? "PASS" : "fail"} ${r.grade.testsPassed ?? "?"}/${(r.grade.testsPassed ?? 0) + (r.grade.testsFailed ?? 0)} tests` +
				` $${r.usage.cost.toFixed(4)} ${Math.round(r.durationMs / 1000)}s${r.timedOut ? " TIMEOUT" : ""}`;
		console.log(`[${done}/${jobs.length}] ${r.runId}: ${verdict}`);
	});
	const report = formatReport(results);
	writeFileSync(join(outDir, "report.md"), report + "\n");
	console.log("\n" + report + `\n\nResults: ${resultsPath}`);
}

// ── report ──────────────────────────────────────────────────────────────────

function loadResults(path: string): BenchResult[] {
	const file = existsSync(join(path, "results.jsonl")) ? join(path, "results.jsonl") : path;
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as BenchResult);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			tasks: { type: "string" },
			arms: { type: "string" },
			trials: { type: "string" },
			model: { type: "string" },
			thinking: { type: "string" },
			concurrency: { type: "string" },
			"real-tiers": { type: "boolean" },
			"share-auth": { type: "boolean" },
			keep: { type: "boolean" },
			"dry-run": { type: "boolean" },
		},
	});
	const [command, target] = positionals;
	const tasks = pickById(TASKS, values.tasks, "task");

	if (command === "validate") return (await validate(tasks)) ? 0 : 1;
	if (command === "report") {
		if (!target) throw new Error("Usage: bench report <results dir or results.jsonl>");
		console.log(formatReport(loadResults(target)));
		return 0;
	}
	if (command === "run") {
		const int = (v: string | undefined, fallback: number, name: string) => {
			if (v == null) return fallback;
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1)
				throw new Error(`--${name} must be a positive integer, got "${v}"`);
			return n;
		};
		await run({
			tasks,
			arms: pickById(ARMS, values.arms, "arm"),
			trials: int(values.trials, BENCH.trials, "trials"),
			model: values.model ?? BENCH.model,
			thinking: values.thinking ?? BENCH.thinking,
			concurrency: int(values.concurrency, BENCH.concurrency, "concurrency"),
			realTiers: values["real-tiers"] ?? false,
			shareAuth: values["share-auth"] ?? false,
			keep: values.keep ?? false,
			dryRun: values["dry-run"] ?? false,
		});
		return 0;
	}
	console.error("Usage: bench <validate|run|report> [options] — see bench/README.md");
	return 2;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	},
);
