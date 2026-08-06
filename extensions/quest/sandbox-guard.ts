/**
 * quest/sandbox-guard.ts — turns a resolved {@link SandboxProfile} into an
 * actual block/allow decision for a single tool call.
 *
 * This is the enforcement counterpart to sandbox.ts (which only *resolves*
 * policy) and verifier.ts (which only checks compliance *after the fact*). The
 * orchestrator wires `evaluateToolCall` into pi's `tool_call` hook, and the
 * sub-agent spawn path wires it into wrapped tool implementations, so a denied
 * path / command / network call is stopped before it runs rather than merely
 * described in a prompt.
 *
 * Pure and SDK-free so it can be unit-tested. Inputs are plain records (the
 * shape of a tool call's arguments); nothing here imports pi.
 */
import type { SandboxProfile } from "./sandbox";
import {
	classifyCommand,
	isDestructiveCommand,
	getSensitiveDeniedPaths,
	isSandboxActive,
} from "./sandbox";
import { optStr } from "../../core";

/** The outcome of evaluating one tool call against a sandbox profile. */
export interface ToolCallDecision {
	/** True when the call must not run. */
	block: boolean;
	/** Human-readable reason, present when `block` is true. */
	reason?: string;
}

const ALLOW: ToolCallDecision = { block: false };

/** Convert a path glob (`**`, `*`, `?`) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const body = escaped
		.replace(/\*\*\//g, "__PI_GLOB_DIRS__")
		.replace(/\*\*/g, "__PI_GLOB_ANY__")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/__PI_GLOB_DIRS__/g, "(?:.*/)?")
		.replace(/__PI_GLOB_ANY__/g, ".*");
	return new RegExp(`^${body}$`);
}

/** Normalize a path for matching: forward slashes, no leading `./`. */
function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when `path` matches any of the `globs`. */
function matchesAnyGlob(path: string, globs: string[]): boolean {
	const norm = normalizePath(path);
	return globs.some((g) => {
		try {
			return globToRegExp(g).test(norm);
		} catch {
			return false;
		}
	});
}

/** Extract a filesystem path argument from a tool call's input, if any. */
export function extractPath(input: Record<string, unknown>): string | undefined {
	return (
		optStr(input.path) ?? optStr(input.file_path) ?? optStr(input.filePath) ?? optStr(input.file)
	);
}

/** Extract a shell command argument from a tool call's input, if any. */
function extractCommand(input: Record<string, unknown>): string | undefined {
	return optStr(input.command) ?? optStr(input.cmd);
}

/**
 * Split a shell command on chaining operators (`&&`, `||`, `;`, `|`) and
 * newlines into independent segments. Each segment could execute
 * independently, so every one must pass policy checks.
 */
function splitCommands(cmd: string): string[] {
	return cmd
		.split(/\s*(?:&&|\|\|)\s*|\s*[;&\n]\s*|\s*\|\s*/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Extract commands nested inside `$(...)` and backtick substitutions so they
 * can be classified individually for destructive/network/package-install checks.
 */
function extractSubstitutions(cmd: string): string[] {
	const found: string[] = [];
	const dollarParenRe = /\$\(([^)]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = dollarParenRe.exec(cmd)) !== null) {
		found.push(m[1].trim());
	}
	const backtickRe = /`([^`]+)`/g;
	while ((m = backtickRe.exec(cmd)) !== null) {
		found.push(m[1].trim());
	}
	return found;
}

/**
 * Strip `$(...)` command substitutions and backtick substitutions from a
 * command string so the allow-prefix check is not fooled by `echo $(curl x)`.
 * The stripped segments still flow through destructive/network/package-install
 * classification separately.
 */
function stripSubstitutions(cmd: string): string {
	// Recursively strip $(...) — handles nesting shallowly.
	let prev = "";
	let cur = cmd;
	while (prev !== cur) {
		prev = cur;
		cur = cur.replace(/\$\([^)]*\)/g, "");
		cur = cur.replace(/`[^`]*`/g, "");
	}
	return cur.trim();
}

const FILE_WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec"]);

/**
 * Decide whether a single tool call is allowed under `profile`.
 *
 * Enforced (returns `{ block: true }`):
 * - write/edit to a path matching a denied glob or a built-in sensitive glob
 *   (secrets, keys, env files);
 * - write/edit to a path outside a non-empty allow-list;
 * - bash whose command is destructive, or is a network/package-install command
 *   when policy forbids it, or matches a denied-command pattern, or (when an
 *   allow-list is set) matches none of the allowed-command prefixes.
 *
 * When `profile.mode` is "none" (sandbox off) nothing is ever blocked.
 */
