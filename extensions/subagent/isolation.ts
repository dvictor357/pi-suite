import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentConfig } from "./agents.js";
import {
	createWorktree,
	finalizeWorktree,
	findRepoRoot,
	hasUncommittedChanges,
	mapCwdIntoWorktree,
	resolveHead,
	worktreeBranchName,
} from "./worktree.js";
import { emptyUsage, type SingleResult } from "./render.js";

export const READ_ONLY_AGENTS = new Set(["scout", "planner", "reviewer", "verifier"]);
export const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

/** Read-only agents never need a worktree: known read-only names, or an
 *  explicit tool list with no way to modify files. */
export function isReadOnlyAgent(agentName: string, agents: AgentConfig[]): boolean {
	if (READ_ONLY_AGENTS.has(agentName.trim().toLowerCase())) return true;
	const tools = agents.find((a) => a.name === agentName)?.tools;
	return (
		tools !== undefined &&
		tools.length > 0 &&
		!tools.some((t) => WRITE_TOOLS.has(t.trim().toLowerCase()))
	);
}

export function failedResult(agentName: string, task: string, message: string): SingleResult {
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: message,
		usage: emptyUsage(),
	};
}

export interface IsolationContext {
	repoRoot: string;
	baseRef: string;
	/** Short id shared by every branch created in one tool call. */
	runId: string;
}

/**
 * Prepare worktree isolation for one tool call. Returns an error message when
 * the caller's cwd cannot be isolated (not a git repo, no commits).
 */
export async function prepareIsolation(
	cwd: string,
): Promise<{ context: IsolationContext; dirty: boolean } | { error: string }> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot)
		return {
			error: `isolation "worktree" requires a git repository, but ${cwd} is not inside one`,
		};
	try {
		const baseRef = await resolveHead(repoRoot);
		const dirty = await hasUncommittedChanges(repoRoot);
		const runId = crypto.randomUUID().slice(0, 8);
		return { context: { repoRoot, baseRef, runId }, dirty };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Run a task in its own worktree when isolation is on and the agent can write.
 * Changes are committed to a per-task branch even if the run fails or aborts,
 * so partial work stays inspectable.
 */
export async function runIsolated(
	isolation: IsolationContext | null,
	index: number,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	defaultCwd: string,
	taskCwd: string | undefined,
	run: (cwd: string | undefined) => Promise<SingleResult>,
): Promise<SingleResult> {
	if (!isolation || isReadOnlyAgent(agentName, agents)) return run(taskCwd);

	let handle: Awaited<ReturnType<typeof createWorktree>>;
	let isolatedCwd: string;
	try {
		// Validate before creating anything so a bad cwd leaves no worktree behind.
		mapCwdIntoWorktree(isolation.repoRoot, isolation.repoRoot, defaultCwd, taskCwd);
		handle = await createWorktree(
			isolation.repoRoot,
			isolation.baseRef,
			worktreeBranchName(isolation.runId, index, agentName),
		);
		isolatedCwd = mapCwdIntoWorktree(isolation.repoRoot, handle.path, defaultCwd, taskCwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return failedResult(agentName, task, `Worktree setup failed: ${message}`);
	}

	let result: SingleResult | undefined;
	try {
		result = await run(isolatedCwd);
		return result;
	} finally {
		const outcome = await finalizeWorktree(
			handle,
			`pi-minions: ${agentName} task #${index + 1}\n\n${task.slice(0, 2000)}`,
		);
		if (result) result.worktree = outcome;
	}
}

export interface ClaimParticipant {
	agent: string;
	cwd?: string;
	readClaim?: string[];
	writeClaim?: string[];
	/** Participants in the same sequential group cannot overlap in time. */
	sequentialGroup?: number;
	label: string;
}

export function canonicalPath(raw: string, cwd: string): string {
	if (!raw.trim()) throw new Error("claim paths must not be empty");
	const absolute = path.resolve(cwd, raw);
	let ancestor = absolute;
	while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
		ancestor = path.dirname(ancestor);
	}
	let resolved = absolute;
	try {
		resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
	} catch {
		// The lexical path is still checked against cwd below.
	}
	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`claim path ${JSON.stringify(raw)} escapes working directory ${cwd}`);
	}
	return resolved;
}

export function pathsOverlap(a: string, b: string): boolean {
	const rel = path.relative(a, b);
	const reverse = path.relative(b, a);
	return (
		rel === "" ||
		(!rel.startsWith("..") && !path.isAbsolute(rel)) ||
		(!reverse.startsWith("..") && !path.isAbsolute(reverse))
	);
}

/** Validate all processes that may run concurrently before spawning any child. */
export function validateConcurrentWriteClaims(
	defaultCwd: string,
	participants: ClaimParticipant[],
): string | null {
	try {
		const normalized = participants.map((participant) => {
			const cwd = fs.existsSync(participant.cwd ?? defaultCwd)
				? fs.realpathSync(participant.cwd ?? defaultCwd)
				: path.resolve(participant.cwd ?? defaultCwd);
			const read = [...new Set((participant.readClaim ?? []).map((p) => canonicalPath(p, cwd)))];
			const write = [...new Set((participant.writeClaim ?? []).map((p) => canonicalPath(p, cwd)))];
			if (READ_ONLY_AGENTS.has(participant.agent.trim().toLowerCase()) && write.length > 0) {
				throw new Error(
					`${participant.label} uses read-only agent "${participant.agent}" and cannot declare writeClaim`,
				);
			}
			return { ...participant, cwd, read, write };
		});

		for (let i = 0; i < normalized.length; i++) {
			const a = normalized[i];
			if (READ_ONLY_AGENTS.has(a.agent.trim().toLowerCase())) continue;
			for (let j = i + 1; j < normalized.length; j++) {
				const b = normalized[j];
				if (
					READ_ONLY_AGENTS.has(b.agent.trim().toLowerCase()) ||
					(a.sequentialGroup !== undefined && a.sequentialGroup === b.sequentialGroup)
				) {
					continue;
				}
				if (a.cwd !== b.cwd && (a.write.length === 0 || b.write.length === 0)) continue;
				if (a.write.length === 0 || b.write.length === 0) {
					throw new Error(
						`${a.label} and ${b.label} may write concurrently in ${a.cwd}; declare non-empty disjoint writeClaim arrays or run them in isolated cwd directories`,
					);
				}
				for (const left of a.write) {
					for (const right of b.write) {
						if (pathsOverlap(left, right)) {
							throw new Error(
								`${a.label} and ${b.label} have overlapping write claims: ${left} ↔ ${right}; use disjoint paths or isolated cwd directories`,
							);
						}
					}
				}
			}
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
