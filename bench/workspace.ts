/**
 * Per-run filesystem: a history-free snapshot of the task's base commit, a
 * throwaway HOME (whose `.pi/agent` is the agent dir), and hidden-test grading.
 *
 * The snapshot is `git archive`d and re-committed as a fresh one-commit repo,
 * so the agent cannot `git log`/`git show` its way to the real solution.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { GradeResult } from "./types";

export interface Workspace {
	/** The repo snapshot the agent works in. */
	dir: string;
	/** HOME for the agent and grader; `${home}/.pi/agent` is the agent dir. */
	home: string;
}

const git = (cwd: string, args: string[], input?: Buffer) =>
	execFileSync("git", args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });

/**
 * Snapshot `rev` of `repo` into `root/repo` as a fresh one-commit git repo.
 * `node_modules` is symlinked from the source repo (git-ignored in the snapshot).
 */
export function createWorkspace(repo: string, rev: string, root: string): Workspace {
	const dir = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const tar = git(repo, ["archive", "--format=tar", rev]);
	execFileSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 256 * 1024 * 1024 });
	git(dir, ["init", "-q", "-b", "main"]);
	appendFileSync(join(dir, ".git", "info", "exclude"), "node_modules\n");
	symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
	git(dir, ["add", "-A"]);
	git(dir, [
		"-c",
		"user.name=bench",
		"-c",
		"user.email=bench@localhost",
		"commit",
		"-q",
		"--no-verify",
		"-m",
		"base",
	]);
	return { dir, home };
}

/** Files changed in the snapshot since its base commit, including untracked ones. */
export function changedFiles(dir: string): string[] {
	const out = git(dir, ["status", "--porcelain", "-uall", "--no-renames"]).toString();
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3))
		.sort();
}

/** Overwrite the snapshot's test files with the versions from `rev` in `repo`. */
export function injectHiddenTests(repo: string, rev: string, dir: string, files: string[]): void {
	for (const file of files) {
		const content = git(repo, ["show", `${rev}:${file}`]);
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content);
	}
}

/** Parse the `# pass N` / `# fail N` summary lines a TAP reporter prints. */
export function parseTapCounts(tap: string): { passed: number | null; failed: number | null } {
	const count = (label: string) => {
		const m = tap.match(new RegExp(`^# ${label} (\\d+)\\s*$`, "m"));
		return m ? Number(m[1]) : null;
	};
	return { passed: count("pass"), failed: count("fail") };
}

/**
 * PATH without `node_modules/.bin` entries. `npm run` prepends them, which would
 * make the agent (and every sub-agent it spawns) the repo's dev copy of pi
 * instead of the installed one.
 */
export function stripNodeModulesBin(path: string | undefined, sep = delimiter): string {
	return (path ?? "")
		.split(sep)
		.filter((p) => p && !/[\\/]node_modules[\\/]\.bin$/.test(p))
		.join(sep);
}

/** Child env for anything run inside a workspace: HOME and the agent dir point into it. */
export function workspaceEnv(ws: Workspace, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: stripNodeModulesBin(process.env.PATH),
		HOME: ws.home,
		USERPROFILE: ws.home,
		PI_CODING_AGENT_DIR: join(ws.home, ".pi", "agent"),
		...extra,
	};
}

export interface ProcessOutcome {
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Run a command in its own process group so a timeout kills the whole tree
 * (an agent's sub-agents and test runners included).
 */
export function runProcess(
	command: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessOutcome> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: opts.cwd,
			env: opts.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		proc.stdout.on("data", (b: Buffer) => stdout.push(b));
		proc.stderr.on("data", (b: Buffer) => stderr.push(b));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				/* already gone */
			}
		}, opts.timeoutMs);
		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			resolve({
				exitCode: timedOut ? null : exitCode,
				timedOut,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			});
		};
		proc.on("error", (err) => {
			stderr.push(Buffer.from(String(err)));
			finish(null);
		});
		proc.on("close", (code) => finish(code));
	});
}

/** Run the hidden tests with node's test runner and TAP output. */
export async function gradeWorkspace(
	ws: Workspace,
	testFiles: string[],
	timeoutMs: number,
): Promise<GradeResult & { output: string }> {
	const out = await runProcess(
		process.execPath,
		["--import", "tsx", "--test", "--test-reporter=tap", ...testFiles],
		{ cwd: ws.dir, env: workspaceEnv(ws), timeoutMs },
	);
	const { passed, failed } = parseTapCounts(out.stdout);
	return {
		passed: out.exitCode === 0 && failed === 0 && (passed ?? 0) > 0,
		testsPassed: passed,
		testsFailed: failed,
		exitCode: out.exitCode,
		output: out.stdout + out.stderr,
	};
}
