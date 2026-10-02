import { THINKING_LEVELS, isFutureContract, type AgentModelChoice } from "./contract";
import { asRecord, optStr, numOr, oneOf } from "./coerce";
import { readJSON } from "./fs";
import { projectMemoryPath } from "./paths";

/**
 * Read the project's remembered role → model assignments (written by
 * `quest_assign_model`). Returns an empty map when memory is absent or written
 * by a newer contract than this code understands.
 */
export function loadAgentModels(cwd: string): Record<string, AgentModelChoice> {
	const blob = readJSON<unknown>(projectMemoryPath(cwd), null);
	const memory = isFutureContract(asRecord(blob)) ? {} : asRecord(blob);
	const models = asRecord(memory?.agentModels);
	const choices: Record<string, AgentModelChoice> = {};
	for (const [role, value] of Object.entries(models)) {
		const raw = asRecord(value);
		const model = optStr(raw.model)?.trim();
		if (!model) continue;
		choices[role] = {
			model,
			provider: optStr(raw.provider),
			thinkingLevel: oneOf(raw.thinkingLevel, THINKING_LEVELS) ? raw.thinkingLevel : undefined,
			reason: optStr(raw.reason),
			timestamp: numOr(raw.timestamp, 0),
		};
	}
	return choices;
}
