import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Quest } from "./types";
import { writeSessionMeta } from "./utils";

export function writeQuestSessionMeta(cwd: string, quest: Quest | null): void {
	if (!quest || quest.status === "idle" || quest.status === "done") {
		writeSessionMeta("quest", cwd, { status: "idle", done: 0, total: 0 });
		return;
	}
	writeSessionMeta("quest", cwd, {
		name: quest.name,
		status: quest.status,
		done: quest.steps.filter((t) => t.status === "done").length,
		total: quest.steps.length,
	});
}

export function renderStatus(ctx: ExtensionContext, quest: Quest | null) {
	const theme = (ctx.ui as any).theme;
	if (!quest || quest.status === "idle" || quest.status === "done") {
		ctx.ui.setStatus?.("quest", "");
		return;
	}
	const done = quest.steps.filter((t) => t.status === "done").length;
	const total = quest.steps.length;
	const icon = quest.status === "active" ? "⚔" : quest.status === "planning" ? "📋" : "⏸";
	const label = total ? `${icon} ${done}/${total}` : `${icon} plan`;
	const color = quest.status === "active" ? "warning" : "dim";
	ctx.ui.setStatus?.("quest", theme?.fg ? theme.fg(color, label) : label);
}
