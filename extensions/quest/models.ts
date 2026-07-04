/**
 * quest/models.ts — orchestrator-driven model assignment for sub-agents.
 *
 * The main agent acts as the orchestrator: it judges which model best fits a
 * task's sub-agent role and proposes one. This module is the gate around that
 * judgment — it resolves the proposal against the models the user actually has
 * auth for (via the model registry), then asks the user to approve or pick a
 * different one. The model-matching logic is pure so it can be unit-tested
 * without any UI; the dialog is a thin wrapper over `ctx.ui`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/** Minimal model shape this module needs — a structural subset of pi-ai's Model. */
export interface ModelLike {
	id: string;
	name: string;
	provider: string;
}

/** Project the registry's full Model down to the fields we care about. */
export function toModelLike(m: { id: string; name: string; provider: string }): ModelLike {
	return { id: m.id, name: m.name, provider: String(m.provider) };
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Resolve a proposed model identifier against the available models.
 *
 * Accepts a bare id ("deepseek-v4-flash"), a provider-qualified id
 * ("deepseek/deepseek-v4-flash" or "deepseek:deepseek-v4-flash"), or a display
 * name. Returns the single unambiguous match, or `undefined` when nothing
 * matches OR the match is ambiguous (e.g. the same id is offered by two
 * providers without a qualifier) — in both cases the caller should fall back to
 * letting the user pick from the full list rather than guessing.
 */
export function matchModel<T extends ModelLike>(available: T[], proposed: string): T | undefined {
	const raw = proposed.trim();
	if (!raw) return undefined;

	let wantProvider: string | undefined;
	let wantId = raw;
	const qualified = raw.match(/^([^/:]+)[/:](.+)$/);
	if (qualified) {
		wantProvider = norm(qualified[1]);
		wantId = qualified[2].trim();
	}
	const wantIdN = norm(wantId);
	const providerOk = (m: ModelLike): boolean => !wantProvider || norm(m.provider) === wantProvider;

	let hits = available.filter((m) => providerOk(m) && norm(m.id) === wantIdN);
	if (hits.length === 0) {
		hits = available.filter((m) => providerOk(m) && norm(m.name) === wantIdN);
	}
	return hits.length === 1 ? hits[0] : undefined;
}

/** Human-readable label for a model in a selection list. */
export function formatModelLabel(m: ModelLike): string {
	return `${m.id} · ${m.provider}`;
}

const KEEP_DEFAULT = "Keep harness default (no override)";

let uiPromptQueue: Promise<void> = Promise.resolve();

/**
 * Tool calls from a single model response may execute concurrently. Interactive
 * prompts must still be shown one-at-a-time, otherwise multiple overlays
 * (`ctx.ui.custom`, `ctx.ui.confirm`, …) compete for focus and every prompt but
 * the one that wins the terminal appears to hang behind its tool card.
 *
 * Every interactive quest prompt must route through this single queue — a prompt
 * that bypasses it (e.g. calling `ctx.ui.confirm` directly) can be orphaned
 * behind a queued overlay and never receive input. See {@link promptModelAssignment}
 * and the ladder-approval confirm in register-delegate.
 */
export async function enqueueUiPrompt<T>(fn: () => Promise<T>): Promise<T> {
	const previous = uiPromptQueue;
	let release!: () => void;
	uiPromptQueue = new Promise<void>((resolve) => {
		release = resolve;
	});

	await previous.catch(() => undefined);
	try {
		return await fn();
	} finally {
		release();
	}
}

/**
 * Outcome of {@link promptModelAssignment}:
 * - `assigned`: the user approved a concrete model for the role.
 * - `default`: the user declined to override — use the harness default.
 * - `cancelled`: the user dismissed the dialog, or no models were available.
 */
export type ModelAssignment =
	| { outcome: "assigned"; model: ModelLike }
	| { outcome: "default" }
	| { outcome: "cancelled" };

/**
 * Ask the user to approve the orchestrator's proposed model for a sub-agent
 * role, or pick a different one from the models they have configured.
 *
 * The proposed model (when it resolves to something available) is listed first
 * and flagged as the orchestrator's pick, so approving is a single keystroke;
 * the rest of the list lets the user swap in any other available model.
 *
 * In TUI mode this opens a SelectList dialog with max-height capping and
 * type-to-filter search. In non-TUI mode it falls back to ctx.ui.select.
 */
export async function promptModelAssignment(
	ctx: ExtensionContext,
	opts: { role: string; proposed: string; reason?: string },
): Promise<ModelAssignment> {
	return enqueueUiPrompt(async () => {
		const available = ctx.modelRegistry.getAvailable().map(toModelLike);
		if (available.length === 0) {
			ctx.ui.notify(
				"No models with configured auth are available, so a sub-agent model can't be assigned.",
				"warning",
			);
			return { outcome: "cancelled" };
		}

		const matched = matchModel(available, opts.proposed);
		const ordered = matched ? [matched, ...available.filter((m) => m !== matched)] : [...available];

		const reasonLine = opts.reason ? `\nWhy: ${opts.reason}` : "";

		// Non-TUI fallback: simple flat list
		if (!ctx.hasUI) {
			const labels = ordered.map((m) =>
				m === matched ? `${formatModelLabel(m)}  ← orchestrator's pick` : formatModelLabel(m),
			);
			labels.push(KEEP_DEFAULT);

			const title = matched
				? `Assign sub-agent "${opts.role}" → ${formatModelLabel(matched)}?${reasonLine}`
				: `Pick a model for sub-agent "${opts.role}" (proposed "${opts.proposed}" isn't available).${reasonLine}`;

			const choice = await ctx.ui.select(title, labels);
			if (choice === undefined) return { outcome: "cancelled" };
			if (choice === KEEP_DEFAULT) return { outcome: "default" };

			const idx = labels.indexOf(choice);
			const model = idx >= 0 ? ordered[idx] : undefined;
			return model ? { outcome: "assigned", model } : { outcome: "cancelled" };
		}

		// TUI: SelectList with height cap and type-to-filter
		const titleText = matched
			? `Assign sub-agent "${opts.role}" → ${formatModelLabel(matched)}?${reasonLine}`
			: `Pick a model for "${opts.role}" (proposed "${opts.proposed}" not found)${reasonLine}`;

		// Dynamic import so the test runner (which resolves via CJS) doesn't trip
		const { DynamicBorder } = await import("@earendil-works/pi-coding-agent");

		const result = await ctx.ui.custom<ModelAssignment>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(titleText)), 1, 0));
			container.addChild(new Text("", 0, 0));

			// Map models to SelectItems; orchestrator's pick gets a highlighted label
			const items: SelectItem[] = ordered.map((m) => ({
				value: m.id,
				label:
					m === matched ? `${formatModelLabel(m)}  ← orchestrator's pick` : formatModelLabel(m),
				description: m.provider,
			}));
			items.push({
				value: KEEP_DEFAULT,
				label: KEEP_DEFAULT,
				description: "Use harness default",
			});

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			selectList.onSelect = (item) => {
				if (item.value === KEEP_DEFAULT) {
					done({ outcome: "default" });
					return;
				}
				const model = ordered.find((m) => m.id === item.value);
				done(model ? { outcome: "assigned", model } : { outcome: "cancelled" });
			};
			selectList.onCancel = () => done({ outcome: "cancelled" });

			container.addChild(selectList);
			container.addChild(new Text("", 0, 0));
			container.addChild(
				new Text(theme.fg("dim", "type to filter · ↑↓ navigate · enter select · esc cancel"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		return result ?? { outcome: "cancelled" };
	});
}
