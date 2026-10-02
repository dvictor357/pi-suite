import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents.js";
import { prepareIsolation, runIsolated, type SingleResult } from "./index.js";
import {
	createWorktree,
	finalizeWorktree,
	findRepoRoot,
	formatWorktreeOutcome,
	mapCwdIntoWorktree,
	worktreeBranchName,
} from "./worktree.js";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-wt-test-")));
	tempDirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "commit.gpgsign", "false");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function branches(repo: string): string[] {
	return git(repo, "branch", "--list", "pi-minions/*", "--format=%(refname:short)")
		.split("\n")
		.filter(Boolean);
}

function okResult(agent: string, task: string): SingleResult {
	return {
		agent,
		agentSource: "bundled",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};
}

const agents: AgentConfig[] = [
	{
		name: "worker",
		description: "",
		systemPrompt: "",
		source: "bundled",
		filePath: "",
	},
	{
		name: "looker",
		description: "",
		tools: ["read", "ls"],
		systemPrompt: "",
		source: "bundled",
		filePath: "",
	},
];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("worktree helpers", () => {
	it("finds the repo root and returns null outside a repo", async () => {
		const repo = makeRepo();
		expect(await findRepoRoot(path.join(repo, "src"))).toBe(repo);
		const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-norepo-")));
		tempDirs.push(outside);
		expect(await findRepoRoot(outside)).toBeNull();
	});

	it("sanitizes agent names in branch names", () => {
		expect(worktreeBranchName("abc123", 0, "My Agent!")).toBe("pi-minions/abc123/1-my-agent");
		expect(worktreeBranchName("abc123", 2, "...")).toBe("pi-minions/abc123/3-agent");
	});

	it("maps a task cwd into the worktree and rejects paths outside the repo", () => {
		const repo = makeRepo();
		expect(mapCwdIntoWorktree(repo, "/wt", repo, "src")).toBe(path.join("/wt", "src"));
		expect(mapCwdIntoWorktree(repo, "/wt", repo, undefined)).toBe("/wt");
		expect(() => mapCwdIntoWorktree(repo, "/wt", repo, "..")).toThrow(/outside repo/);
	});

	it("commits changes to the branch and removes the checkout", async () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		const handle = await createWorktree(repo, base, "pi-minions/t1/1-worker");
		fs.writeFileSync(path.join(handle.path, "src", "b.ts"), "export {};\n");
		fs.writeFileSync(path.join(handle.path, "src", "a.ts"), "export const a = 2;\n");

		const outcome = await finalizeWorktree(handle, "test commit");

		expect(outcome.error).toBeUndefined();
		expect(outcome.branch).toBe("pi-minions/t1/1-worker");
		expect(outcome.filesChanged.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(outcome.diffStat).toMatch(/2 files changed/);
		expect(fs.existsSync(handle.path)).toBe(false);
		expect(git(repo, "show", "pi-minions/t1/1-worker:src/a.ts")).toBe("export const a = 2;");
		// Main checkout is untouched.
		expect(fs.readFileSync(path.join(repo, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
	});

	it("deletes the branch when nothing changed", async () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		const handle = await createWorktree(repo, base, "pi-minions/t2/1-worker");
		const outcome = await finalizeWorktree(handle, "noop");
		expect(outcome.branch).toBeUndefined();
		expect(outcome.filesChanged).toEqual([]);
		expect(branches(repo)).toEqual([]);
		expect(formatWorktreeOutcome(outcome)).toBe("**Worktree:** no changes.");
	});

	it("keeps commits the agent made itself", async () => {
		const repo = makeRepo();
		const base = git(repo, "rev-parse", "HEAD");
		const handle = await createWorktree(repo, base, "pi-minions/t3/1-worker");
		fs.writeFileSync(path.join(handle.path, "c.txt"), "c\n");
		git(handle.path, "add", "c.txt");
		git(handle.path, "commit", "-q", "-m", "agent commit");
		const outcome = await finalizeWorktree(handle, "unused");
		expect(outcome.filesChanged).toEqual(["c.txt"]);
		expect(git(repo, "log", "-1", "--format=%s", outcome.branch!)).toBe("agent commit");
	});

	it("links node_modules without committing the link", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-q", "-m", "ignore");
		fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
		const base = git(repo, "rev-parse", "HEAD");

		const handle = await createWorktree(repo, base, "pi-minions/t4/1-worker");
		expect(handle.linkedNodeModules).toBe(true);
		expect(fs.existsSync(path.join(handle.path, "node_modules", "dep"))).toBe(true);
		fs.writeFileSync(path.join(handle.path, "x.txt"), "x\n");

		const outcome = await finalizeWorktree(handle, "with deps");
		expect(outcome.filesChanged).toEqual(["x.txt"]);
		// Removing the worktree must not follow the link into the real deps.
		expect(fs.existsSync(path.join(repo, "node_modules", "dep"))).toBe(true);
	});
});

describe("prepareIsolation", () => {
	it("rejects a non-repo cwd", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-norepo-")));
		tempDirs.push(dir);
		const prepared = await prepareIsolation(dir);
		expect("error" in prepared && prepared.error).toMatch(/requires a git repository/);
	});

	it("rejects a repo with no commits", async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-empty-")));
		tempDirs.push(dir);
		git(dir, "init", "-q");
		const prepared = await prepareIsolation(dir);
		expect("error" in prepared && prepared.error).toMatch(/no commits/);
	});

	it("reports a dirty main checkout", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
		const prepared = await prepareIsolation(repo);
		expect("context" in prepared && prepared.dirty).toBe(true);
	});
});

