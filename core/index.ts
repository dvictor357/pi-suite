/**
 * @pi-suite/core — the shared cross-extension contract for the pi-suite
 * extensions (pi-quest, pi-todo, pi-memory).
 *
 * Extensions import from here instead of re-declaring storage shapes, paths, or
 * helpers. This is the only module all three depend on; see ./contract for the
 * versioned on-disk contract and core/README.md for the rationale.
 */
export { CONTRACT_VERSION, isFutureContract } from "./contract";
export type {
	ExtensionKey,
	SessionMeta,
	TodoStatus,
	TodoItem,
	TodoList,
	MemoryFact,
	ProjectMemory,
	AgentModelChoice,
	ModelLadderConfig,
	ProjectResearchFinding,
	UserMemory,
	NodeKind,
	EdgeKind,
	MemoryNode,
	MemoryEdge,
	MemoryGraph,
} from "./contract";

export { cwdHash } from "./hash";
export { readJSON, writeJSON, updateJSON, appendLine, setErrorSink } from "./fs";
export { AGENT_DIR, SESSION_META_PATH, todoListPath, projectMemoryPath } from "./paths";
export { readSessionMeta, writeSessionMeta } from "./session-meta";
export {
	MAX_RETRIES,
	MAX_BURST,
	MAX_VERIFY_RETRIES,
	MAX_DEPENDENCY_DEPTH,
	MAX_ESCALATIONS,
	DEFAULT_RETRY_POLICY,
} from "./retry-policy";
export type { RetryPolicy } from "./retry-policy";
export { createRunLedger, recordRunEvent, runLedgerPath, runsDir } from "./run-ledger";
export type { RunLedger, RunEvent, RunEventKind } from "./run-ledger";
export { createEvalLog, recordEvalEntry, evalLogPath, evalsDir } from "./eval-logging";
export type { EvalLog, EvalEntry } from "./eval-logging";
export { readAllEvalEntries, computeEvalStats, statsFor, statsKey } from "./eval-stats";
export type { RoleModelStats, EvalStatsIndex } from "./eval-stats";
export { asRecord, strArray, boolOr, numOr, strOr, optStr, optNum, oneOf } from "./coerce";
export {
	CONTEXT_BUDGET,
	budgetForModel,
	isSmallModel,
	isConstrainedModel,
	verbosityForModel,
	clampToBudget,
} from "./context-budget";
export type { BudgetModelInfo, ContextBudgetConfig, Verbosity } from "./context-budget";

import { join } from "node:path";
import { appendLine, setErrorSink } from "./fs";
import { AGENT_DIR } from "./paths";

/** Shared suite-wide error log. One file for all three extensions. */
export const ERROR_LOG_PATH = join(AGENT_DIR, "pi-suite-errors.log");

/**
 * Install a default error sink the moment any extension imports core, so a
 * failed read/write is captured in a shared log instead of being silently
 * black-holed (the previous no-op default). All three extensions share one
 * core module instance at runtime, so a single suite-wide log is both simpler
 * and more coherent than three competing per-extension sinks. Tests or an
 * extension may still override this via `setErrorSink`.
 */
setErrorSink((context, error) => {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	appendLine(ERROR_LOG_PATH, `[${new Date().toISOString()}] ${context}: ${detail}`);
});
