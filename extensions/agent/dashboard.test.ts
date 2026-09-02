import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalEntry } from "../../core";
import type { QuestStep } from "../quest/types";
import type { DashboardStats } from "./dashboard-types";

const home = mkdtempSync(join(tmpdir(), "pi-suite-agent-dash-"));
process.env.HOME = home;

let fetchDashboard: typeof import("./dashboard").fetchDashboard;
let buildRecapMarkdown: typeof import("./report").buildRecapMarkdown;
let buildRecapJson: typeof import("./report").buildRecapJson;
let saveQuest: typeof import("../quest/storage").saveQuest;
let emptyQuest: typeof import("../quest/storage").emptyQuest;
let createEvalLog: typeof import("../../core/eval-logging").createEvalLog;
let writeSessionMeta: typeof import("../../core").writeSessionMeta;
let DEFAULT_RETRY_POLICY: typeof import("../../core").DEFAULT_RETRY_POLICY;
let CONTRACT_VERSION: typeof import("../../core").CONTRACT_VERSION;

before(async () => {
	({ fetchDashboard } = await import("./dashboard"));
	({ buildRecapMarkdown, buildRecapJson } = await import("./report"));
	({ saveQuest, emptyQuest } = await import("../quest/storage"));
	({ createEvalLog } = await import("../../core/eval-logging"));
	({ writeSessionMeta, DEFAULT_RETRY_POLICY, CONTRACT_VERSION } = await import("../../core"));
});

after(() => rmSync(home, { recursive: true, force: true }));

const metaPath = join(home, ".pi", "agent", "session-meta.json");

function resetSessionMeta() {
	if (existsSync(metaPath)) rmSync(metaPath);
}

const DAY = 1_700_000_000_000; // 2023-11-14 UTC

function tempCwd(label: string): string {
	return mkdtempSync(join(tmpdir(), `pi-suite-agent-${label}-`));
}

function step(overrides: Partial<QuestStep> & Pick<QuestStep, "content">): QuestStep {
	return {
		status: "pending",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 0,
		startedAt: null,
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
		...overrides,
	};
}

function evalEntry(overrides: Partial<EvalEntry>): EvalEntry {
	return {
		quest: "q",
		questSlug: "q",
		taskIndex: 0,
		taskContent: "t",
		agent: "worker",
		model: "ornith-1.0",
		status: "done",
		verified: true,
		verifyEvidence: null,
		durationMs: 1000,
		tokensIn: 0,
		tokensOut: 0,
		attempts: 0,
		timestamp: DAY,
		...overrides,
	};
}

