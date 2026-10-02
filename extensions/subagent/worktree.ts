/**
 * Git worktree isolation for writer subagents.
 *
 * Each isolated task runs in its own `git worktree` checked out from the
 * caller's HEAD. When the task ends, any changes are committed to a dedicated
 * branch and the worktree directory is removed; the branch is the hand-off.
 * Tasks that change nothing leave no branch behind.
 *
 * Dependencies: Node built-ins and the `git` CLI.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Isolation = "none" | "worktree";

export interface WorktreeHandle {
	repoRoot: string;
	/** Absolute path of the worktree checkout. */
	path: string;
	branch: string;
	/** Commit the worktree was created from. */
	baseRef: string;
	/** True when the repo's node_modules was symlinked into the worktree. */
	linkedNodeModules: boolean;
}

export interface WorktreeOutcome {
	/** Branch holding the changes; undefined when nothing changed. */
	branch?: string;
	baseRef: string;
	filesChanged: string[];
	/** `git diff --shortstat` between baseRef and branch. */
	diffStat: string;
	/** Set when the worktree could not be finalized; the checkout is kept at `path`. */
	error?: string;
	path?: string;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code =
				error && typeof (error as { code?: unknown }).code === "number"
					? ((error as { code: number }).code as number)
					: error
						? 1
						: 0;
			resolve({
				code,
				stdout: String(stdout),
				stderr: String(stderr || error?.message || ""),
			});
		});
	});
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`,
		);
	}
	return result.stdout;
}

// Worktree add/remove touch shared repo metadata; serialize them per process.
let repoLock: Promise<unknown> = Promise.resolve();
function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
	const next = repoLock.then(fn, fn);
	repoLock = next.catch(() => undefined);
	return next;
}

/** Top-level directory of the git repo containing `cwd`, or null if not a repo. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	return fs.realpathSync(result.stdout.trim());
}

/** Resolve HEAD to a commit sha. Throws on a repo with no commits. */
export async function resolveHead(repoRoot: string): Promise<string> {
	const result = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
	if (result.code !== 0) {
		throw new Error(
			`cannot isolate in a worktree: ${repoRoot} has no commits yet (HEAD does not resolve)`,
		);
	}
	return result.stdout.trim();
}

/** True when the main checkout has uncommitted or untracked changes. */
export async function hasUncommittedChanges(repoRoot: string): Promise<boolean> {
	const result = await git(repoRoot, ["status", "--porcelain"]);
	return result.code === 0 && result.stdout.trim().length > 0;
}

export function worktreeBranchName(runId: string, index: number, agent: string): string {
	const safeAgent =
		agent
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "") || "agent";
	return `pi-minions/${runId}/${index + 1}-${safeAgent}`;
}

/**
 * Map the caller's intended cwd into the worktree. `taskCwd` (relative to
 * `defaultCwd`) must stay inside the repo; the equivalent subdirectory of the
 * worktree is returned.
 */
export function mapCwdIntoWorktree(
	repoRoot: string,
	worktreePath: string,
	defaultCwd: string,
	taskCwd: string | undefined,
): string {
	const target = path.resolve(defaultCwd, taskCwd ?? ".");
	const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
	const rel = path.relative(repoRoot, real);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(
			`cwd ${JSON.stringify(taskCwd ?? defaultCwd)} is outside repo ${repoRoot}; worktree isolation only covers paths inside the repo`,
		);
	}
	return path.join(worktreePath, rel);
}

export async function createWorktree(
	repoRoot: string,
	baseRef: string,
	branch: string,
): Promise<WorktreeHandle> {
	const parent = path.join(fs.realpathSync(os.tmpdir()), "pi-minions-worktrees");
	fs.mkdirSync(parent, { recursive: true });
	const dir = fs.mkdtempSync(path.join(parent, `${path.basename(repoRoot)}-`));
	// `git worktree add` wants to create the directory itself.
	fs.rmdirSync(dir);

	await withRepoLock(() =>
		gitOrThrow(repoRoot, ["worktree", "add", "-q", "-b", branch, dir, baseRef]),
	);

	// Let agents run builds/tests without a fresh install. Only link an
	// untracked node_modules, and never commit the link (see finalizeWorktree).
	let linkedNodeModules = false;
	const nodeModules = path.join(repoRoot, "node_modules");
	const target = path.join(dir, "node_modules");
	if (fs.existsSync(nodeModules) && !fs.existsSync(target)) {
		try {
			fs.symlinkSync(nodeModules, target, "junction");
			linkedNodeModules = true;
		} catch {
			/* agents can still install dependencies themselves */
		}
	}

	return { repoRoot, path: dir, branch, baseRef, linkedNodeModules };
}

async function removeWorktree(handle: WorktreeHandle): Promise<void> {
	await withRepoLock(async () => {
		await git(handle.repoRoot, ["worktree", "remove", "--force", handle.path]);
		if (fs.existsSync(handle.path)) {
			fs.rmSync(handle.path, { recursive: true, force: true });
			await git(handle.repoRoot, ["worktree", "prune"]);
		}
	});
}

/**
 * Commit whatever the agent left in the worktree onto its branch, then remove
 * the checkout. The branch is deleted when it ends up identical to baseRef.
 * On failure the checkout is kept so no work is lost.
 */
export async function finalizeWorktree(
	handle: WorktreeHandle,
	message: string,
): Promise<WorktreeOutcome> {
	const { path: dir, branch, baseRef } = handle;
	try {
		const addArgs = ["add", "-A", "--", "."];
		if (handle.linkedNodeModules) addArgs.push(":(exclude)node_modules");
		await gitOrThrow(dir, addArgs);

		const staged = await git(dir, ["diff", "--cached", "--quiet"]);
		if (staged.code === 1) {
			const identity = await git(dir, ["var", "GIT_COMMITTER_IDENT"]);
			const identityArgs =
				identity.code === 0
					? []
					: ["-c", "user.name=pi-minions", "-c", "user.email=pi-minions@localhost"];
			await gitOrThrow(dir, [...identityArgs, "commit", "-q", "--no-verify", "-m", message]);
		}

		// Covers both our commit and any commits the agent made itself.
		const names = await gitOrThrow(dir, ["diff", "--name-only", baseRef, "HEAD"]);
		const filesChanged = names.split("\n").filter(Boolean);
		const diffStat =
			filesChanged.length > 0
				? (await gitOrThrow(dir, ["diff", "--shortstat", baseRef, "HEAD"])).trim()
				: "";

		await removeWorktree(handle);
		if (filesChanged.length === 0) {
			await withRepoLock(() => git(handle.repoRoot, ["branch", "-D", branch]));
			return { baseRef, filesChanged, diffStat };
		}
		return { branch, baseRef, filesChanged, diffStat };
	} catch (error) {
		return {
			branch,
			baseRef,
			filesChanged: [],
			diffStat: "",
			error: error instanceof Error ? error.message : String(error),
			path: dir,
		};
	}
}

/** One-paragraph summary of a worktree outcome for the calling model. */
export function formatWorktreeOutcome(outcome: WorktreeOutcome): string {
	if (outcome.error) {
		return `**Worktree:** finalize failed — ${outcome.error}. Checkout kept at \`${outcome.path}\` on branch \`${outcome.branch}\`.`;
	}
	if (!outcome.branch) return "**Worktree:** no changes.";
	const count = outcome.filesChanged.length;
	return `**Worktree:** branch \`${outcome.branch}\` — ${count} file${count === 1 ? "" : "s"} changed (${outcome.diffStat}). Review: \`git diff ${outcome.baseRef.slice(0, 12)} ${outcome.branch}\`. Merge: \`git merge ${outcome.branch}\`.`;
}
