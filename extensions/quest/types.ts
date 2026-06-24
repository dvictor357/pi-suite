export type QuestStatus = "planning" | "active" | "paused" | "done" | "idle";
export type TaskStatus = "pending" | "running" | "verifying" | "done" | "failed" | "skipped";

export interface QuestTask {
	content: string;
	status: TaskStatus;
	agent: string;
	/**
	 * Model the orchestrator assigned to this task's sub-agent, once the user has
	 * approved it via `quest_assign_model`. Empty/undefined means "use the harness
	 * default for this agent role". Stored as the registry/harness model id.
	 */
	model?: string;
	context: string;
	dependencies: number[];
	result: string | null;
	attempts: number;
	startedAt: number | null;
	completedAt: number | null;
	verified: boolean;
	verifyResult: string | null;
	verifyRetries: number;
	commitHash: string | null;
	branchName: string | null;
}

export interface GitIntegration {
	autoCommit: boolean;
	autoBranch: boolean;
	autoPR: boolean;
	branchPrefix: string;
}

export interface Quest {
	version: 1;
	name: string;
	goal: string;
	status: QuestStatus;
	tasks: QuestTask[];
	tasksSincePause: number;
	lastFiredTaskIndex: number;
	sameTaskCount: number;
	pauseReason: string | null;
	conventions: string[];
	team?: string;
	planningMode: "auto" | "approve";
	planApproved: boolean;
	verifyOnComplete: boolean;
	gitIntegration?: GitIntegration;
	commits: {
		taskIndex: number;
		hash: string;
		message: string;
		branch?: string;
		timestamp: number;
	}[];
	researchFindings?: { key: string; value: string; category?: string; timestamp: number }[];
	createdAt: number;
	completedAt: number | null;
	updatedAt: number;
}

export interface TeamConfig {
	name: string;
	description: string;
	lead: string;
	members: { role: string; agent: string }[];
	defaultAgent: string;
	verification: boolean;
	agents?: { name: string; description: string; markdown: string }[];
	/**
	 * Optional per-agent-role model suggestions (agent role → model id) the team
	 * recommends, e.g. a fast/cheap model for "scout" and a strong model for
	 * "worker". Advisory only: the orchestrator may override, and the user always
	 * gets the final say via `quest_assign_model`.
	 */
	modelHints?: Record<string, string>;
}

// The todo-sync shapes are the cross-extension pi-todo contract — re-exported
// from core so quest and pi-todo can never drift apart.
export type {
	TodoStatus as SyncedTodoStatus,
	TodoItem as SyncedTodoItem,
	TodoList as SyncedTodoList,
} from "../../core";
