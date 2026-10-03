/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Pipeline: { items: [...], stages: [{ agent, task: "... {item} ..." }, ...] }
 *
 * Single and parallel modes can run writer agents in isolated git worktrees
 * (`isolation: "worktree"`); see ./worktree.ts.
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Entry point only: the implementation that used to live in one ~3,250-line
 * file is split by concern, mirroring quest's register-* layout:
 *
 *   - constants.ts          concurrency/retry/timeout/output caps
 *   - render.ts             result types, formatting, progress payloads
 *   - isolation.ts          worktree isolation + concurrent write-claim checks
 *   - runner.ts             child `pi` spawn, runtime resolution, retry, output contract
 *   - schema.ts             typebox params for the subagent and codebase tools
 *   - execute.ts            mode dispatch (single/parallel/chain/pipeline) + run history
 *   - register-subagent.ts  the `subagent` tool
 *   - register-codebase.ts  the `codebase` tool
 *   - register-command.ts   the /subagent command
 *   - register-messaging.ts the `subagent_message` tool
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodebaseTool } from "./register-codebase.js";
import { registerSubagentCommand } from "./register-command.js";
import { registerMessaging } from "./register-messaging.js";
import { registerSubagentTool } from "./register-subagent.js";

export { executeWithHistory } from "./execute.js";
export {
	type IsolationContext,
	prepareIsolation,
	runIsolated,
	validateConcurrentWriteClaims,
} from "./isolation.js";
export {
	buildProgressPayload,
	buildToolActivity,
	type SingleResult,
	type SubagentDetails,
	type SubagentProgress,
} from "./render.js";
export {
	attachAbortKillFallback,
	enforceOutputContract,
	loadQuestAgentModels,
	recordSpawnError,
	resolveAgentRuntime,
	type RuntimeOverride,
	runAgentWithRetry,
	runSingleAgent,
} from "./runner.js";
export { CodebaseOperation, CodebaseParams, SubagentParams } from "./schema.js";

export default function (pi: ExtensionAPI) {
	registerMessaging(pi);
	registerSubagentTool(pi);
	registerCodebaseTool(pi);
	registerSubagentCommand(pi);
}
