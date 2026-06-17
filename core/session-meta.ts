import { SESSION_META_PATH } from "./paths";
import { cwdHash } from "./hash";
import { readJSON, updateJSON } from "./fs";
import type { ExtensionKey, SessionMeta } from "./contract";

/** Read the shared session-meta file, returning an empty shell if absent/corrupt. */
export function readSessionMeta(): SessionMeta {
	return readJSON<SessionMeta>(SESSION_META_PATH, { extensions: {} });
}

/**
 * Merge one extension's status blob into the shared session-meta file without
 * clobbering the others. Each extension calls this with its own `key`. The
 * merge re-reads the latest file inside an atomic read-modify-write so a
 * concurrent extension's blob is never lost.
 */
export function writeSessionMeta(
	key: ExtensionKey,
	cwd: string,
	data: Record<string, unknown>,
): void {
	updateJSON<SessionMeta>(
		SESSION_META_PATH,
		(existing) => {
			const now = Date.now();
			return {
				...existing,
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
