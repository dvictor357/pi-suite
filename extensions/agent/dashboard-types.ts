import type { SessionMeta } from "../../core";

export type DashboardRoleType =
	| "worker"
	| "quick-worker"
	| "scout"
	| "planner"
	| "verifier"
	| "reviewer";

export interface DashboardAgent {
	agent: string;
	role: string;
	roleType: DashboardRoleType;
	model: string;
	status: "active" | "paused" | "idle";
	messageRate: number;
	activeSteps: number;
	queuedSteps: number;
	failedSteps: number;
}

export interface DashboardGoal {
	name: string;
	planApproved: boolean;
	status: "active" | "paused" | "completed" | "abandoned";
	goalCount: number;
	completed: number;
	active: number;
	startedToday: number;
	completedToday: number;
	totalSteps: number;
	totalDone: number;
	completedAt: string | null;
	statusAt: string | null;
}

export interface DashboardCycle {
	name: string;
	status: "active" | "paused" | "completed" | "abandoned";
	active: number;
	completed: number;
	startedToday: number;
	completedToday: number;
	steps: number;
	done: number;
}

export interface DashboardTrend {
	date: string;
	totalSteps: number;
	active: number;
	completed: number;
	completedToday: number;
	averageTurnDurationMs: number;
	escalations: number;
}

export interface DashboardHealth {
	maxConcurrent: number;
	maxBurst: number;
	defaultRetryPolicy: string;
	activeQuests: number;
	pausedQuests: number;
	stalled: number;
	modelAvailability: Record<string, boolean>;
	knownIssues: string[];
}

export interface DashboardStats {
	session: SessionMeta;
	agents: DashboardAgent[];
	goals: DashboardGoal[];
	cycles: DashboardCycle[];
	trends: DashboardTrend[];
	health: DashboardHealth;
	sessionMetaTimestamp: number;
}
