/**
 * Build a throwaway pi agent dir for one run, so arms differ only in what the
 * arm says and nothing leaks into (or out of) the real `~/.pi/agent`.
 *
 * Credentials: only the providers the run actually uses (the model and every
 * sub-agent tier) are copied, so nothing else — notably blocked providers —
 * is reachable from inside the sandbox. OAuth entries are copied too, but a
 * refresh inside the sandbox would rotate the refresh token and invalidate the
 * real login, so `assertAuthUsable` refuses to start when a token could expire
 * mid-run.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** `provider/model` → `provider`; undefined for a bare model id. */
export function providerOf(model: string): string | undefined {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

/** Sub-agent tier config the sandbox will use. */
function subagentConfig(opts: SandboxOptions, real: Record<string, unknown>): unknown {
	if (opts.realTiers) return real.subagent;
	const tiers = ["fast", "reasoning", "planning"];
	return {
		models: Object.fromEntries(tiers.map((t) => [t, opts.model])),
		thinking: Object.fromEntries(tiers.map((t) => [t, opts.thinking])),
	};
}

/** Every provider a run can reach: the main model's plus each sub-agent tier's. */
export function providersUsed(opts: SandboxOptions, real: Record<string, unknown>): string[] {
	const models = [opts.model];
	const tierModels = (subagentConfig(opts, real) as { models?: Record<string, unknown> })?.models;
	for (const m of Object.values(tierModels ?? {})) if (typeof m === "string") models.push(m);
	return [...new Set(models.map(providerOf).filter((p): p is string => !!p))].sort();
}

/** Credentials for `providers` only. */
export function pickAuth(
	auth: Record<string, unknown>,
	providers: readonly string[],
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(auth).filter(([p]) => providers.includes(p)));
}

/**
 * Refuse runs that would touch a blocked provider, lack credentials, or carry an
 * OAuth token that could need a refresh before `minValidMs` from now.
 */
export function assertAuthUsable(
	opts: SandboxOptions,
	blocked: readonly string[],
	minValidMs: number,
	now = Date.now(),
): void {
	const real = opts.realAgentDir ?? defaultRealAgentDir();
	const settings = readJsonOr<Record<string, unknown>>(join(real, "settings.json"), {});
	const auth = readJsonOr<Record<string, unknown>>(join(real, "auth.json"), {});
	const providers = providersUsed(opts, settings);
	const hit = providers.filter((p) => blocked.includes(p));
	if (hit.length) {
		throw new Error(
			`Refusing to run: provider(s) ${hit.join(", ")} are blocked (BENCH.blockedProviders). ` +
				`Check --model${opts.realTiers ? " and your settings.json sub-agent tiers (--real-tiers)" : ""}.`,
		);
	}
	for (const p of providers) {
		const entry = auth[p] as { type?: string; expires?: number } | undefined;
		if (!entry) {
			throw new Error(`No credentials for provider "${p}" in ${join(real, "auth.json")}.`);
		}
		if (entry.type === "oauth" && typeof entry.expires === "number") {
			const expiresMs = entry.expires > 1e12 ? entry.expires : entry.expires * 1000;
			if (expiresMs - now < minValidMs) {
				const left = Math.round((expiresMs - now) / 60_000);
				throw new Error(
					`OAuth token for "${p}" ${left < 0 ? `expired ${-left} min ago` : `expires in ${left} min`}; ` +
						`a refresh inside the sandbox would rotate your real login. Refresh it first ` +
						`(any short pi call using ${p}, outside the bench), then rerun.`,
				);
			}
		}
	}
}

/** Sandbox settings: no user packages, pi-suite only when the arm asks for it. */
export function sandboxSettings(
	arm: BenchArm,
	opts: SandboxOptions,
	real: Record<string, unknown>,
): Record<string, unknown> {
	const provider = providerOf(opts.model);
	const modelId = provider ? opts.model.slice(provider.length + 1) : opts.model;
	const subagent = subagentConfig(opts, real);
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
	const realSettings = readJsonOr<Record<string, unknown>>(join(real, "settings.json"), {});
	const auth = pickAuth(
		readJsonOr<Record<string, unknown>>(join(real, "auth.json"), {}),
		providersUsed(opts, realSettings),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth, null, 2), { mode: 0o600 });
	// Read-only lookups: custom model definitions and the cached model catalog.
	for (const name of ["models.json", "models-store.json"]) {
		const src = join(real, name);
		if (existsSync(src)) writeFileSync(join(agentDir, name), readFileSync(src));
	}
	// The user's agent definitions (tiers, prompts) are part of the suite setup.
	// Copied, never symlinked: the agent has write tools and once "fixed" a real
	// agent file in the user's dotfiles through a symlink.
	if (arm.suite && existsSync(join(real, "agents"))) {
		cpSync(join(real, "agents"), join(agentDir, "agents"), { recursive: true, dereference: true });
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(sandboxSettings(arm, opts, realSettings), null, 2),
	);
}
