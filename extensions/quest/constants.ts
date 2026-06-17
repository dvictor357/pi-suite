import { join } from "node:path";
import { AGENT_DIR } from "../../core";
import type { TaskStatus, TeamConfig } from "./types";

export const MAX_BURST = 6;
export const MAX_RETRIES = 2;
export const MAX_VERIFY_RETRIES = 2;
export const MAX_DEPENDENCY_DEPTH = 3;

/**
 * Language-agnostic code-hygiene directive injected into steering and verification.
 * It deliberately names no specific tool or language — the agent must detect and
 * use whatever formatter/linter the project itself already relies on.
 */
export const FORMAT_DIRECTIVE = [
	"**Before marking a code task done:** apply this project's own formatting and lint conventions.",
	"Detect the tooling the codebase already uses — a format/lint script in its manifest, a config file",
	"(e.g. .editorconfig or a formatter/linter config), or the standard tool for its language/ecosystem —",
	"then run it and confirm the working tree is clean and consistent. Do NOT assume a specific language",
	"or tool, and do NOT impose a style the project doesn't already use; adapt to this codebase.",
].join(" ");

export { AGENT_DIR };
export const ACTIVE_PATH = join(AGENT_DIR, "quests", "active.json");
export const ARCHIVE_DIR = join(AGENT_DIR, "quests", "archive");
export const ARCHIVE_INDEX_PATH = join(ARCHIVE_DIR, "archive-index.json");
export const TEAMS_DIR = join(AGENT_DIR, "quests", "teams");
export const ERROR_LOG_PATH = join(AGENT_DIR, "quests", "error.log");

export const ICON: Record<TaskStatus, string> = {
	pending: "☐",
	running: "▶",
	verifying: "🔍",
	done: "☑",
	failed: "✗",
	skipped: "⏭",
};

export const BUILT_IN_TEAMS: Record<string, TeamConfig> = {
	engineering: {
		name: "engineering",
		description: "Balanced team for feature development with code review and testing",
		lead: "worker",
		members: [
			{ role: "developer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
			{ role: "tester", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	research: {
		name: "research",
		description: "Exploration-first team with scout, planner, and worker support",
		lead: "scout",
		members: [
			{ role: "explorer", agent: "scout" },
			{ role: "planner", agent: "planner" },
			{ role: "implementer", agent: "worker" },
			{ role: "reviewer", agent: "reviewer" },
		],
		defaultAgent: "scout",
		verification: true,
	},
	content: {
		name: "content",
		description: "Content creation team with writer, editor, and reviewer roles",
		lead: "worker",
		members: [
			{ role: "writer", agent: "worker" },
			{ role: "editor", agent: "reviewer" },
			{ role: "fact-checker", agent: "scout" },
		],
		defaultAgent: "worker",
		verification: true,
	},
	devops: {
		name: "devops",
		description: "Infrastructure and deployment team with CI/CD, cloud, and security roles",
		lead: "worker",
		members: [
			{ role: "infra", agent: "worker" },
			{ role: "security", agent: "reviewer" },
			{ role: "monitoring", agent: "scout" },
			{ role: "release", agent: "verifier" },
		],
		defaultAgent: "worker",
		verification: true,
	},
};
