/**
 * quest/plan-steps.ts — which steps a quest_plan call provides.
 *
 * `steps` is canonical. The legacy `tasks` alias stays accepted forever, but its
 * tool schema no longer repeats the whole step shape (~2.4k chars on every model
 * request): its items arrive unvalidated and are checked here against the real
 * step schema, passed in as `isStep`. Pure, so it is node-testable.
 */

export function resolvePlannedSteps<T>(
	params: { steps?: T[]; tasks?: unknown[] },
	isStep: (value: unknown) => value is T,
): { steps: T[] } | { error: string } {
	if (params.steps || !params.tasks) return { steps: params.steps ?? [] };
	const bad = params.tasks.findIndex((t) => !isStep(t));
	if (bad !== -1) {
		return {
			error: `Invalid step #${bad + 1} in tasks: each step needs content, agent and context strings (same shape as steps).`,
		};
	}
	return { steps: params.tasks.filter(isStep) };
}
