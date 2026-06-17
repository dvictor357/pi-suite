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
