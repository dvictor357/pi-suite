/**
 * quest/enhance.ts — the quest prompt enhancer.
 *
 * Before planning, enrich the raw user goal with context the planner would
 * otherwise have to discover: project memory (stack, conventions, facts),
 * prior quest research, past quests, role→model assignments, and git state.
 *
 * Pure assembly lives in {@link renderEnhancedBrief} so the format/budget
 * logic is unit-testable without touching disk; {@link collectEnhanceContext}
 * is the best-effort reader (never throws — a missing file degrades to an
 * empty section, mirroring the rest of the suite's storage reads).
 */
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AGENT_DIR, projectMemoryPath, readJSON, isFutureContract } from "../../core";
import type { ProjectMemory, UserMemory } from "../../core";
import { listArchives } from "./storage";

/** Hard cap on the enhanced brief so it stays planner-friendly. */
export const ENHANCE_BUDGET = 4000;

export interface EnhanceContext {
	project: ProjectMemory | null;
	user: UserMemory | null;
	archives: { name: string; goal: string; steps: number; done: number }[];
	git: { branch: string | null; dirty: boolean };
}

/** Run git, returning trimmed stdout or null on any failure (mirrors evidence.ts). */
function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, timeout: 10_000, stdio: "pipe", encoding: "utf8" })
			.toString()
			.trim();
	} catch {
		return null;
	}
}

/** Best-effort disk read of everything the enhancer needs. Never throws. */
export function collectEnhanceContext(cwd: string): EnhanceContext {
	const project = readJSON<ProjectMemory | null>(projectMemoryPath(cwd), null);
	const user = readJSON<UserMemory | null>(join(AGENT_DIR, "memory", "user.json"), null);
	const porcelain = git(cwd, ["status", "--porcelain"]);
	return {
		// A file written by a newer contract has a shape we'd misread; skip it.
		project: project && !isFutureContract(project) ? project : null,
		user: user && !isFutureContract(user as { contractVersion?: number }) ? user : null,
		archives: listArchives(5, cwd),
		git: {
			branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
			dirty: porcelain !== null && porcelain.length > 0,
		},
	};
}

function line(label: string, value: string | null): string | null {
	return value ? `- ${label}: ${value}` : null;
}

/** Collapse whitespace and cap a raw text snippet so one bad fact can't blow the budget. */
function snippet(text: string, max: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Assemble the enhanced brief. Pure: no I/O, so tests can feed a fixture
 * context and assert on formatting and the budget cap.
 */
export function renderEnhancedBrief(
	goal: string,
	name: string | undefined,
	ctx: EnhanceContext,
): string {
	const out: string[] = [];
	out.push(`# Quest: ${name ?? "brief"}`);
	out.push("");
	out.push(`## Goal`);
	out.push(goal);
	out.push("");

	const p = ctx.project;
	if (p) {
		const stack = [
			line("Language", p.language),
			line("Framework", p.framework),
			line("Package manager", p.packageManager),
			line("Build tool", p.buildTool),
			line("Test runner", p.testRunner),
			line("Linter", p.linter),
			line("Formatter", p.formatter),
			p.directoryPattern ? line("Layout", p.directoryPattern) : null,
		].filter((l): l is string => l !== null);
		if (p.monorepo) stack.push("- Monorepo: yes");
		if (stack.length > 0) {
			out.push(`## Project stack`);
			out.push(stack.join("\n"));
			out.push("");
		}
		if (p.conventions.length > 0) {
			out.push(`## Conventions`);
			out.push(
				p.conventions
					.slice(0, 8)
					.map((c) => `- ${snippet(c, 200)}`)
					.join("\n"),
			);
			out.push("");
		}
		const facts = p.facts
			.filter((f) => (f.priority ?? 0) >= 5)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
			.slice(0, 8)
			.map((f) => `- ${snippet(f.text, 200)}`);
		if (facts.length > 0) {
			out.push(`## Project facts`);
			out.push(facts.join("\n"));
			out.push("");
		}
		const research = Object.values(p.research ?? {})
			.slice(0, 6)
			.map((r) => `- ${snippet(r.value, 240)}`);
		if (research.length > 0) {
			out.push(`## Prior research`);
			out.push(research.join("\n"));
			out.push("");
		}
		const models = Object.entries(p.agentModels ?? {})
			.slice(0, 8)
			.map(
				([role, c]) =>
					`- ${role} → ${c.model}${c.thinkingLevel ? ` (thinking: ${c.thinkingLevel})` : ""}`,
			);
		if (models.length > 0) {
			out.push(`## Model assignments`);
			out.push(models.join("\n"));
			out.push("");
		}
		if (p.modelLadder?.rungs.length) {
			out.push(`## Model ladder`);
			out.push(p.modelLadder.rungs.join(" → "));
			out.push("");
		}
	}

	const u = ctx.user;
	if (u) {
		const prefs = [
			line("Communication", u.communication),
			line("Commit style", u.commitStyle),
			line("Error handling", u.errorHandling),
			line("Preferred package manager", u.preferredPackageManager),
		].filter((l): l is string => l !== null);
		const convs = u.conventions.slice(0, 5).map((c) => `- ${snippet(c, 200)}`);
		if (prefs.length > 0 || convs.length > 0) {
			out.push(`## User prefs`);
			out.push([...prefs, ...convs].join("\n"));
			out.push("");
		}
	}

	if (ctx.archives.length > 0) {
		out.push(`## Past quests`);
		out.push(
			ctx.archives
				.map((a) => `- ${a.name}: ${snippet(a.goal, 160)} (${a.done}/${a.steps} done)`)
				.join("\n"),
		);
		out.push("");
	}

	if (ctx.git.branch) {
		out.push(`## Git`);
		out.push(`- Branch: ${ctx.git.branch}${ctx.git.dirty ? " (dirty working tree)" : " (clean)"}`);
		out.push("");
	}

	let text = out.join("\n").trim();
	if (text.length > ENHANCE_BUDGET)
		text = `${text.slice(0, ENHANCE_BUDGET).trimEnd()}\n…(truncated)`;
	return text;
}
