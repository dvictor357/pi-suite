/**
 * Agent discovery and configuration
 */

import { THINKING_LEVELS as THINKING_LEVEL_VALUES } from "../../core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isJsonSchema, type JsonSchema } from "./contract.js";

export type AgentScope = "user" | "project" | "both";

const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Per-agent thinking level (off|minimal|low|medium|high|xhigh). Lets cheap
	 *  agents (recon, mechanical edits) skip the expensive xhigh default.
	 *  Overrides whatever the agent's `tier` would resolve to. */
	thinking?: string;
	/** Tier name (e.g. "fast" | "reasoning"). Resolved to a concrete model +
	 *  thinking level via the `subagent` block in settings.json, so the model can
	 *  be changed in one place instead of editing every agent file. An explicit
	 *  `model`/`thinking` here still wins over the tier. */
	tier?: string;
	/** JSON Schema the agent's final answer must satisfy (frontmatter
	 *  `output:`, written as YAML). Enforced by the subagent tool. */
	output?: JsonSchema;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	bundledAgentsDir: string | null;
}

/** Resolve the bundled agents directory shipped with this extension. */
function getBundledAgentsDir(): string | null {
	try {
		const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "agents");
		return fs.existsSync(dir) ? dir : null;
	} catch {
		return null;
	}
}

export function loadAgentsFromDir(
	dir: string,
	source: "user" | "project" | "bundled",
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// One malformed file (e.g. an unquoted description containing ": ") must
		// not take down discovery for every other agent.
		let parsed: { frontmatter: Record<string, string>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, string>>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const thinking =
			typeof frontmatter.thinking === "string" && THINKING_LEVELS.has(frontmatter.thinking.trim())
				? frontmatter.thinking.trim()
				: undefined;

		const tier =
			typeof frontmatter.tier === "string" && frontmatter.tier.trim()
				? frontmatter.tier.trim()
				: undefined;

		// YAML frontmatter can hold a nested schema; anything but a mapping is ignored.
		const rawOutput = (frontmatter as Record<string, unknown>).output;
		const output = isJsonSchema(rawOutput) ? rawOutput : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking,
			tier,
			output,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledAgentsDir = getBundledAgentsDir();

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const bundledAgents = bundledAgentsDir ? loadAgentsFromDir(bundledAgentsDir, "bundled") : [];

	const agentMap = new Map<string, AgentConfig>();

	// Bundled agents are the base — user/project agents override by name
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		bundledAgentsDir,
	};
}

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
