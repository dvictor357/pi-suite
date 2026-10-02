/**
 * Spend caps shared by every subagent spawned from one tool call.
 *
 * Usage is charged after each model turn, so the cap is soft: turns already
 * in flight when the cap is reached can overshoot it. Once exceeded, running
 * subagents are stopped and nothing new is started.
 */

export interface BudgetLimits {
	/** USD cap across all subagents. Undefined = no cap. */
	maxCost?: number;
	/** Cap on input + output tokens (cache reads/writes excluded). */
	maxTokens?: number;
}

export interface BudgetSnapshot extends BudgetLimits {
	spentCost: number;
	spentTokens: number;
	exceeded: boolean;
}

/** Normalize a user-supplied cap: 0, negative, or non-finite means "no cap". */
export function normalizeLimit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(2)}M`;
}

export class RunBudget {
	spentCost = 0;
	spentTokens = 0;
	/** Why the budget tripped; null while within limits. */
	exceededReason: string | null = null;
	private readonly listeners = new Set<(reason: string) => void>();

	constructor(readonly limits: BudgetLimits) {}

	get enabled(): boolean {
		return this.limits.maxCost !== undefined || this.limits.maxTokens !== undefined;
	}

	get exceeded(): boolean {
		return this.exceededReason !== null;
	}

	/** Record one turn's usage. Notifies listeners the first time a cap is hit. */
	charge(cost: number, tokens: number): void {
		this.spentCost += Number.isFinite(cost) && cost > 0 ? cost : 0;
		this.spentTokens += Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
		if (this.exceeded) return;

		const { maxCost, maxTokens } = this.limits;
		if (maxCost !== undefined && this.spentCost >= maxCost) {
			this.exceededReason = `Budget exceeded: spent $${this.spentCost.toFixed(4)} of $${maxCost.toFixed(2)} cost cap`;
		} else if (maxTokens !== undefined && this.spentTokens >= maxTokens) {
			this.exceededReason = `Budget exceeded: used ${formatTokenCount(this.spentTokens)} of ${formatTokenCount(maxTokens)} token cap`;
		} else {
			return;
		}
		const reason = this.exceededReason;
		for (const listener of [...this.listeners]) listener(reason);
	}

	/** Subscribe to the exceeded event. Returns an unsubscribe function. */
	onExceeded(listener: (reason: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): BudgetSnapshot {
		return {
			...this.limits,
			spentCost: this.spentCost,
			spentTokens: this.spentTokens,
			exceeded: this.exceeded,
		};
	}
}

/** Short "spent of cap" line, e.g. "budget $0.1200/$0.50 · 12.0k/50.0k tok". */
export function formatBudget(snapshot: BudgetSnapshot): string {
	const parts: string[] = [];
	if (snapshot.maxCost !== undefined)
		parts.push(`$${snapshot.spentCost.toFixed(4)}/$${snapshot.maxCost.toFixed(2)}`);
	if (snapshot.maxTokens !== undefined)
		parts.push(
			`${formatTokenCount(snapshot.spentTokens)}/${formatTokenCount(snapshot.maxTokens)} tok`,
		);
	if (parts.length === 0) return "";
	return `budget ${parts.join(" · ")}${snapshot.exceeded ? " (exceeded)" : ""}`;
}
