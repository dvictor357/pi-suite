/**
 * Single source of truth for retry, burst, and dependency-depth limits used
 * across pi-quest's steering, verification, and sub-agent delegation flows.
 *
 * These are quest-level budgets. The subagent tool's `MAX_RETRIES`
 * (extensions/subagent/constants.ts) is deliberately separate: it caps the
 * per-call `retries` param for transient child-process failures (default 0),
 * not quest step retries, so it is not derived from this policy.
 */

export interface RetryPolicy {
	/** Max task-level retry attempts before auto-failing (excludes the first try). */
	maxRetries: number;
	/** Max consecutive tasks before auto-pilot pauses to let the user inspect. */
	maxBurst: number;
	/** Max verification retries per task before auto-failing. */
	maxVerifyRetries: number;
	/** Maximum dependency chain depth for quest task graphs. */
	maxDependencyDepth: number;
	/**
	 * Max model-ladder escalations per task before auto-failing (excludes the
	 * starting rung). Retry budgets are per-rung: escalating to a new model
	 * resets `maxVerifyRetries`/`maxRetries`, so the worst case per task is
	 * `maxVerifyRetries × (1 + min(maxEscalations, rungs − 1))` verified attempts.
	 */
	maxEscalations: number;
}

/**
 * Conservative defaults suitable for coding workflows. Bump these per-project
 * by writing a project-level override into project memory (future hook).
 */
export const MAX_RETRIES = 2;
export const MAX_BURST = 6;
export const MAX_VERIFY_RETRIES = 2;
export const MAX_DEPENDENCY_DEPTH = 3;
export const MAX_ESCALATIONS = 2;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: MAX_RETRIES,
	maxBurst: MAX_BURST,
	maxVerifyRetries: MAX_VERIFY_RETRIES,
	maxDependencyDepth: MAX_DEPENDENCY_DEPTH,
	maxEscalations: MAX_ESCALATIONS,
};
