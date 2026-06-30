/**
 * quest/deprecation.ts — subtle internal deprecation observability.
 *
 * When old task-named parameters are used where a step-named alternative exists,
 * this module logs an unobtrusive structured entry to a developer observability
 * file. The log is never shown to users — it exists only so maintainers can see
 * whether old entry points are still in active use before eventually removing them.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIR } from "./constants";

const DEPRECATION_LOG = join(AGENT_DIR, "quests", "deprecation.log");

/**
 * Log a structured deprecation notice when `oldKey` is present in `params` but
 * `newKey` is not. The caller is responsible for the actual parameter resolution
 * (preferring the new key); this is a pure observability side-effect that never
 * throws.
 */
export function logDeprecatedParam(
	toolName: string,
	params: Record<string, unknown>,
	oldKey: string,
	newKey: string,
): void {
	if (params[newKey] !== undefined) return; // user used the new key — nothing to log
	if (params[oldKey] === undefined) return; // old key wasn't used either — nothing to log

	try {
		const entry = {
			ts: new Date().toISOString(),
			tool: toolName,
			used: oldKey,
			prefer: newKey,
		};
		appendFileSync(DEPRECATION_LOG, JSON.stringify(entry) + "\n", "utf8");
	} catch {
		/* best-effort observability — never fail on logging */
	}
}
