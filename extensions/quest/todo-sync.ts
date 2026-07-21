import { basename } from "node:path";
import { readJSON, writeJSON, updateJSON, loadProjectMemory } from "./utils";
import {
	SESSION_META_PATH,
	todoListPath as todoPath,
	budgetForModel,
	clampToBudget,
	isConstrainedModel,
	type BudgetModelInfo,
	type MemoryGraph,
} from "../../core";
import type { Quest, QuestStep, SyncedTodoItem, SyncedTodoList } from "./types";
import {
	CONSTRAINED_MAX_AWARENESS_NODES,
	DEFAULT_MAX_AWARENESS_NODES,
	renderGraphContextBlock,
	selectGraphNodesForPrompt,
} from "./memory-graph-read";

export { todoPath };

export function questTaskToTodo(
	quest: Quest,
	task: QuestStep,
	index: number,
	previous?: SyncedTodoItem,
): SyncedTodoItem {
	const now = Date.now();
	const failed = task.status === "failed";
	const completed = task.status === "done" || task.status === "skipped" || failed;
	const status: SyncedTodoItem["status"] =
		task.status === "running" || task.status === "verifying"
			? "in_progress"
			: completed
				? "completed"
				: "pending";
	const result = failed
		? `[failed] ${task.result ?? task.verifyResult ?? "Step failed"}`
		: (task.result ?? undefined);

	return {
		content: `[Quest] #${index + 1} ${task.content}`,
		status,
		agent: task.agent,
		context: task.context,
		result,
		source: "quest",
		sourceId: quest.name,
		sourceIndex: index,
		createdAt: previous?.createdAt ?? task.startedAt ?? now,
		completedAt: completed ? (previous?.completedAt ?? task.completedAt ?? now) : null,
	};
}

export function syncQuestToTodo(quest: Quest, cwd: string): void {
	try {
		const path = todoPath(cwd);
		const existing = readJSON<SyncedTodoList>(path, { cwd, items: [], version: 1 });
		const existingItems = Array.isArray(existing.items) ? existing.items : [];
		const previousQuestItems = new Map<number, SyncedTodoItem>();
		for (const item of existingItems) {
			if (item?.source === "quest" && typeof item.sourceIndex === "number") {
				previousQuestItems.set(item.sourceIndex, item);
			}
		}
		const nonQuestItems = existingItems.filter(
			(item) => item?.source !== "quest" && !item?.content?.startsWith("[Quest]"),
		);
		const questItems = quest.steps.map((task, index) =>
			questTaskToTodo(quest, task, index, previousQuestItems.get(index)),
		);
		const next: SyncedTodoList = {
			cwd: existing.cwd ?? cwd,
			title: existing.title ?? `Quest: ${quest.name}`,
			items: [...nonQuestItems, ...questItems],
			version: 1,
		};
		writeJSON(path, next);
	} catch (e) {
		console.error("[pi-quest] syncQuestToTodo:", e); /* optional — pi-todo may not be installed */
	}
}

/**
 * Remove all quest-sourced items from pi-todo's list, leaving the user's own
 * todos intact. Used on abort/cancel so a dead quest's `[Quest]` items don't
 * linger in pi-todo. Read-merge-write; no write if there was nothing to remove.
 */
export function clearQuestFromTodo(cwd: string): void {
	try {
		updateJSON<SyncedTodoList>(
			todoPath(cwd),
			(existing) => {
				const items = Array.isArray(existing.items) ? existing.items : [];
				const kept = items.filter(
					(i) => i?.source !== "quest" && !i?.content?.startsWith("[Quest]"),
				);
				return kept.length === items.length ? existing : { ...existing, items: kept };
			},
			{ cwd, items: [], version: 1 },
		);
	} catch (e) {
		console.error(
			"[pi-quest] clearQuestFromTodo:",
			e,
		); /* optional — pi-todo may not be installed */
	}
}

