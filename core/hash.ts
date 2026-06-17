import { createHash } from "node:crypto";

/**
 * Stable per-project key. Every pi-suite extension scopes its on-disk state by
 * this hash so two different projects never collide in the shared `~/.pi/agent`
 * tree.
 *
 * This algorithm is part of the cross-extension contract: all extensions MUST
 * produce the same hash for the same `cwd`, or they will read and write
 * different files for the same project. Do not change it without bumping
 * `CONTRACT_VERSION` in ./contract.
 */
export function cwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
