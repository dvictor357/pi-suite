import { test } from "node:test";
import assert from "node:assert/strict";
import { ENHANCE_BUDGET, renderEnhancedBrief, type EnhanceContext } from "./enhance";

const empty: EnhanceContext = {
	project: null,
	user: null,
	archives: [],
	git: { branch: null, dirty: false },
};

const rich: EnhanceContext = {
	project: {
		name: "pi-suite",
		packageManager: "npm",
		language: "TypeScript",
		framework: null,
		designSystem: null,
		buildTool: "tsc",
		testRunner: "node:test",
		linter: null,
		formatter: "prettier",
		monorepo: true,
		directoryPattern: "extensions/*",
		conventions: ["tabs in code", "double quotes"],
		facts: [
			{
				scope: "project",
				priority: 8,
				text: "Ladder-eligible roles default to worker",
				createdAt: 1,
				updatedAt: 1,
			},
			{ scope: "project", priority: 2, text: "low priority noise", createdAt: 1, updatedAt: 1 },
		],
		research: { api: { value: "auth uses API keys from ~/.okx", timestamp: 1 } },
		agentModels: { scout: { model: "deepseek-v4-flash", thinkingLevel: "low", timestamp: 1 } },
		modelLadder: { rungs: ["ornith-1.0", "claude-opus-4-8"], approvedAt: 1 },
		lastScanned: 1,
	},
	user: {
		communication: "concise",
		commitStyle: "conventional commits",
		indent: null,
		quotes: null,
		preferredPackageManager: null,
		errorHandling: null,
		shell: null,
		conventions: ["always run tests"],
		facts: [],
		lastModified: 1,
	},
	archives: [{ name: "Add auth", goal: "wire up okx auth", steps: 3, done: 2 }],
	git: { branch: "feat/enhance", dirty: true },
};

test("renderEnhancedBrief preserves the raw goal verbatim", () => {
	const brief = renderEnhancedBrief("Ship the thing", "ship", empty);
	assert.ok(brief.startsWith("# Quest: ship\n\n## Goal\nShip the thing"));
});

test("empty context yields just the goal, no empty sections", () => {
	const brief = renderEnhancedBrief("Goal text", undefined, empty);
	assert.equal(brief, "# Quest: brief\n\n## Goal\nGoal text");
});

test("rich context renders each section", () => {
	const brief = renderEnhancedBrief("Goal text", "g", rich);
	assert.ok(brief.includes("## Project stack"));
	assert.ok(brief.includes("- Language: TypeScript"));
	assert.ok(brief.includes("- Monorepo: yes"));
	assert.ok(brief.includes("## Conventions"));
	assert.ok(brief.includes("- tabs in code"));
	assert.ok(brief.includes("## Project facts"));
	assert.ok(brief.includes("Ladder-eligible roles default to worker"));
	assert.ok(brief.includes("## Prior research"));
	assert.ok(brief.includes("auth uses API keys"));
	assert.ok(brief.includes("## Model assignments"));
	assert.ok(brief.includes("scout → deepseek-v4-flash (thinking: low)"));
	assert.ok(brief.includes("## Model ladder"));
	assert.ok(brief.includes("ornith-1.0 → claude-opus-4-8"));
	assert.ok(brief.includes("## User prefs"));
	assert.ok(brief.includes("- Commit style: conventional commits"));
	assert.ok(brief.includes("## Past quests"));
	assert.ok(brief.includes("Add auth: wire up okx auth (2/3 done)"));
	assert.ok(brief.includes("## Git"));
	assert.ok(brief.includes("(dirty working tree)"));
});

test("low-priority facts are excluded", () => {
	const brief = renderEnhancedBrief("g", undefined, rich);
	assert.ok(!brief.includes("low priority noise"));
});

test("clean git tree is marked clean", () => {
	const ctx = { ...empty, git: { branch: "main", dirty: false } };
	const brief = renderEnhancedBrief("g", undefined, ctx);
	assert.ok(brief.includes("- Branch: main (clean)"));
});

test("brief stays within the budget cap", () => {
	const hugeProject = {
		name: "x",
		packageManager: null,
		language: null,
		framework: null,
		designSystem: null,
		buildTool: null,
		testRunner: null,
		linter: null,
		formatter: null,
		monorepo: false,
		directoryPattern: null,
		conventions: Array.from({ length: 50 }, (_, i) => "convention ".repeat(100) + i),
		facts: Array.from({ length: 50 }, (_, i) => ({
			scope: "project" as const,
			priority: 9,
			text: "fact ".repeat(100) + i,
			createdAt: 1,
			updatedAt: 1,
		})),
		research: Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [
				`k${i}`,
				{ value: "r ".repeat(100) + i, timestamp: 1 },
			]),
		),
		lastScanned: 1,
	};
	const huge: EnhanceContext = { ...empty, project: hugeProject };
	const brief = renderEnhancedBrief("short goal", "g", huge);
	assert.ok(brief.length <= ENHANCE_BUDGET + "…(truncated)".length);
	assert.ok(brief.endsWith("…(truncated)"));
});