describe("fetchDashboard", () => {
	test("returns an empty DashboardStats shape when sources are missing", async () => {
		resetSessionMeta();
		const stats = await fetchDashboard(tempCwd("missing"), DAY);
		assert.deepEqual(stats.session, { extensions: {} });
		assert.deepEqual(stats.agents, []);
		assert.deepEqual(stats.goals, []);
		assert.deepEqual(stats.cycles, []);
		assert.deepEqual(stats.trends, []);
		assert.equal(stats.health.maxBurst, DEFAULT_RETRY_POLICY.maxBurst);
		assert.equal(stats.health.maxConcurrent, 1);
		assert.equal(stats.health.activeQuests, 0);
		assert.equal(stats.health.pausedQuests, 0);
		assert.equal(stats.health.stalled, 0);
		assert.match(stats.health.defaultRetryPolicy, /retries=/);
		assert.equal(stats.sessionMetaTimestamp, DAY);
	});

	test("maps the active quest into agents, goals, and health", async () => {
		resetSessionMeta();
		const cwd = tempCwd("quest");
		const quest = emptyQuest(
			"Ship i10",
			"dashboard",
			undefined,
			"auto",
			true,
			undefined,
			undefined,
			{
				enabled: true,
				maxConcurrent: 3,
			},
		);
		quest.status = "active";
		quest.planApproved = true;
		quest.pauseReason = null;
		quest.steps = [
			step({
				content: "implement",
				status: "running",
				agent: "worker",
				lastModel: "ornith-1.0",
				startedAt: DAY + 1000,
			}),
			step({
				content: "review",
				status: "pending",
				agent: "reviewer",
				model: "mythos-5",
			}),
			step({
				content: "failed scout",
				status: "failed",
				agent: "scout",
				phase: "blocked",
				lastModel: "ornith-1.0",
			}),
			step({
				content: "done bit",
				status: "done",
				agent: "worker",
				completedAt: DAY + 2000,
				verified: true,
			}),
		];
		saveQuest(quest, cwd);

		const stats = await fetchDashboard(cwd, DAY + 60_000);
		assert.equal(stats.goals.length, 1);
		assert.equal(stats.goals[0].name, "Ship i10");
		assert.equal(stats.goals[0].planApproved, true);
		assert.equal(stats.goals[0].status, "active");
		assert.equal(stats.goals[0].totalSteps, 4);
		assert.equal(stats.goals[0].totalDone, 1);
		assert.equal(stats.goals[0].active, 1);

		const byRole = Object.fromEntries(stats.agents.map((a) => [a.agent, a]));
		assert.equal(byRole.worker.roleType, "worker");
		assert.equal(byRole.worker.model, "ornith-1.0");
		assert.equal(byRole.worker.status, "active");
		assert.equal(byRole.worker.activeSteps, 1);
		assert.equal(byRole.worker.queuedSteps, 0);
		assert.equal(byRole.reviewer.roleType, "reviewer");
		assert.equal(byRole.reviewer.queuedSteps, 1);
		assert.equal(byRole.scout.failedSteps, 1);

		assert.equal(stats.health.activeQuests, 1);
		assert.equal(stats.health.pausedQuests, 0);
		assert.equal(stats.health.maxConcurrent, 3);
		assert.equal(stats.health.stalled, 1);
		assert.equal(stats.health.maxBurst, DEFAULT_RETRY_POLICY.maxBurst);
	});

	test("reads eval JSONL into cycles and trends instead of invented cwd paths", async () => {
		resetSessionMeta();
		const cwd = tempCwd("evals");
		createEvalLog(
			cwd,
			"quest-a",
		)(
			evalEntry({
				status: "done",
				verified: true,
				durationMs: 2000,
				escalations: 1,
			}),
		);
		createEvalLog(
			cwd,
			"quest-a",
		)(
			evalEntry({
				status: "failed",
				verified: false,
				durationMs: 1000,
				escalations: 0,
				taskIndex: 1,
			}),
		);
		createEvalLog(
			cwd,
			"quest-b",
		)(
			evalEntry({
				agent: "scout",
				model: "mythos-5",
				status: "done",
				verified: true,
				durationMs: 3000,
			}),
		);

		const stats = await fetchDashboard(cwd, DAY);
		const worker = stats.cycles.find((c) => c.name === "worker");
		const scout = stats.cycles.find((c) => c.name === "scout");
		assert.ok(worker);
		assert.equal(worker.steps, 2);
		assert.equal(worker.done, 1);
		assert.ok(scout);
		assert.equal(scout.done, 1);

		assert.equal(stats.trends.length, 1);
		assert.equal(stats.trends[0].date, "2023-11-14");
		assert.equal(stats.trends[0].totalSteps, 3);
		assert.equal(stats.trends[0].escalations, 1);
		assert.equal(stats.trends[0].averageTurnDurationMs, Math.round((2000 + 1000 + 3000) / 3));
		assert.equal(stats.trends[0].completedToday, Math.round((2 / 3) * 3));
	});

	test("surfaces session-meta without writing an agent ExtensionKey", async () => {
		resetSessionMeta();
		const cwd = tempCwd("meta");
		writeSessionMeta("quest", cwd, { name: "Ship i10", status: "active", done: 1, total: 4 });
		const stats = await fetchDashboard(cwd, DAY);
		assert.equal(stats.session.cwd, cwd);
		assert.equal(stats.session.extensions?.quest?.name, "Ship i10");
		assert.equal(
			Object.prototype.hasOwnProperty.call(stats.session.extensions ?? {}, "agent"),
			false,
			"must not write an illegal agent ExtensionKey",
		);
		assert.equal(typeof stats.sessionMetaTimestamp, "number");
		assert.ok(stats.sessionMetaTimestamp > 0);
	});

	test("degrades session to an empty shell for a future-version file", async () => {
		resetSessionMeta();
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			metaPath,
			JSON.stringify({
				contractVersion: CONTRACT_VERSION + 1,
				extensions: { quest: { name: "future" } },
			}),
			"utf8",
		);
		const stats = await fetchDashboard(tempCwd("future"), DAY);
		assert.deepEqual(stats.session, { extensions: {} });
	});
});

describe("recap", () => {
	const sample: DashboardStats = {
		session: { extensions: {}, updatedAt: DAY },
		agents: [
			{
				agent: "worker",
				role: "worker",
				roleType: "worker",
				model: "ornith-1.0",
				status: "active",
				messageRate: 0,
				activeSteps: 1,
				queuedSteps: 0,
				failedSteps: 0,
			},
		],
		goals: [],
		cycles: [
			{
				name: "worker",
				status: "active",
				active: 1,
				completed: 2,
				startedToday: 1,
				completedToday: 0,
				steps: 3,
				done: 2,
			},
		],
		trends: [
			{
				date: "2023-11-14",
				totalSteps: 3,
				active: 1,
				completed: 2,
				completedToday: 2,
				averageTurnDurationMs: 1500,
				escalations: 1,
			},
		],
		health: {
			maxConcurrent: 1,
			maxBurst: 6,
			defaultRetryPolicy: "retries=2 burst=6 verify=2",
			activeQuests: 1,
			pausedQuests: 0,
			stalled: 0,
			modelAvailability: {},
			knownIssues: [],
		},
		sessionMetaTimestamp: DAY,
	};

	test("buildRecapMarkdown renders sections from DashboardStats", () => {
		const markdown = buildRecapMarkdown(sample);
		assert.match(markdown, /^# Agent Performance Recap/m);
		assert.match(markdown, /generated: 2023-11-14T/);
		assert.doesNotMatch(markdown, /1970-01-01/);
		assert.match(markdown, /\*\*worker\*\*: 1 active \/ 2 done/);
		assert.match(markdown, /\*\*worker\*\* \(worker → ornith-1\.0\)/);
		assert.match(markdown, /\| 2023-11-14 \| 3 \| 1 \| 2 \| 1500 \| 1 \|/);
		assert.match(markdown, /Max concurrent: 1/);
		assert.match(markdown, /Retry policy: retries=2 burst=6 verify=2/);
	});

	test("buildRecapJson exposes health as an object and includes goals", () => {
		const json = buildRecapJson(sample);
		assert.equal(Array.isArray(json.health), false);
		assert.equal((json.health as { maxBurst: number }).maxBurst, 6);
		assert.ok(Array.isArray(json.goals));
		assert.ok(Array.isArray(json.agents));
		assert.equal((json.agents as { model: string }[])[0].model, "ornith-1.0");
	});
});
