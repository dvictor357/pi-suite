import type { TodoItem, TodoStatus } from "../../core";

/** Sort priority for the todo list view: active work first, finished last. */
export const STATUS_ORDER: Record<TodoStatus, number> = {
	in_progress: 0,
	delegated: 1,
	pending: 2,
	completed: 3,
};

/**
 * The order items are displayed in — and therefore the order the `/todo`
 * commands index by, so the number a user reads off the list is the number they
 * pass to `/todo delegate <idx>` / `/todo <idx>`. Returns a shallow copy (same
 * item references), so callers can mutate a returned item and persist the list.
 */
export function displayOrder(items: TodoItem[]): TodoItem[] {
	return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

/**
 * The order users see and command indices resolve against. Flat lists keep the
 * old status sort; tree lists keep author input order so indentation remains a
 * readable parent→child outline.
 */
export function visibleOrder(items: TodoItem[]): TodoItem[] {
	if (!items.some((i) => (i.level ?? 0) > 0)) return displayOrder(items);
	return [...items];
}

function clampedLevel(level: number | undefined): number {
	return Math.max(0, Math.min(level ?? 0, 8));
}

/** Two spaces per nest level, clamped to 0..8. */
export function indent(level: number): string {
	return "  ".repeat(clampedLevel(level));
}

function hasLaterSiblingAtLevel(items: TodoItem[], index: number, level: number): boolean {
	for (const item of items.slice(index + 1)) {
		const nextLevel = clampedLevel(item.level);
		if (nextLevel < level) return false;
		if (nextLevel === level) return true;
	}
	return false;
}

/** Tree branch prefix for a visible-order item, e.g. "├─ " or "│  └─ ". */
export function treePrefix(items: TodoItem[], index: number): string {
	const level = clampedLevel(items[index]?.level);
	if (level === 0) return "";
	let prefix = "";
	for (let l = 1; l < level; l++) prefix += hasLaterSiblingAtLevel(items, index, l) ? "│  " : "   ";
	return prefix + (hasLaterSiblingAtLevel(items, index, level) ? "├─ " : "└─ ");
}
