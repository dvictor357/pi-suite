import { SESSION_META_PATH } from "./paths";
import { cwdHash } from "./hash";
import { readJSON, updateJSON } from "./fs";
import { CONTRACT_VERSION, isFutureContract } from "./contract";
import type { ExtensionKey, SessionMeta } from "./contract";

/**
 * Read the shared session-meta file, returning an empty shell if absent,
 * corrupt, or written by a newer contract than this code understands (in which
 * case its shape can't be trusted — degrade to empty rather than misread it).
 */
export function readSessionMeta(): SessionMeta {
	const meta = readJSON<SessionMeta>(SESSION_META_PATH, { extensions: {} });
	return isFutureContract(meta) ? { extensions: {} } : meta;
}

/**
 * Merge one extension's status blob into the shared session-meta file without
 * clobbering the others. Each extension calls this with its own `key`. The
 * merge re-reads the latest file inside an atomic read-modify-write so a
 * concurrent extension's blob is never lost, and bails out (leaving the file
 * untouched) if it was written by a newer contract.
 */
export function writeSessionMeta(
	key: ExtensionKey,
	cwd: string,
	data: Record<string, unknown>,
): void {
	updateJSON<SessionMeta>(
		SESSION_META_PATH,
		(existing) => {
			if (isFutureContract(existing)) return existing; // newer suite owns this file
			const now = Date.now();
			return {
				...existing,
				contractVersion: CONTRACT_VERSION,
				cwd,
				cwdHash: cwdHash(cwd),
				updatedAt: now,
				extensions: {
					...(existing.extensions ?? {}),
					[key]: { ...data, updatedAt: now },
				},
			};
		},
		{ extensions: {} },
	);
}
