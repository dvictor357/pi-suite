import type { BudgetModelInfo } from "../../core";
import { fitSectionsToBudget, stepContextBudgetForModel } from "../../core";
import { formatDirectiveFor } from "./constants";
import { buildSandboxConstraintBlock } from "./delegate";
import type { SandboxProfile } from "./sandbox";
import { compactAwarenessBlock } from "./todo-sync";
import type { Quest, QuestStep, StepHandoff } from "./types";

/**
 * Priority ranks for multi-block step context (lower = keep longer).
 * Issue I8: task > failure briefs > dep handoffs > awareness > format.
 * Structural sections (framing, sandbox, completion schema) share the task tier.
 */
const SECTION_PRIORITY = {
	task: 0,
	structural: 0,
	failure: 1,
	deps: 2,
	awareness: 3,
	format: 4,
} as const;

const MAX_SUMMARY = 2_000;
const MAX_NOTES = 1_000;
const MAX_FILES = 50;
const MAX_CHECKS = 20;
const MAX_ITEM = 500;

const bounded = (value: unknown, max: number): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

function boundedList(value: unknown, count: number, max = MAX_ITEM): string[] {
	return Array.isArray(value)
		? value
				.map((item) => bounded(item, max))
				.filter(Boolean)
				.slice(0, count)
		: [];
}

/** Parse the requested JSON completion object, falling back to bounded prose for old agents. */
export function parseStepHandoff(output: string): StepHandoff {
	const text = output.trim();
	const fenced = [...text.matchAll(/```(?:json|quest-handoff)?\s*([\s\S]*?)```/gi)].reverse();
	const candidates = [...fenced.map((match) => match[1]), text];
	for (const candidate of candidates) {
		try {
			const raw = JSON.parse(candidate) as Record<string, unknown>;
			const summary = bounded(raw.summary, MAX_SUMMARY);
			if (!summary) continue;
			const notes = bounded(raw.notes, MAX_NOTES);
			return {
				version: 1,
				summary,
				filesChanged: boundedList(raw.filesChanged, MAX_FILES, 300),
				verification: boundedList(raw.verification, MAX_CHECKS),
				...(notes ? { notes } : {}),
			};
		} catch {
			// Plain-text output is a supported legacy format.
		}
	}
	return { version: 1, summary: bounded(text, MAX_SUMMARY), filesChanged: [], verification: [] };
}

/** Coerce persisted handoffs without trusting historical JSON. */
export function coerceStepHandoff(value: unknown): StepHandoff | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const summary = bounded(raw.summary, MAX_SUMMARY);
	if (!summary) return undefined;
	const notes = bounded(raw.notes, MAX_NOTES);
	return {
		version: 1,
		summary,
		filesChanged: boundedList(raw.filesChanged, MAX_FILES, 300),
		verification: boundedList(raw.verification, MAX_CHECKS),
		...(notes ? { notes } : {}),
	};
}

export function roleFramingBlock(role: string): string {
	return `You are a "${role}" sub-agent. Complete exactly this step — nothing more — and report back concisely.`;
}

export function taskBlock(content: string): string {
	return `## Task\n${content}`;
}

export function contextBlock(context?: string): string {
	return context?.trim() ? `## Context\n${context.trim()}` : "";
}

export interface DependencyHandoff {
	content: string;
	handoff: StepHandoff;
}