export function evaluateToolCall(
	profile: SandboxProfile,
	toolName: string,
	input: Record<string, unknown>,
): ToolCallDecision {
	if (!isSandboxActive(profile)) return ALLOW;

	if (FILE_WRITE_TOOLS.has(toolName)) {
		const path = extractPath(input);
		if (!path) {
			return {
				block: true,
				reason: `Sandbox: "${toolName}" called without a path — blocked by policy.`,
			};
		}
		const denied = [...profile.deniedPaths, ...getSensitiveDeniedPaths()];
		if (matchesAnyGlob(path, denied)) {
			return { block: true, reason: `Sandbox: writing "${path}" is denied by policy.` };
		}
		if (profile.allowedPaths.length === 0) {
			return { block: true, reason: `Sandbox: no file writes are allowed by policy.` };
		}
		if (!matchesAnyGlob(path, profile.allowedPaths)) {
			return {
				block: true,
				reason: `Sandbox: "${path}" is outside the allowed paths (${profile.allowedPaths.join(", ")}).`,
			};
		}
		return ALLOW;
	}

	if (SHELL_TOOLS.has(toolName)) {
		const command = extractCommand(input);
		if (!command || !command.trim()) return ALLOW;
		const cmd = command.trim();

		// SB-1: split on &&, ;, |, ||, newlines — evaluate every segment
		const segments = splitCommands(cmd);
		for (const seg of segments) {
			if (isDestructiveCommand(seg)) {
				return {
					block: true,
					reason: `Sandbox: destructive command in chain: \`${seg}\` (full: \`${cmd}\`).`,
				};
			}
			const cls = classifyCommand(seg);
			if (cls === "network" && !profile.allowNetwork) {
				return {
					block: true,
					reason: `Sandbox: network access blocked in chain: \`${seg}\` (full: \`${cmd}\`).`,
				};
			}
			if (cls === "package-install" && !profile.allowPackageInstall) {
				return {
					block: true,
					reason: `Sandbox: package install blocked in chain: \`${seg}\` (full: \`${cmd}\`).`,
				};
			}
			if (profile.denyCommands.some((p) => seg.includes(p))) {
				return {
					block: true,
					reason: `Sandbox: denied pattern in chain: \`${seg}\` (full: \`${cmd}\`).`,
				};
			}
		}

		// Also evaluate the raw command for the top-level destructive/network/pkg
		// checks (catches $(rm -rf /) that splitCommands doesn't decompose).
		if (isDestructiveCommand(cmd)) {
			return { block: true, reason: `Sandbox: destructive command blocked: \`${cmd}\`.` };
		}
		// Check $(...) and backtick substitutions individually
		const subs = extractSubstitutions(cmd);
		for (const sub of subs) {
			if (isDestructiveCommand(sub)) {
				return {
					block: true,
					reason: `Sandbox: destructive command in substitution: \`${sub}\` (full: \`${cmd}\`).`,
				};
			}
			const subCls = classifyCommand(sub);
			if (subCls === "network" && !profile.allowNetwork) {
				return {
					block: true,
					reason: `Sandbox: network access in substitution: \`${sub}\` (full: \`${cmd}\`).`,
				};
			}
			if (subCls === "package-install" && !profile.allowPackageInstall) {
				return {
					block: true,
					reason: `Sandbox: package install in substitution: \`${sub}\` (full: \`${cmd}\`).`,
				};
			}
		}
		const rawCls = classifyCommand(cmd);
		if (rawCls === "network" && !profile.allowNetwork) {
			return { block: true, reason: `Sandbox: network access is disabled: \`${cmd}\`.` };
		}
		if (rawCls === "package-install" && !profile.allowPackageInstall) {
			return { block: true, reason: `Sandbox: package install is disabled: \`${cmd}\`.` };
		}

		// Allow-prefix: check every segment (with substitutions stripped) has a
		// matching prefix; also check the raw command.
		if (profile.allowCommands.length === 0) {
			return { block: true, reason: `Sandbox: no shell commands are allowed by policy.` };
		}
		const prefixOk = (s: string): boolean => profile.allowCommands.some((p) => s.startsWith(p));
		if (!prefixOk(stripSubstitutions(cmd))) {
			return {
				block: true,
				reason: `Sandbox: \`${cmd}\` is not in the allowed commands (${profile.allowCommands.join(", ")}).`,
			};
		}
		for (const seg of segments) {
			if (!prefixOk(stripSubstitutions(seg))) {
				return {
					block: true,
					reason: `Sandbox: \`${seg}\` in chain is not in the allowed commands (${profile.allowCommands.join(", ")}) (full: \`${cmd}\`).`,
				};
			}
		}
		return ALLOW;
	}

	// SB-2: Unknown tool — defensively check path-ish args
	const path = extractPath(input);
	if (path) {
		const denied = [...profile.deniedPaths, ...getSensitiveDeniedPaths()];
		if (matchesAnyGlob(path, denied)) {
			return {
				block: true,
				reason: `Sandbox: unknown tool "${toolName}" blocked from writing "${path}".`,
			};
		}
		if (profile.allowedPaths.length > 0 && !matchesAnyGlob(path, profile.allowedPaths)) {
			return {
				block: true,
				reason: `Sandbox: "${path}" is outside the allowed paths (${profile.allowedPaths.join(", ")}) for unknown tool "${toolName}".`,
			};
		}
	}
	return ALLOW;
}
