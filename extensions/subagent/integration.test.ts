import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { CONTRACT_VERSION, loadAgentModels, projectMemoryPath, writeJSON } from "../../core";
import {
	loadAgentModels as loadQuestModels,
	rememberAgentModel,
	routeStepFromDisk,
} from "../quest/storage";
import { loadCodebaseIndex, queryCodebaseIndex } from "../quest/codebase";
import { discoverAgents } from "./agents";
import { scanIndex } from "./codebase/query";
import { loadQuestAgentModels, resolveAgentRuntime } from "./index";

const roots: string[] = [];
function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-suite-integration-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(projectMemoryPath(root), { force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("shares Quest-approved models and thinking with the bundled runner", () => {
	const cwd = tempRoot();
	rememberAgentModel(cwd, "worker", {
		model: "approved-model",
		thinkingLevel: "medium",
		timestamp: 1,
	});
	expect(loadQuestModels).toBe(loadAgentModels);
	expect(loadQuestAgentModels).toBe(loadAgentModels);
	const worker = discoverAgents(cwd, "both").agents.find((a) => a.name === "worker")!;
	expect(worker.source).toBe("bundled");
	expect(resolveAgentRuntime(worker, cwd)).toEqual({ model: "approved-model", thinking: "medium" });
	expect(
		routeStepFromDisk(cwd, { agent: "worker", content: "Implement the feature" }),
	).toMatchObject({ model: "approved-model", thinking: "medium" });
});

it("ignores corrupt and future project memory consistently", () => {
	const cwd = tempRoot();
	const file = projectMemoryPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{broken");
	expect(loadQuestModels(cwd)).toEqual({});
	expect(loadQuestAgentModels(cwd)).toEqual({});
	writeJSON(file, {
		contractVersion: CONTRACT_VERSION + 1,
		agentModels: { worker: { model: "future" } },
	});
	const before = fs.readFileSync(file, "utf8");
	expect(loadAgentModels(cwd)).toEqual({});
	rememberAgentModel(cwd, "worker", { model: "overwrite", timestamp: 2 });
	expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("reads scanner output with Quest's cache reader and ranking", () => {
	const root = tempRoot();
	fs.writeFileSync(path.join(root, "helper.ts"), "export function uniqueHelper() { return 1; }\n");
	fs.writeFileSync(
		path.join(root, "main.ts"),
		'import { uniqueHelper } from "./helper";\nexport const answer = uniqueHelper();\n',
	);
	const scanned = scanIndex({ rootDir: root, force: true });
	const loaded = loadCodebaseIndex(root);
	expect(loaded.status).toBe("ok");
	if (loaded.status !== "ok") throw new Error("scanner cache unavailable");
	expect(loaded.index).toEqual(scanned.index);
	expect(queryCodebaseIndex(loaded.index, "uniqueHelper")[0].relativePath).toBe("helper.ts");
	expect(loaded.index.reverseDependencies["helper.ts"]).toContain("main.ts");
});

it("loads all five extensions with the pi loader without model calls", async () => {
	const root = path.resolve(import.meta.dirname, "../..");
	const paths = ["quest", "todo", "memory", "agent", "subagent"].map((name) =>
		path.join(root, "extensions", name, "index.ts"),
	);
	const loaded = await loadExtensions(paths, tempRoot());
	expect(loaded.errors).toEqual([]);
	expect(loaded.extensions).toHaveLength(5);
	const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
	expect(new Set(tools).size).toBe(tools.length);
	expect(tools).toEqual(
		expect.arrayContaining([
			"subagent",
			"subagent_message",
			"codebase",
			"quest_delegate",
			"agent_dashboard",
		]),
	);
	const minions = loaded.extensions.find((extension) => extension.path === paths[4])!;
	expect(minions.commands.has("subagent")).toBe(true);
}, 30_000);

it("keeps the SDK fallback isolated and streams through the parent registry", async () => {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { runSubAgent } = await import("../quest/subagent");
	const cwd = tempRoot();
	const extensionsDir = path.join(cwd, ".pi", "extensions");
	fs.mkdirSync(extensionsDir, { recursive: true });
	const marker = path.join(cwd, "extension-loaded");
	fs.writeFileSync(
		path.join(extensionsDir, "probe.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`,
	);
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: path.join(cwd, "auth.json"),
		modelsStorePath: path.join(cwd, "models-store.json"),
	});
	const model = runtime.getModels("anthropic")[0];
	expect(model).toBeDefined();
	let requests = 0;
	const ctx = {
		cwd,
		modelRegistry: {
			getRegisteredNativeProvider() {
				return undefined;
			},
			getRegisteredProviderConfig() {
				return undefined;
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "offline-smoke-key" };
			},
			streamSimple() {
				requests++;
				throw new Error("offline smoke: no provider request");
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
	const result = await runSubAgent(
		ctx,
		{ role: "scout", model, prompt: "Offline smoke", tools: [] },
		undefined,
	);
	expect(requests, JSON.stringify(result)).toBe(1);
	expect(fs.existsSync(marker)).toBe(false);
}, 30_000);