/** Render only direct dependencies, using bounded summaries rather than their raw output. */
export function dependencyHandoffBlock(dependencies: ReadonlyArray<DependencyHandoff>): string {
	if (!dependencies.length) return "";
	const lines = ["## Prior results you can build on"];
	for (const dependency of dependencies) {
		lines.push(`### ${dependency.content}`, dependency.handoff.summary);
		if (dependency.handoff.filesChanged.length) {
			lines.push(
				`Files changed: ${dependency.handoff.filesChanged.map((file) => `\`${file}\``).join(", ")}`,
			);
		}
		if (dependency.handoff.verification.length) {
			lines.push(`Verification: ${dependency.handoff.verification.join("; ")}`);
		}
		if (dependency.handoff.notes) lines.push(`Notes: ${dependency.handoff.notes}`);
	}
	return lines.join("\n");
}

export function failureBriefBlock(rendered: string): string {
	return rendered.trim();
}

export function sandboxConstraintBlock(profile?: SandboxProfile): string {
	return buildSandboxConstraintBlock(profile);
}

export function projectAwarenessBlock(cwd: string, model?: BudgetModelInfo): string {
	return compactAwarenessBlock(cwd, model);
}

export function formatBlock(model?: BudgetModelInfo): string {
	return formatDirectiveFor(model);
}

export function completionSchemaBlock(): string {
	return [
		"## Completion schema",
		"End your response with this bounded JSON object (plain prose remains accepted for legacy agents):",
		"```json",
		'{"summary":"what was completed","filesChanged":["path/to/file"],"verification":["command: result"],"notes":"optional blockers or caveats"}',
		"```",
	].join("\n");
}

export interface BuildStepContextOpts {
	role: string;
	content: string;
	context?: string;
	persona?: string;
	dependencyResults?: ReadonlyArray<DependencyHandoff>;
	failureBriefBlock?: string;
	sandboxProfile?: SandboxProfile;
	modelInfo?: BudgetModelInfo;
	cwd?: string;
	includeLegacyFraming?: boolean;
}

export function buildStepContext(opts: BuildStepContextOpts): string {
	// Build each section independently, then fit them into one model budget.
	// Priority (keep first): task > failure briefs > dep handoffs > awareness > format.
	// Whole low-priority sections drop before any line-safe clamp of survivors.
	const framingParts: string[] = [];
	if (opts.includeLegacyFraming) {
		if (opts.persona?.trim()) framingParts.push(opts.persona.trim(), "---");
		framingParts.push(roleFramingBlock(opts.role));
	}
	const framing = framingParts.filter(Boolean).join("\n\n");

	const taskParts = [taskBlock(opts.content), contextBlock(opts.context)].filter(Boolean);
	const task = taskParts.join("\n\n");

	const sections = [
		{ text: framing, priority: SECTION_PRIORITY.structural },
		{ text: task, priority: SECTION_PRIORITY.task },
		{
			text: failureBriefBlock(opts.failureBriefBlock ?? ""),
			priority: SECTION_PRIORITY.failure,
		},
		{
			text: dependencyHandoffBlock(opts.dependencyResults ?? []),
			priority: SECTION_PRIORITY.deps,
		},
		{
			text: sandboxConstraintBlock(opts.sandboxProfile),
			priority: SECTION_PRIORITY.structural,
		},
		{
			text: opts.cwd ? projectAwarenessBlock(opts.cwd, opts.modelInfo) : "",
			priority: SECTION_PRIORITY.awareness,
		},
		{ text: formatBlock(opts.modelInfo), priority: SECTION_PRIORITY.format },
		{ text: completionSchemaBlock(), priority: SECTION_PRIORITY.structural },
	];

	const budget = stepContextBudgetForModel(opts.modelInfo);
	return fitSectionsToBudget(sections, budget);
}

/** Persist a bounded completion handoff while retaining the original result for compatibility. */
export function persistHandoff(quest: Quest, stepIndex: number, result: string): void {
	const step = quest.steps[stepIndex];
	if (step && result.trim()) step.handoff = parseStepHandoff(result);
}

/** Collect only direct dependency handoffs; old result-only quests get a prose fallback. */
export function collectDependencyHandoffs(quest: Quest, step: QuestStep): DependencyHandoff[] {
	return step.dependencies.flatMap((index) => {
		const dependency = quest.steps[index];
		if (!dependency) return [];
		const handoff =
			dependency.handoff ??
			(dependency.result?.trim() ? parseStepHandoff(dependency.result) : undefined);
		return handoff ? [{ content: dependency.content, handoff }] : [];
	});
}
