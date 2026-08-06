import type { TodoItem } from "../../core";

/**
 * Merge a fresh full-list submission against the previous items. Content is the
 * join key; any field omitted on the resubmitted item falls back to the previous
 * value, so flipping a delegated item to completed without re-passing
 * agent/context/result keeps its delegation metadata.
 */
export function mergeTodoItems(
	rawItems: readonly TodoItem[],
	existing: readonly TodoItem[],
): TodoItem[] {
	const existingMap = new Map(existing.map((i) => [i.content, i]));
	const now = Date.now();
	return rawItems.map((raw) => {
		const prev = existingMap.get(raw.content);
		return {
			content: raw.content,
			status: raw.status,
			agent: raw.agent ?? prev?.agent,
			context: raw.context ?? prev?.context,
			result: raw.result ?? prev?.result,
			source: raw.source ?? prev?.source,
			sourceId: raw.sourceId ?? prev?.sourceId,
			sourceIndex: raw.sourceIndex ?? prev?.sourceIndex,
			level: raw.level ?? prev?.level,
			createdAt: prev?.createdAt ?? now,
			completedAt: raw.status === "completed" ? (prev?.completedAt ?? now) : null,
		};
	});
}