export function compactAwarenessBlock(cwd: string, model?: BudgetModelInfo): string {
	try {
		const memory = loadProjectMemory(cwd);
		const todo = readJSON<SyncedTodoList | null>(todoPath(cwd), null);
		const meta = readJSON<any>(SESSION_META_PATH, { extensions: {} });
		const memoryMeta = meta.extensions?.memory ?? {};
		const todoMeta = meta.extensions?.todo ?? {};
		const lines: string[] = [];

		const now = new Date();
		lines.push(
			`Date: ${now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}`,
		);

		const language = memory?.language ?? memoryMeta.language;
		const framework = memory?.framework ?? memoryMeta.framework;
		const packageManager = memory?.packageManager ?? memoryMeta.packageManager;
		const conventions = Array.isArray(memory?.conventions) ? memory.conventions.slice(0, 5) : [];
		const tech = [language, framework, packageManager].filter(Boolean).join(" • ");
		if (memory || tech || conventions.length) {
			lines.push(
				`Memory: ${memory?.name ?? memoryMeta.name ?? basename(cwd)}${tech ? ` (${tech})` : ""}`,
			);
			if (conventions.length)
				lines.push(
					`Conventions: ${conventions.join("; ")}${memory?.conventions?.length > conventions.length ? "…" : ""}`,
				);
		}

		const research = memory?.research as
			| Record<string, { value: string; category?: string; timestamp: number }>
			| undefined;
		if (research) {
			const entries = Object.entries(research)
				.sort(([, a], [, b]) => b.timestamp - a.timestamp)
				.slice(0, 5);
			if (entries.length) {
				const lines2 = entries.map(([k, v]) => {
					const cat = v.category ? `[${v.category}] ` : "";
					const val = v.value.length > 80 ? v.value.slice(0, 77) + "…" : v.value;
					return `- ${k}: ${cat}${val}`;
				});
				lines.push(`Research:\n${lines2.join("\n")}`);
			}
		}

		const items = Array.isArray(todo?.items) ? todo.items : [];
		const total = typeof todoMeta.total === "number" ? todoMeta.total : items.length;
		if (total > 0) {
			const completed =
				typeof todoMeta.completed === "number"
					? todoMeta.completed
					: items.filter((i) => i.status === "completed").length;
			const inProgress =
				typeof todoMeta.inProgress === "number"
					? todoMeta.inProgress
					: items.filter((i) => i.status === "in_progress").length;
			const delegated =
				typeof todoMeta.delegated === "number"
					? todoMeta.delegated
					: items.filter((i) => i.status === "delegated").length;
			lines.push(
				`Todo: ${completed}/${total} done${inProgress ? ` · ${inProgress} active` : ""}${delegated ? ` · ${delegated} delegated` : ""}`,
			);
		}

		// Budgeted memory-graph retrieval: top N recent non-eval nodes (fewer on
		// constrained models). Eval-result is excluded from the prompt dump.
		const graph = memory?.graph as MemoryGraph | undefined;
		if (graph?.nodes?.length) {
			const maxNodes = isConstrainedModel(model)
				? CONSTRAINED_MAX_AWARENESS_NODES
				: DEFAULT_MAX_AWARENESS_NODES;
			const selected = selectGraphNodesForPrompt(graph, {
				maxNodes,
				excludeEvalResults: true,
			});
			if (selected.length) {
				// Reserve a slice of the total budget for the graph section; the
				// whole awareness block is clamped again below.
				const totalBudget = budgetForModel(model);
				const graphBudget = Math.max(120, Math.floor(totalBudget * 0.35));
				const graphBlock = renderGraphContextBlock(selected, graphBudget);
				if (graphBlock) lines.push(graphBlock);
			}
		}

		const block = lines.length ? `\n\n## Project Awareness\n${lines.join("\n")}` : "";
		// Model-aware, structure-safe: trim whole lines to the model's budget
		// (tighter on small/low-context models) instead of a raw mid-line cut.
		return block ? clampToBudget(block, budgetForModel(model)) : "";
	} catch (e) {
		console.error("[pi-quest] compactAwarenessBlock:", e);
		return "";
	}
}
