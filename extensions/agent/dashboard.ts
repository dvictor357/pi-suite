import {
	DEFAULT_RETRY_POLICY,
	computeEvalStats,
	computeEvalTimeSeries,
	readAllEvalEntries,
	readSessionMeta,
} from "../../core";
import type { EvalStatsIndex, EvalTimeSeries } from "../../core";
import { loadQuest } from "../quest/storage";
import type { Quest, QuestStatus, QuestStep } from "../quest/types";
import type {
	DashboardAgent,
	DashboardCycle,
	DashboardGoal,
	DashboardHealth,
	DashboardRoleType,
	DashboardStats,
	DashboardTrend,
} from "./dashboard-types";

const ROLE_TYPES: readonly DashboardRoleType[] = [
	"worker",
	"quick-worker",
	"scout",
	"planner",
	"verifier",
	"reviewer",
];

function roleTypeOf(role: string): DashboardRoleType {
	const normalized = role.trim().toLowerCase();
	return ROLE_TYPES.includes(normalized as DashboardRoleType)
		? (normalized as DashboardRoleType)
		: "worker";
}

function startOfUtcDay(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoOrNull(ms: number | null | undefined): string | null {
	return typeof ms === "number" && Number.isFinite(ms) && ms > 0
		? new Date(ms).toISOString()
		: null;
}

function mapGoalStatus(status: QuestStatus): DashboardGoal["status"] {
	switch (status) {
		case "paused":
			return "paused";
		case "done":
			return "completed";
		case "idle":
			return "abandoned";
		default:
			return "active";
	}
}

function isLiveStep(step: QuestStep): boolean {
	return step.status === "running" || step.status === "verifying";
}

function buildAgents(quest: Quest | null): DashboardAgent[] {
	if (!quest) return [];
	const groups = new Map<string, QuestStep[]>();
	for (const step of quest.steps) {
		const role = step.agent.trim() || "worker";
		const list = groups.get(role) ?? [];
		list.push(step);
		groups.set(role, list);
	}
	const agents: DashboardAgent[] = [];
	for (const [role, steps] of groups) {
		const running = steps.filter(isLiveStep).length;
		const queued = steps.filter((s) => s.status === "pending").length;
		const failed = steps.filter((s) => s.status === "failed").length;
		const modeled = [...steps].reverse().find((s) => s.lastModel || s.model);
		let status: DashboardAgent["status"] = "idle";
		if (quest.status === "paused") status = "paused";
		else if (running > 0 || quest.status === "active" || quest.status === "planning") {
			status = "active";
		}
		agents.push({
			agent: role,
			role,
			roleType: roleTypeOf(role),
			model: modeled?.lastModel ?? modeled?.model ?? "",
			status,
			messageRate: 0,
			activeSteps: running,
			queuedSteps: queued,
			failedSteps: failed,
		});
	}
	return agents;
}

function buildGoals(quest: Quest | null, now: number): DashboardGoal[] {
	if (!quest) return [];
	const today = startOfUtcDay(now);
	const steps = quest.steps;
	const done = steps.filter((s) => s.status === "done").length;
	return [
		{
			name: quest.name,
			planApproved: quest.planApproved,
			status: mapGoalStatus(quest.status),
			goalCount: 1,
			completed: done,
			active: steps.filter(isLiveStep).length,
			startedToday: steps.filter((s) => s.startedAt != null && s.startedAt >= today).length,
			completedToday: steps.filter((s) => s.completedAt != null && s.completedAt >= today).length,
			totalSteps: steps.length,
			totalDone: done,
			completedAt: isoOrNull(quest.completedAt),
			statusAt: isoOrNull(quest.updatedAt),
		},
	];
}

function buildCycles(index: EvalStatsIndex, quest: Quest | null, now: number): DashboardCycle[] {
	const today = startOfUtcDay(now);
	const roles = new Set<string>();
	for (const stats of index.values()) roles.add(stats.agent);
	if (quest) {
		for (const step of quest.steps) roles.add(step.agent.trim() || "worker");
	}
	const cycles: DashboardCycle[] = [];
	for (const role of [...roles].sort()) {
		let samples = 0;
		let verifiedPasses = 0;
		for (const stats of index.values()) {
			if (stats.agent === role) {
				samples += stats.samples;
				verifiedPasses += stats.verifiedPasses;
			}
		}
		const steps = quest?.steps.filter((s) => (s.agent.trim() || "worker") === role) ?? [];
		const liveActive = steps.filter((s) => isLiveStep(s) || s.status === "pending").length;
		const liveDone = steps.filter((s) => s.status === "done").length;
		const historical = steps.length === 0;
		let status: DashboardCycle["status"] = historical ? "completed" : "active";
		if (quest?.status === "paused") status = "paused";
		else if (quest?.status === "idle") status = "abandoned";
		else if (
			quest?.status === "done" ||
			(steps.length > 0 && liveActive === 0 && liveDone === steps.length)
		) {
			status = "completed";
		}
		cycles.push({
			name: role,
			status,
			active: historical ? 0 : liveActive,
			completed: historical ? verifiedPasses : liveDone,
			startedToday: steps.filter((s) => s.startedAt != null && s.startedAt >= today).length,
			completedToday: steps.filter((s) => s.completedAt != null && s.completedAt >= today).length,
			steps: historical ? samples : steps.length,
			done: historical ? verifiedPasses : liveDone,
		});
	}
	return cycles;
}

function buildTrends(series: EvalTimeSeries, now: number): DashboardTrend[] {
	const today = new Date(now).toISOString().slice(0, 10);
	return series.buckets.map((bucket) => {
		const completed = Math.round(bucket.passRate * bucket.samples);
		return {
			date: bucket.date,
			totalSteps: bucket.samples,
			active: Math.max(0, bucket.samples - completed),
			completed,
			completedToday: bucket.date === today ? completed : 0,
			averageTurnDurationMs: bucket.avgDurationMs,
			escalations: bucket.escalations,
		};
	});
}

function retryPolicyLabel(): string {
	return `${DEFAULT_RETRY_POLICY.maxRetries} retries, burst ${DEFAULT_RETRY_POLICY.maxBurst}, ${DEFAULT_RETRY_POLICY.maxVerifyRetries} verify retries`;
}

function buildHealth(quest: Quest | null): DashboardHealth {
	const stalled = quest
		? quest.steps.filter((s) => s.phase === "blocked" || s.status === "failed").length
		: 0;
	const knownIssues = quest?.pauseReason ? [quest.pauseReason] : [];
	const maxConcurrent = quest?.parallel?.enabled === true ? (quest.parallel.maxConcurrent ?? 1) : 1;
	return {
		maxConcurrent,
		maxBurst: DEFAULT_RETRY_POLICY.maxBurst,
		defaultRetryPolicy: retryPolicyLabel(),
		activeQuests: quest && (quest.status === "active" || quest.status === "planning") ? 1 : 0,
		pausedQuests: quest?.status === "paused" ? 1 : 0,
		stalled,
		modelAvailability: {},
		knownIssues,
	};
}

function emptyStats(now: number): DashboardStats {
	return {
		session: { extensions: {} },
		agents: [],
		goals: [],
		cycles: [],
		trends: [],
		health: buildHealth(null),
		sessionMetaTimestamp: now,
	};
}

/** Best-effort dashboard for cwd. Missing sources leave the matching fields empty. */
export async function fetchDashboard(cwd: string, now = Date.now()): Promise<DashboardStats> {
	try {
		const session = readSessionMeta();
		const quest = loadQuest(cwd);
		const entries = readAllEvalEntries(cwd);
		const index = computeEvalStats(entries);
		const series = computeEvalTimeSeries(entries);
		return {
			session,
			agents: buildAgents(quest),
			goals: buildGoals(quest, now),
			cycles: buildCycles(index, quest, now),
			trends: buildTrends(series, now),
			health: buildHealth(quest),
			sessionMetaTimestamp: session.updatedAt ?? now,
		};
	} catch {
		return emptyStats(now);
	}
}
