import type { ProjectMemory } from "../../core";

/**
 * Merge a fresh auto-detection result onto a stored project profile.
 *
 * Detection OWNS the tech-stack fields (language, framework, lock-file derived
 * tooling, …) and overwrites them on every rescan. Everything else is
 * PRESERVED from the stored profile:
 *
 *   - `conventions` / `facts` — set manually by the agent/user.
 *   - `research` / `lastModified` — written onto the shared memory file by
 *     pi-quest. pi-memory does not produce these, but it must not destroy them.
 *
 * The previous `reconcile` rebuilt the profile from `detectProject()` and copied
 * forward only `conventions` and `facts`, so a rescan (hourly, or via
 * `/memory rescan`) silently erased quest's `research`/`lastModified`. Spreading
 * `...stored` first and overlaying only the detected fields keeps any field
 * pi-memory doesn't own — including ones added by other extensions later.
 */
export function reconcileProfile(stored: ProjectMemory, fresh: ProjectMemory): ProjectMemory {
	return {
		...stored,
		name: fresh.name,
		packageManager: fresh.packageManager,
		language: fresh.language,
		framework: fresh.framework,
		designSystem: fresh.designSystem,
		buildTool: fresh.buildTool,
		testRunner: fresh.testRunner,
		linter: fresh.linter,
		formatter: fresh.formatter,
		monorepo: fresh.monorepo,
		directoryPattern: fresh.directoryPattern,
		fingerprint: fresh.fingerprint,
		lastScanned: fresh.lastScanned,
	};
}
