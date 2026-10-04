import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, formatAgentList, loadAgentsFromDir, type AgentConfig } from "./agents.js";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minions-agents-"));
	tempDirs.push(dir);
	return dir;
}

function writeAgent(
	dir: string,
	filename: string,
	frontmatter: Record<string, string>,
	body = "Prompt body",
) {
	const fields = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	fs.writeFileSync(path.join(dir, filename), `---\n${fields}\n---\n\n${body}\n`, "utf8");
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadAgentsFromDir", () => {
	it("parses valid agent frontmatter", () => {
		const dir = makeTempDir();
		writeAgent(
			dir,
			"agent.md",
			{
				name: "test-agent",
				description: "Does test work",
				tools: "read, grep, bash",
				model: "provider/model",
				thinking: "low",
				tier: "fast",
			},
			"You are a test agent.",
		);

		const agents = loadAgentsFromDir(dir, "bundled");

		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			name: "test-agent",
			description: "Does test work",
			tools: ["read", "grep", "bash"],
			model: "provider/model",
			thinking: "low",
			tier: "fast",
			source: "bundled",
			systemPrompt: "You are a test agent.",
		});
		expect(agents[0].filePath).toBe(path.join(dir, "agent.md"));
	});

	it("skips invalid markdown files and non-markdown files", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "missing-name.md"),
			"---\ndescription: Missing name\n---\nBody",
			"utf8",
		);
		fs.writeFileSync(
			path.join(dir, "missing-description.md"),
			"---\nname: missing-description\n---\nBody",
			"utf8",
		);
		fs.writeFileSync(
			path.join(dir, "notes.txt"),
			"---\nname: txt\ndescription: ignored\n---\nBody",
			"utf8",
		);
		writeAgent(dir, "valid.md", { name: "valid", description: "Valid agent" });

		const agents = loadAgentsFromDir(dir, "user");

		expect(agents.map((agent) => agent.name)).toEqual(["valid"]);
		expect(agents[0].source).toBe("user");
	});

	it("skips a file with malformed YAML frontmatter instead of failing discovery", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "broken.md"),
			"---\nname: broken\ndescription: Verifier. Give it a claim: a diagnosis\n---\nBody",
			"utf8",
		);
		writeAgent(dir, "valid.md", { name: "valid", description: "Valid agent" });

		expect(loadAgentsFromDir(dir, "user").map((agent) => agent.name)).toEqual(["valid"]);
	});

	it("returns an empty list for missing directories", () => {
		const dir = path.join(makeTempDir(), "does-not-exist");

		expect(loadAgentsFromDir(dir, "project")).toEqual([]);
	});

	it("ignores invalid thinking levels and empty tier values", () => {
		const dir = makeTempDir();
		writeAgent(dir, "agent.md", {
			name: "careful",
			description: "Checks optional fields",
			thinking: "extreme",
			tier: "",
		});

		const [agent] = loadAgentsFromDir(dir, "project");

		expect(agent.thinking).toBeUndefined();
		expect(agent.tier).toBeUndefined();
	});
});

describe("discoverAgents", () => {
	it("loads bundled agents for project scope", () => {
		const cwd = makeTempDir();

		const result = discoverAgents(cwd, "project");

		expect(result.bundledAgentsDir).toContain(path.join("extensions", "subagent", "agents"));
		expect(result.agents.some((agent) => agent.source === "bundled")).toBe(true);
		expect(result.agents.map((agent) => agent.name)).toContain("worker");
	});

	it("every bundled agent parses and uses a block-scalar description", () => {
		const { bundledAgentsDir } = discoverAgents(makeTempDir(), "project");
		const files = fs.readdirSync(bundledAgentsDir!).filter((f) => f.endsWith(".md"));
		const loaded = loadAgentsFromDir(bundledAgentsDir!, "bundled");
		// A file that fails to parse is skipped silently, so compare counts.
		expect(loaded.length).toBe(files.length);
		for (const file of files) {
			const head = fs.readFileSync(path.join(bundledAgentsDir!, file), "utf8").split("\n---", 1)[0];
			// House style: `description: >-` so prose can hold ": ", "#" and quotes.
			expect(head, file).toMatch(/^description: >-$/m);
		}
	});

	it("lets project agents override bundled agents by name", () => {
		const cwd = makeTempDir();
		const projectAgentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		writeAgent(projectAgentsDir, "worker.md", {
			name: "worker",
			description: "Project worker override",
		});

		const result = discoverAgents(cwd, "project");
		const worker = result.agents.find((agent) => agent.name === "worker");

		expect(result.projectAgentsDir).toBe(projectAgentsDir);
		expect(worker).toMatchObject({
			name: "worker",
			description: "Project worker override",
			source: "project",
		});
	});

	it("uses user agents for user scope and ignores project overrides", () => {
		const cwd = makeTempDir();
		const userRoot = makeTempDir();
		const userAgentsDir = path.join(userRoot, "agents");
		const projectAgentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = userRoot;

		writeAgent(userAgentsDir, "worker.md", {
			name: "worker",
			description: "User worker override",
		});
		writeAgent(projectAgentsDir, "worker.md", {
			name: "worker",
			description: "Project worker override",
		});

		const result = discoverAgents(cwd, "user");
		const worker = result.agents.find((agent) => agent.name === "worker");

		expect(worker).toMatchObject({
			description: "User worker override",
			source: "user",
		});
	});

	it("lets project agents override user agents in both scope", () => {
		const cwd = makeTempDir();
		const userRoot = makeTempDir();
		const userAgentsDir = path.join(userRoot, "agents");
		const projectAgentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = userRoot;

		writeAgent(userAgentsDir, "worker.md", {
			name: "worker",
			description: "User worker override",
		});
		writeAgent(projectAgentsDir, "worker.md", {
			name: "worker",
			description: "Project worker override",
		});

		const result = discoverAgents(cwd, "both");
		const worker = result.agents.find((agent) => agent.name === "worker");

		expect(worker).toMatchObject({
			description: "Project worker override",
			source: "project",
		});
	});
});

describe("formatAgentList", () => {
	const agents: AgentConfig[] = [
		{
			name: "scout",
			description: "Finds context",
			source: "bundled",
			systemPrompt: "Scout prompt",
			filePath: "/tmp/scout.md",
		},
		{
			name: "worker",
			description: "Makes changes",
			source: "project",
			systemPrompt: "Worker prompt",
			filePath: "/tmp/worker.md",
		},
	];

	it("formats an empty list", () => {
		expect(formatAgentList([], 5)).toEqual({ text: "none", remaining: 0 });
	});

	it("formats listed agents and remaining count", () => {
		expect(formatAgentList(agents, 1)).toEqual({
			text: "scout (bundled): Finds context",
			remaining: 1,
		});
	});
});
