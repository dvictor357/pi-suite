/**
 * Build a throwaway pi agent dir for one run, so arms differ only in what the
 * arm says and nothing leaks into (or out of) the real `~/.pi/agent`.
 *
 * Credentials: by default only API-key entries are copied. OAuth entries are
 * left out because a refresh inside the sandbox can rotate the refresh token
 * and silently invalidate the real login. `shareAuth` symlinks the real file
 * instead, for runs that need an OAuth provider.
 */
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BenchArm } from "./types";

export interface SandboxOptions {
	/** Source agent dir to borrow credentials/models/agents from. */
	realAgentDir?: string;
	/** pi-suite package root loaded when the arm has `suite: true`. */
	suiteRoot: string;
	model: string;
	thinking: string;
	/** Keep the user's sub-agent tier routing instead of pinning every tier to `model`. */
	realTiers?: boolean;
	/** Symlink the real auth.json (needed for OAuth providers). */
	shareAuth?: boolean;
}

export function defaultRealAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readJsonOr<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** API-key credentials only; see the module note on OAuth. */
export function apiKeyAuth(auth: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [provider, entry] of Object.entries(auth)) {
		const type = (entry as { type?: unknown } | null)?.type;
		if (type === "api_key") out[provider] = entry;
	}
	return out;
}

/** Sandbox settings: no user packages, pi-suite only when the arm asks for it. */
export function sandboxSettings(
	arm: BenchArm,
	opts: SandboxOptions,
	real: Record<string, unknown>,
): Record<string, unknown> {
	const slash = opts.model.indexOf("/");
	const provider = slash > 0 ? opts.model.slice(0, slash) : undefined;
	const modelId = slash > 0 ? opts.model.slice(slash + 1) : opts.model;
	const tiers = ["fast", "reasoning", "planning"];
	const subagent = opts.realTiers
		? real.subagent
		: {
				models: Object.fromEntries(tiers.map((t) => [t, opts.model])),
				thinking: Object.fromEntries(tiers.map((t) => [t, opts.thinking])),
			};
	return {
		...(provider ? { defaultProvider: provider } : {}),
		defaultModel: modelId,
		defaultThinkingLevel: opts.thinking,
		quietStartup: true,
		enableInstallTelemetry: false,
		// A local directory in `packages` follows package discovery (the pi manifest).
		packages: arm.suite ? [opts.suiteRoot] : [],
		...(subagent ? { subagent } : {}),
	};
}

export function populateAgentDir(agentDir: string, arm: BenchArm, opts: SandboxOptions): void {
	const real = opts.realAgentDir ?? defaultRealAgentDir();
	const authPath = join(real, "auth.json");
	if (opts.shareAuth) {
		if (existsSync(authPath)) symlinkSync(authPath, join(agentDir, "auth.json"));
	} else {
		const auth = apiKeyAuth(readJsonOr<Record<string, unknown>>(authPath, {}));
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), { mode: 0o600 });
	}
	// Read-only lookups: custom model definitions and the cached model catalog.
	for (const name of ["models.json", "models-store.json"]) {
		const src = join(real, name);
		if (existsSync(src)) writeFileSync(join(agentDir, name), readFileSync(src));
	}
	// The user's agent definitions (tiers, prompts) are part of the suite setup.
	if (arm.suite && existsSync(join(real, "agents"))) {
		symlinkSync(join(real, "agents"), join(agentDir, "agents"));
	}
	const realSettings = readJsonOr<Record<string, unknown>>(join(real, "settings.json"), {});
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(sandboxSettings(arm, opts, realSettings), null, 2),
	);
}
