import type { UserMemory } from "../../core";

/**
 * Renderable user preference bits for the injected prompt block. Empty when no
 * preference is set. Drives both the "**You:**" section gate (render if any
 * bit exists) and the joined one-liner — so a user whose only preference is
 * e.g. `communication` still gets their prefs injected.
 */
export function buildUserPromptBits(user: UserMemory): string[] {
	return [
		user.commitStyle ? `${user.commitStyle} commits` : null,
		user.indent,
		user.quotes ? `${user.quotes} quotes` : null,
		user.errorHandling,
		user.communication,
		user.shell ? `shell: ${user.shell}` : null,
		user.preferredPackageManager ? `package manager: ${user.preferredPackageManager}` : null,
	].filter((b): b is string => Boolean(b));
}