describe("runIsolated", () => {
	it("runs writer agents in parallel worktrees on separate branches", async () => {
		const repo = makeRepo();
		const prepared = await prepareIsolation(repo);
		if ("error" in prepared) throw new Error(prepared.error);
		const isolation = prepared.context;

		const cwds: string[] = [];
		const results = await Promise.all(
			[0, 1].map((index) =>
				runIsolated(
					isolation,
					index,
					agents,
					"worker",
					`task ${index}`,
					repo,
					"src",
					async (cwd) => {
						cwds.push(cwd!);
						// Both tasks edit the same file — safe because each has its own checkout.
						fs.writeFileSync(path.join(cwd!, "a.ts"), `export const a = ${index + 10};\n`);
						return okResult("worker", `task ${index}`);
					},
				),
			),
		);

		expect(new Set(cwds).size).toBe(2);
		for (const cwd of cwds) {
			expect(cwd.endsWith(`${path.sep}src`)).toBe(true);
			expect(cwd.startsWith(repo)).toBe(false);
		}
		expect(branches(repo).sort()).toEqual([
			`pi-minions/${isolation.runId}/1-worker`,
			`pi-minions/${isolation.runId}/2-worker`,
		]);
		expect(results.map((r) => r.worktree?.filesChanged)).toEqual([["src/a.ts"], ["src/a.ts"]]);
		expect(git(repo, "status", "--porcelain")).toBe("");
	});

	it("runs read-only agents in place without a worktree", async () => {
		const repo = makeRepo();
		const prepared = await prepareIsolation(repo);
		if ("error" in prepared) throw new Error(prepared.error);
		for (const name of ["looker", "scout"]) {
			const result = await runIsolated(
				prepared.context,
				0,
				agents,
				name,
				"look",
				repo,
				undefined,
				async (cwd) => {
					expect(cwd).toBeUndefined();
					return okResult(name, "look");
				},
			);
			expect(result.worktree).toBeUndefined();
		}
		expect(branches(repo)).toEqual([]);
	});

	it("keeps partial work on a branch when the run throws", async () => {
		const repo = makeRepo();
		const prepared = await prepareIsolation(repo);
		if ("error" in prepared) throw new Error(prepared.error);
		await expect(
			runIsolated(prepared.context, 0, agents, "worker", "t", repo, undefined, async (cwd) => {
				fs.writeFileSync(path.join(cwd!, "partial.txt"), "p\n");
				throw new Error("Subagent was aborted");
			}),
		).rejects.toThrow("Subagent was aborted");
		expect(branches(repo)).toEqual([`pi-minions/${prepared.context.runId}/1-worker`]);
	});

	it("fails the task without creating a worktree when cwd escapes the repo", async () => {
		const repo = makeRepo();
		const prepared = await prepareIsolation(repo);
		if ("error" in prepared) throw new Error(prepared.error);
		let ran = false;
		const result = await runIsolated(
			prepared.context,
			0,
			agents,
			"worker",
			"t",
			repo,
			"..",
			async () => {
				ran = true;
				return okResult("worker", "t");
			},
		);
		expect(ran).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toMatch(/Worktree setup failed: .*outside repo/);
		expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
	});
});
