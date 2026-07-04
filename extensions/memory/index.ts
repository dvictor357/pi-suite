/**
 * memory.ts — persistent project & user memory for pi
 *
 * Every new session already knows what project you're in and how you like to
 * work. Auto-detects tech stack, watches for conventions, and injects a
 * concise profile into the system prompt so pi never starts cold.
 *
 * Storage
 * -------
 *   ~/.pi/agent/memory/user.json          — your style, learned over time
 *   ~/.pi/agent/memory/projects/<hash>.json — per-project, auto-detected
 *
 * Tools
 * -----
 *   memory_status   — show both profiles (what pi knows)
 *   memory_user     — view / set user-level preferences, conventions & facts
 *   memory_project  — view / set project-level conventions & facts
 *   memory_graph    — manage a project knowledge graph (nodes + edges)
 *
 * Commands
 * --------
 *   /memory                      — alias for memory_status
 *   /memory project <key=value>  — set a project convention or fact
 *   /memory user <key=value>     — set a user preference or fact
 *   /memory rescan               — force re-detect project tech stack
 *   /memory clear                — reset all memory for this project
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { basename, join } from "node:path";
import {
	AGENT_DIR,
	CONTRACT_VERSION,
	cwdHash,
	isFutureContract,
	readJSON,
	writeJSON,
	updateJSON,
	writeSessionMeta,
	CONTEXT_BUDGET,
	budgetForModel,
	clampToBudget,
} from "../../core";
import type {
	ProjectMemory as ProjectProfile,
	MemoryFact,
	UserMemory as UserProfile,
	NodeKind,
	EdgeKind,
	MemoryGraph,
} from "../../core";
import { withForeignFromDisk } from "./profile";

const USER_PATH = join(AGENT_DIR, "memory", "user.json");
const PROJECTS_DIR = join(AGENT_DIR, "memory", "projects");

/** Read the current agent identity from environment. */
function getAgentIdentity(): string | null {
	return process.env.PI_AGENT_NAME ?? null;
}

function projectPath(cwd: string): string {
	return join(PROJECTS_DIR, `${cwdHash(cwd)}.json`);
}

function defaultProject(cwd: string): ProjectProfile {
	return {
		name: basename(cwd),
		packageManager: null,
		language: null,
		framework: null,
		designSystem: null,
		buildTool: null,
		testRunner: null,
		linter: null,
		formatter: null,
		monorepo: false,
		directoryPattern: null,
		conventions: [],
		facts: [],
		lastScanned: 0,
	};
}

function loadProject(cwd: string): ProjectProfile {
	const profile = readJSON<ProjectProfile>(projectPath(cwd), defaultProject(cwd));
	// A file written by a newer contract may have a shape we'd misread; degrade
	// to a clean default (saveProject won't clobber the newer file — see below).
	if (isFutureContract(profile)) return defaultProject(cwd);
	return {
		...defaultProject(cwd),
		...profile,
		conventions: Array.isArray(profile.conventions) ? profile.conventions : [],
		facts: Array.isArray(profile.facts) ? profile.facts : [],
	};
}

function saveProject(cwd: string, profile: ProjectProfile): void {
	profile.lastScanned = Date.now();
	// Read-merge-write: re-read the file and keep whatever foreign fields
	// (quest's research/lastModified) are currently on disk, so this possibly
	// stale in-memory snapshot can't clobber a newer write from pi-quest. Bail
	// out (leave the file untouched) if it was written by a newer contract.
	updateJSON<ProjectProfile>(
		projectPath(cwd),
		(onDisk) =>
			isFutureContract(onDisk)
				? onDisk
				: { ...withForeignFromDisk(profile, onDisk), contractVersion: CONTRACT_VERSION },
		profile,
	);
}

function defaultUser(): UserProfile {
	return {
		communication: null,
		commitStyle: null,
		indent: null,
		quotes: null,
		preferredPackageManager: null,
		errorHandling: null,
		shell: process.env.SHELL?.split("/").pop() ?? null,
		conventions: [],
		facts: [],
		lastModified: 0,
	};
}

function loadUser(): UserProfile {
	const profile = readJSON<UserProfile>(USER_PATH, defaultUser());
	return {
		...defaultUser(),
		...profile,
		conventions: Array.isArray(profile.conventions) ? profile.conventions : [],
		facts: Array.isArray(profile.facts) ? profile.facts : [],
	};
}

function saveUser(profile: UserProfile): void {
	profile.lastModified = Date.now();
	writeJSON(USER_PATH, profile);
}

import {
	detectProject,
	reconcile,
	detectUser,
	projectFingerprint,
	sameFingerprint,
} from "./detect";

// ── System prompt builder ────────────────────────────────────────────────────

// ── Prompt budget constants ──────────────────────────────────────────────────
/** Max conventions to show per section in the system prompt block. */
const MAX_CONVENTIONS_DISPLAY = 5;
/** Max length per displayed convention before truncation. */
const MAX_CONVENTION_LENGTH = 72;
/** Max "extras" (design, structure, tests, etc.) to show in one line. */
const MAX_EXTRAS_DISPLAY = 8;

// ── Prompt budget helpers ────────────────────────────────────────────────────

/** Max facts to show per scope in the system prompt block. */
const MAX_FACTS_DISPLAY = 5;
/** Max length per displayed fact before truncation. */
const MAX_FACT_LENGTH = 72;

/** Filter facts to those relevant for the current agent context. */
function filterRelevantFacts(facts: MemoryFact[], agentName: string | null): MemoryFact[] {
	if (!facts.length) return [];
	return facts.filter((f) => {
		if (f.scope === "user" || f.scope === "project") return true;
		if (f.scope === "agent" && agentName) {
			return f.tags?.includes(agentName) || f.category === agentName;
		}
		return false;
	});
}

/** Budget facts for display: sort by priority desc, truncate to max, truncate long text. */
function budgetFacts(
	facts: MemoryFact[],
	max: number = MAX_FACTS_DISPLAY,
	maxLen: number = MAX_FACT_LENGTH,
): { displayed: string[]; hidden: number } {
	const sorted = [...facts].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	const trimmed = sorted.slice(0, max);
	const displayed = trimmed.map((f) => {
		const prefix = f.category ? `[${f.category}] ` : "";
		const body = f.text.length <= maxLen ? f.text : f.text.slice(0, maxLen - 1) + "…";
		return prefix + body;
	});
	return { displayed, hidden: Math.max(0, facts.length - max) };
}

/** Truncate a convention string, appending an ellipsis when over limit. */
function truncateConvention(s: string, maxLen: number = MAX_CONVENTION_LENGTH): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "…";
}

/** Split a convention list into displayed items and a hidden-overflow count. */
function budgetConventions(
	conventions: string[],
	max: number = MAX_CONVENTIONS_DISPLAY,
	maxLen: number = MAX_CONVENTION_LENGTH,
): { displayed: string[]; hidden: number } {
	const trimmed = conventions.slice(0, max);
	const displayed = trimmed.map((c) => truncateConvention(c, maxLen));
	const hidden = Math.max(0, conventions.length - max);
	return { displayed, hidden };
}

function memoryLabel(project: ProjectProfile): string {
	return project.language ?? project.framework ?? project.name ?? "no project";
}

function writeMemorySessionMeta(cwd: string, project: ProjectProfile): void {
	writeSessionMeta("memory", cwd, {
		name: project.name,
		language: project.language,
		framework: project.framework,
		packageManager: project.packageManager,
		conventions: project.conventions.length,
	});
}

function renderMemoryStatus(ctx: ExtensionContext, project: ProjectProfile): void {
	try {
		const theme = (ctx.ui as any).theme;
		if (!project.language && !project.framework) {
			ctx.ui.setStatus?.("memory", "");
			return;
		}
		const label = `🧠 ${memoryLabel(project)}`;
		ctx.ui.setStatus?.("memory", theme?.fg ? theme.fg("accent", label) : label);
	} catch {
		/* best-effort UI */
	}
}

function buildPromptBlock(project: ProjectProfile, user: UserProfile): string {
	const agentName = getAgentIdentity();
	const lines: string[] = ["## Profile"];

	// Project
	const tech = [
		project.language,
		project.packageManager,
		project.framework,
		project.buildTool,
	].filter(Boolean);
	const extras = [
		project.designSystem ? `Design: ${project.designSystem}` : null,
		project.directoryPattern ? `Structure: ${project.directoryPattern}` : null,
		project.testRunner ? `Tests: ${project.testRunner}` : null,
		project.linter ? `Lint: ${project.linter}` : null,
		project.formatter ? `Format: ${project.formatter}` : null,
		project.monorepo ? "Monorepo" : null,
	].filter(Boolean);

	lines.push(`**Project:** ${project.name} (${tech.join(" • ") || "unknown"})`);
	if (extras.length) lines.push(extras.slice(0, MAX_EXTRAS_DISPLAY).join(" • "));
	if (project.conventions.length) {
		const { displayed, hidden } = budgetConventions(project.conventions);
		const suffix = hidden > 0 ? ` +${hidden} more` : "";
		lines.push(`Conventions: ${displayed.join(", ")}${suffix}`);
	}

	// Project facts (budgeted)
	const projectFacts = filterRelevantFacts(project.facts, agentName);
	if (projectFacts.length) {
		const { displayed, hidden } = budgetFacts(projectFacts);
		const suffix = hidden > 0 ? ` +${hidden} more` : "";
		lines.push(`Facts: ${displayed.join(" • ")}${suffix}`);
	}

	// User
	if (user.conventions.length || user.commitStyle || user.indent || user.facts.length) {
		const userBits = [
			user.commitStyle ? `${user.commitStyle} commits` : null,
			user.indent,
			user.quotes ? `${user.quotes} quotes` : null,
			user.errorHandling,
			user.communication,
		].filter(Boolean);
		if (userBits.length || user.conventions.length || user.facts.length) {
			lines.push("");
			lines.push("**You:**");
			if (userBits.length) lines.push(userBits.join(" • "));
			if (user.conventions.length) {
				const { displayed, hidden } = budgetConventions(user.conventions);
				const suffix = hidden > 0 ? ` +${hidden} more` : "";
				lines.push(`Conventions: ${displayed.join(", ")}${suffix}`);
			}
			// User facts (budgeted)
			const userFacts = filterRelevantFacts(user.facts, agentName);
			if (userFacts.length) {
				const { displayed, hidden } = budgetFacts(userFacts);
				const suffix = hidden > 0 ? ` +${hidden} more` : "";
				lines.push(`Facts: ${displayed.join(" • ")}${suffix}`);
			}
		}
	}

	return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let projectProfile: ProjectProfile | null = null;
	// The cache is keyed by cwd: a session that changes directory (or a tool
	// invoked with a different ctx.cwd) must not get another project's profile —
	// otherwise a later saveProject would write project A's data into B's file.
	let projectProfileCwd: string | null = null;

	/** Get or load the project profile (reconcile if stale). */
	function getProject(cwd: string): ProjectProfile {
		if (projectProfile && projectProfileCwd === cwd) return projectProfile;
		const stored = loadProject(cwd);
		// Auto-detect on first load of the session if never scanned or older than 1h.
		if (!stored.lastScanned || Date.now() - stored.lastScanned > 3_600_000) {
			const currentFingerprint = projectFingerprint(cwd);
			if (sameFingerprint(stored.fingerprint, currentFingerprint)) {
				// Key project files unchanged — nothing to re-detect. Use the stored
				// profile as-is and DON'T rewrite the file just to bump a timestamp:
				// re-running the cheap fingerprint check next start beats a full-file
				// write on every agent start.
				projectProfile = stored;
			} else {
				projectProfile = reconcile(cwd, stored);
				saveProject(cwd, projectProfile);
			}
		} else {
			projectProfile = stored;
		}
		projectProfileCwd = cwd;
		return projectProfile;
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: [
			"Show what pi knows about the current project and user preferences.",
			"Returns both profiles so you can see what's been auto-detected and what conventions have been saved.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const user = loadUser();
			renderMemoryStatus(ctx, project);
			writeMemorySessionMeta(ctx.cwd, project);
			return {
				content: [{ type: "text", text: buildPromptBlock(project, user) }],
				details: { project, user },
			};
		},
	});

	pi.registerTool({
		name: "memory_project",
		label: "Memory Project",
		description: [
			"View or update project-specific memory. Call with no arguments to see the current profile.",
			"To add a convention: pass a `convention` string describing a project-specific pattern or rule.",
			"To set tech stack fields: pass `field` (packageManager, language, framework, designSystem, buildTool, testRunner, linter, formatter) and `value`.",
			"To remove a convention: pass `removeConvention` with the index (0-based).",
			"To add a structured fact: pass `fact` with scope, text, and optional category/priority/tags.",
			"To remove a fact: pass `removeFact` with the index (0-based).",
			"Use this when you discover a project convention that isn't auto-detected — e.g. 'uses pi.registerTool for all tools' or 'prefers functional components'.",
		].join(" "),
		parameters: Type.Object({
			convention: Type.Optional(
				Type.String({
					description: "A project convention to add (e.g. 'uses default export factory functions')",
				}),
			),
			conventions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple conventions to set (replaces existing)",
				}),
			),
			field: Type.Optional(
				StringEnum(
					[
						"packageManager",
						"language",
						"framework",
						"designSystem",
						"buildTool",
						"testRunner",
						"linter",
						"formatter",
					],
					{ description: "Tech stack field to update" },
				),
			),
			value: Type.Optional(Type.String({ description: "Value for the field" })),
			removeConvention: Type.Optional(
				Type.Number({ description: "Index of convention to remove (0-based)" }),
			),
			fact: Type.Optional(
				Type.Object({
					scope: Type.Optional(
						StringEnum(["project", "agent"], { description: "Fact scope (default: project)" }),
					),
					category: Type.Optional(Type.String({ description: "Optional category for grouping" })),
					priority: Type.Optional(
						Type.Number({ description: "Priority 0-10, higher = more important" }),
					),
					tags: Type.Optional(
						Type.Array(Type.String(), { description: "Tags for filtering (e.g. agent name)" }),
					),
					text: Type.String({ description: "Fact text" }),
				}),
			),
			removeFact: Type.Optional(Type.Number({ description: "Index of fact to remove (0-based)" })),
			compact: Type.Optional(
				Type.Boolean({
					description: "Deduplicate conventions/facts and remove empty ones to keep memory lean",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const now = Date.now();

			if (params.field && params.value !== undefined) {
				(project as any)[params.field] = params.value;
			}
			if (params.conventions) {
				project.conventions = params.conventions;
			} else if (params.convention) {
				project.conventions.push(params.convention);
			}
			if (params.removeConvention !== undefined && params.removeConvention >= 0) {
				project.conventions.splice(params.removeConvention, 1);
			}
			if (params.fact) {
				const scope = (params.fact.scope ?? "project") as MemoryFact["scope"];
				project.facts.push({
					scope,
					category: params.fact.category,
					priority: params.fact.priority,
					tags: params.fact.tags,
					text: params.fact.text,
					createdAt: now,
					updatedAt: now,
				});
			}
			if (params.removeFact !== undefined && params.removeFact >= 0) {
				project.facts.splice(params.removeFact, 1);
			}

			// Compact: normalize whitespace, deduplicate conventions and facts, remove empty ones
			const compactStats: { conventionsRemoved: number; factsRemoved: number } = {
				conventionsRemoved: 0,
				factsRemoved: 0,
			};
			if (params.compact) {
				const beforeC = project.conventions.length;
				project.conventions = project.conventions
					.map((c) => c.trim())
					.filter((c) => c)
					.filter((c, i, arr) => arr.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);
				compactStats.conventionsRemoved = beforeC - project.conventions.length;

				const beforeF = project.facts.length;
				project.facts = project.facts
					.map((f) => ({ ...f, text: f.text.trim() }))
					.filter((f) => f.text)
					.filter(
						(f, i, arr) =>
							arr.findIndex(
								(x) => x.text.toLowerCase() === f.text.toLowerCase() && x.scope === f.scope,
							) === i,
					);
				compactStats.factsRemoved = beforeF - project.facts.length;
			}

			saveProject(ctx.cwd, project);
			renderMemoryStatus(ctx, project);
			writeMemorySessionMeta(ctx.cwd, project);

			const lines = ["Project memory updated."];
			if (params.convention) lines.push(`Added convention: ${params.convention}`);
			if (params.field) lines.push(`Set ${params.field}: ${params.value}`);
			if (params.removeConvention !== undefined) lines.push("Removed convention.");
			if (params.fact) lines.push(`Added fact: ${params.fact.text}`);
			if (params.removeFact !== undefined) lines.push("Removed fact.");
			if (params.compact)
				lines.push(
					`Compacted: removed ${compactStats.conventionsRemoved} conventions, ${compactStats.factsRemoved} facts.`,
				);

			return {
				content: [
					{ type: "text", text: `${lines.join("\n")}\n\n${buildPromptBlock(project, loadUser())}` },
				],
				details: { project, compactStats: params.compact ? compactStats : undefined },
			};
		},
	});

	// ── memory_search ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search across project and user conventions and structured facts.",
			"Pass a `query` string for case-insensitive substring matching.",
			"Optionally filter by `scope` (project, user, agent) and/or `agent` name.",
		].join(" "),
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query — case-insensitive substring match against conventions and fact text",
			}),
			scope: Type.Optional(
				StringEnum(["project", "user", "agent"], {
					description: "Limit search to a specific scope",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description:
						"Agent name filter for agent-scoped facts (matched against category and tags)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const user = loadUser();
			const q = params.query.toLowerCase();
			const scope = params.scope as string | undefined;
			const agent = params.agent ?? getAgentIdentity() ?? "";

			interface SearchHit {
				source: "project-convention" | "user-convention" | "project-fact" | "user-fact";
				text: string;
				index: number;
				fact?: MemoryFact;
			}
			const hits: SearchHit[] = [];

			if (!scope || scope === "project") {
				project.conventions.forEach((c, i) => {
					if (c.toLowerCase().includes(q))
						hits.push({ source: "project-convention", text: c, index: i });
				});
				project.facts.forEach((f, i) => {
					if (f.scope === "agent" && f.category !== agent && !f.tags?.includes(agent)) return;
					if (f.text.toLowerCase().includes(q)) {
						hits.push({ source: "project-fact", text: f.text, index: i, fact: f });
					}
				});
			}
			if (!scope || scope === "user") {
				user.conventions.forEach((c, i) => {
					if (c.toLowerCase().includes(q))
						hits.push({ source: "user-convention", text: c, index: i });
				});
				user.facts.forEach((f, i) => {
					if (f.scope === "agent" && f.category !== agent && !f.tags?.includes(agent)) return;
					if (f.text.toLowerCase().includes(q)) {
						hits.push({ source: "user-fact", text: f.text, index: i, fact: f });
					}
				});
			}
			if (scope === "agent") {
				project.facts.forEach((f, i) => {
					if (f.scope !== "agent" || (f.category !== agent && !f.tags?.includes(agent))) return;
					if (f.text.toLowerCase().includes(q)) {
						hits.push({ source: "project-fact", text: f.text, index: i, fact: f });
					}
				});
				user.facts.forEach((f, i) => {
					if (f.scope !== "agent" || (f.category !== agent && !f.tags?.includes(agent))) return;
					if (f.text.toLowerCase().includes(q)) {
						hits.push({ source: "user-fact", text: f.text, index: i, fact: f });
					}
				});
			}

			const num = hits.length;
			const lines: string[] = [];
			if (num === 0) {
				lines.push(`No matches for "${params.query}"${scope ? ` (scope: ${scope})` : ""}.`);
			} else {
				lines.push(
					`Found ${num} match${num === 1 ? "" : "es"} for "${params.query}"${scope ? ` (scope: ${scope})` : ""}:`,
				);
				for (const h of hits) {
					const prefix = h.fact?.category ? `[${h.fact.category}] ` : "";
					const scopeTag = h.fact ? ` (${h.fact.scope})` : "";
					lines.push(`  [${h.source}]${scopeTag} ${prefix}${h.text}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, scope, agent, count: num, hits },
			};
		},
	});

	// ── memory_lint ─────────────────────────────────────────────────────────

	/** Lint thresholds. */
	const LINT_LONG_CONVENTION = 200;
	const LINT_LONG_FACT = 500;
	const LINT_OVERSIZED_CAPSULE_BYTES = 100 * 1024; // 100 KB

	pi.registerTool({
		name: "memory_lint",
		label: "Memory Lint",
		description: [
			"Audit project and user memory for quality issues.",
			"Reports duplicate conventions/facts, empty values, overly long entries, and oversized capsules that risk bloating the system prompt.",
		].join(" "),
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const user = loadUser();

			interface LintIssue {
				kind:
					| "duplicate-convention"
					| "empty-convention"
					| "long-convention"
					| "duplicate-fact"
					| "empty-fact"
					| "long-fact"
					| "oversized-capsule";
				scope: "project" | "user";
				index?: number;
				text?: string;
				detail?: string;
			}
			const issues: LintIssue[] = [];

			// ── Project conventions ──────────────────────────────────────────
			const seenPC = new Map<string, number>();
			project.conventions.forEach((c, i) => {
				const trimmed = c.trim();
				if (!trimmed) {
					issues.push({ kind: "empty-convention", scope: "project", index: i, text: "(empty)" });
					return;
				}
				const lower = trimmed.toLowerCase();
				if (seenPC.has(lower)) {
					issues.push({
						kind: "duplicate-convention",
						scope: "project",
						index: i,
						text: trimmed,
						detail: `Duplicate of index ${seenPC.get(lower)}`,
					});
				} else {
					seenPC.set(lower, i);
				}
				if (trimmed.length > LINT_LONG_CONVENTION) {
					issues.push({
						kind: "long-convention",
						scope: "project",
						index: i,
						text: `${trimmed.slice(0, 60)}… (${trimmed.length} chars)`,
					});
				}
			});

			// ── Project facts ────────────────────────────────────────────────
			const seenPF = new Map<string, number>();
			project.facts.forEach((f, i) => {
				const trimmed = f.text.trim();
				if (!trimmed) {
					issues.push({ kind: "empty-fact", scope: "project", index: i, text: "(empty)" });
					return;
				}
				const key = `${f.scope}\x00${trimmed.toLowerCase()}`;
				if (seenPF.has(key)) {
					issues.push({
						kind: "duplicate-fact",
						scope: "project",
						index: i,
						text: trimmed,
						detail: `Duplicate of index ${seenPF.get(key)}`,
					});
				} else {
					seenPF.set(key, i);
				}
				if (trimmed.length > LINT_LONG_FACT) {
					issues.push({
						kind: "long-fact",
						scope: "project",
						index: i,
						text: `${trimmed.slice(0, 60)}… (${trimmed.length} chars)`,
					});
				}
			});

			// ── User conventions ─────────────────────────────────────────────
			const seenUC = new Map<string, number>();
			user.conventions.forEach((c, i) => {
				const trimmed = c.trim();
				if (!trimmed) {
					issues.push({ kind: "empty-convention", scope: "user", index: i, text: "(empty)" });
					return;
				}
				const lower = trimmed.toLowerCase();
				if (seenUC.has(lower)) {
					issues.push({
						kind: "duplicate-convention",
						scope: "user",
						index: i,
						text: trimmed,
						detail: `Duplicate of index ${seenUC.get(lower)}`,
					});
				} else {
					seenUC.set(lower, i);
				}
				if (trimmed.length > LINT_LONG_CONVENTION) {
					issues.push({
						kind: "long-convention",
						scope: "user",
						index: i,
						text: `${trimmed.slice(0, 60)}… (${trimmed.length} chars)`,
					});
				}
			});

			// ── User facts ───────────────────────────────────────────────────
			const seenUF = new Map<string, number>();
			user.facts.forEach((f, i) => {
				const trimmed = f.text.trim();
				if (!trimmed) {
					issues.push({ kind: "empty-fact", scope: "user", index: i, text: "(empty)" });
					return;
				}
				const key = `${f.scope}\x00${trimmed.toLowerCase()}`;
				if (seenUF.has(key)) {
					issues.push({
						kind: "duplicate-fact",
						scope: "user",
						index: i,
						text: trimmed,
						detail: `Duplicate of index ${seenUF.get(key)}`,
					});
				} else {
					seenUF.set(key, i);
				}
				if (trimmed.length > LINT_LONG_FACT) {
					issues.push({
						kind: "long-fact",
						scope: "user",
						index: i,
						text: `${trimmed.slice(0, 60)}… (${trimmed.length} chars)`,
					});
				}
			});

			// ── Oversized capsule check ──────────────────────────────────────
			try {
				const projectJson = JSON.stringify(project);
				const userJson = JSON.stringify(user);
				if (projectJson.length > LINT_OVERSIZED_CAPSULE_BYTES) {
					issues.push({
						kind: "oversized-capsule",
						scope: "project",
						detail: `Project profile is ${Math.round(projectJson.length / 1024)} KB (limit: ${LINT_OVERSIZED_CAPSULE_BYTES / 1024} KB). Consider compacting.`,
					});
				}
				if (userJson.length > LINT_OVERSIZED_CAPSULE_BYTES) {
					issues.push({
						kind: "oversized-capsule",
						scope: "user",
						detail: `User profile is ${Math.round(userJson.length / 1024)} KB (limit: ${LINT_OVERSIZED_CAPSULE_BYTES / 1024} KB). Consider compacting.`,
					});
				}
			} catch {
				/* best-effort */
			}

			const totalCounts = {
				projectConventions: project.conventions.length,
				projectFacts: project.facts.length,
				userConventions: user.conventions.length,
				userFacts: user.facts.length,
			};

			const lines: string[] = [];
			if (issues.length === 0) {
				lines.push("✅ Memory is clean — no issues found.");
				lines.push(
					`Project: ${totalCounts.projectConventions} conventions, ${totalCounts.projectFacts} facts`,
				);
				lines.push(
					`User: ${totalCounts.userConventions} conventions, ${totalCounts.userFacts} facts`,
				);
			} else {
				lines.push(`⚠️ Found ${issues.length} issue${issues.length === 1 ? "" : "s"}:`);
				for (const issue of issues) {
					const loc = issue.index !== undefined ? ` #${issue.index}` : "";
					const detail = issue.detail ? ` — ${issue.detail}` : "";
					lines.push(`  [${issue.scope}] ${issue.kind}${loc}: ${issue.text ?? ""}${detail}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { issues, totalCounts },
			};
		},
	});

	// ── memory_graph ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_graph",
		label: "Memory Graph",
		description: [
			"Manage a project knowledge graph with nodes and typed edges.",
			"Pass `action` to choose the operation.",
			"- `list`: show the full graph (nodes + edges).",
			"- `add`: create or update a node. Pass `id`, `kind`, `label`, and optionally `detail`.",
			"- `link`: create or update a directed edge. Pass `from` (source node id), `to` (target node id), `edgeKind`, and optionally `label`.",
			"- `remove`: delete a node and its incident edges (pass `id`), or delete a specific edge (pass `from`+`to`).",
		].join(" "),
		parameters: Type.Object({
			action: StringEnum(["list", "add", "link", "remove"], {
				description: "Operation to perform",
			}),
			id: Type.Optional(Type.String({ description: "Node id (for add, remove-node)" })),
			kind: Type.Optional(
				StringEnum(
					[
						"loop-pattern",
						"sandbox-log",
						"artifact-set",
						"design-decision",
						"knowledge",
						"eval-result",
					],
					{ description: "Node kind (for add)" },
				),
			),
			label: Type.Optional(
				Type.String({ description: "Short title for node (add) or edge annotation (link)" }),
			),
			detail: Type.Optional(
				Type.String({ description: "Longer detail / notes for the node (add)" }),
			),
			from: Type.Optional(Type.String({ description: "Source node id (for link, remove-edge)" })),
			to: Type.Optional(Type.String({ description: "Target node id (for link, remove-edge)" })),
			edgeKind: Type.Optional(
				StringEnum(["supports", "produced", "derived-from", "supersedes", "relates-to"], {
					description: "Edge relationship kind (for link)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const project = getProject(ctx.cwd);
			const graph: MemoryGraph = project.graph ?? { nodes: [], edges: [] };
			const now = Date.now();

			let msg = "";

			switch (params.action) {
				case "list": {
					const lines: string[] = [];
					if (graph.nodes.length === 0 && graph.edges.length === 0) {
						lines.push("Graph is empty.");
					} else {
						lines.push(`**Nodes (${graph.nodes.length})**`);
						for (const n of graph.nodes) {
							const detail =
								n.detail && n.detail.length > 120 ? n.detail.slice(0, 119) + "…" : n.detail;
							lines.push(`  [${n.kind}] \`${n.id}\` — ${n.label}${detail ? ` (${detail})` : ""}`);
						}
						lines.push("");
						lines.push(`**Edges (${graph.edges.length})**`);
						for (const e of graph.edges) {
							lines.push(
								`  \`${e.from}\` →[${e.kind}]→ \`${e.to}\`${e.label ? ` (${e.label})` : ""}`,
							);
						}
					}
					msg = lines.join("\n");
					break;
				}
				case "add": {
					if (!params.id || !params.kind || !params.label) {
						return {
							content: [{ type: "text", text: "`add` requires `id`, `kind`, and `label`." }],
							details: {},
						};
					}
					const existing = graph.nodes.findIndex((n) => n.id === params.id);
					const node = {
						id: params.id,
						kind: params.kind as NodeKind,
						label: params.label,
						detail: params.detail,
						createdAt: now,
						updatedAt: now,
					};
					if (existing >= 0) {
						node.createdAt = graph.nodes[existing].createdAt;
						graph.nodes[existing] = node;
						msg = `Updated node \`${params.id}\`.`;
					} else {
						graph.nodes.push(node);
						msg = `Added node \`${params.id}\` (${params.kind}).`;
					}
					break;
				}
				case "link": {
					if (!params.from || !params.to || !params.edgeKind) {
						return {
							content: [{ type: "text", text: "`link` requires `from`, `to`, and `edgeKind`." }],
							details: {},
						};
					}
					// ponytail: duplicate-edge check is O(n) over edges; fine for a memory graph
					const dup = graph.edges.findIndex(
						(e) => e.from === params.from && e.to === params.to && e.kind === params.edgeKind,
					);
					if (dup >= 0) {
						graph.edges[dup].label = params.label;
						msg = `Updated edge \`${params.from}\` → \`${params.to}\`.`;
					} else {
						graph.edges.push({
							from: params.from,
							to: params.to,
							kind: params.edgeKind as EdgeKind,
							label: params.label,
						});
						msg = `Linked \`${params.from}\` →[${params.edgeKind}]→ \`${params.to}\`.`;
					}
					break;
				}
				case "remove": {
					if (params.id) {
						const before = graph.nodes.length;
						const eBefore = graph.edges.length;
						graph.nodes = graph.nodes.filter((n) => n.id !== params.id);
						graph.edges = graph.edges.filter((e) => e.from !== params.id && e.to !== params.id);
						const nRemoved = before - graph.nodes.length;
						const eRemoved = eBefore - graph.edges.length;
						msg =
							nRemoved > 0
								? `Removed node \`${params.id}\` and ${eRemoved} incident edge(s).`
								: `Node \`${params.id}\` not found.`;
					} else if (params.from && params.to) {
						const before = graph.edges.length;
						graph.edges = graph.edges.filter(
							(e) => !(e.from === params.from && e.to === params.to),
						);
						const removed = before - graph.edges.length;
						msg =
							removed > 0
								? `Removed ${removed} edge(s) \`${params.from}\` → \`${params.to}\`.`
								: `No edges from \`${params.from}\` to \`${params.to}\`.`;
					} else {
						return {
							content: [
								{ type: "text", text: "`remove` requires `id` (node) or both `from`+`to` (edge)." },
							],
							details: {},
						};
					}
					break;
				}
			}

			project.graph = graph;
			saveProject(ctx.cwd, project);

			return {
				content: [{ type: "text", text: msg }],
				details: { graph },
			};
		},
	});

	pi.registerTool({
		name: "memory_user",
		label: "Memory User",
		description: [
			"View or update user-level preferences that apply across all projects.",
			"Call with no arguments to see current preferences.",
			"To set a preference: pass `field` and `value`.",
			"Fields: communication, commitStyle, indent, quotes, preferredPackageManager, errorHandling, shell.",
			"To add a convention: pass `convention` (e.g. 'prefers TypeScript over JavaScript').",
			"To add a structured fact: pass `fact` with scope, text, and optional category/priority/tags.",
			"To remove a fact: pass `removeFact` with the index (0-based).",
			"Use this when the user corrects you or states a preference — e.g. 'I prefer tabs' or 'always use try/catch'.",
		].join(" "),
		parameters: Type.Object({
			field: Type.Optional(
				StringEnum(
					[
						"communication",
						"commitStyle",
						"indent",
						"quotes",
						"preferredPackageManager",
						"errorHandling",
						"shell",
					],
					{ description: "Preference field to update" },
				),
			),
			value: Type.Optional(Type.String({ description: "Value for the field" })),
			convention: Type.Optional(
				Type.String({
					description: "A user convention to add (e.g. 'prefers concise variable names')",
				}),
			),
			conventions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple conventions to set (replaces existing)",
				}),
			),
			removeConvention: Type.Optional(
				Type.Number({ description: "Index of convention to remove (0-based)" }),
			),
			fact: Type.Optional(
				Type.Object({
					scope: Type.Optional(
						StringEnum(["user", "agent"], { description: "Fact scope (default: user)" }),
					),
					category: Type.Optional(Type.String({ description: "Optional category for grouping" })),
					priority: Type.Optional(
						Type.Number({ description: "Priority 0-10, higher = more important" }),
					),
					tags: Type.Optional(
						Type.Array(Type.String(), { description: "Tags for filtering (e.g. agent name)" }),
					),
					text: Type.String({ description: "Fact text" }),
				}),
			),
			removeFact: Type.Optional(Type.Number({ description: "Index of fact to remove (0-based)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const user = loadUser();
			const now = Date.now();

			if (params.field && params.value !== undefined) {
				(user as any)[params.field] = params.value;
			}
			if (params.conventions) {
				user.conventions = params.conventions;
			} else if (params.convention) {
				user.conventions.push(params.convention);
			}
			if (params.removeConvention !== undefined && params.removeConvention >= 0) {
				user.conventions.splice(params.removeConvention, 1);
			}
			if (params.fact) {
				const scope = (params.fact.scope ?? "user") as MemoryFact["scope"];
				user.facts.push({
					scope,
					category: params.fact.category,
					priority: params.fact.priority,
					tags: params.fact.tags,
					text: params.fact.text,
					createdAt: now,
					updatedAt: now,
				});
			}
			if (params.removeFact !== undefined && params.removeFact >= 0) {
				user.facts.splice(params.removeFact, 1);
			}

			saveUser(user);
			const lines = ["User preferences updated."];
			if (params.fact) lines.push(`Added fact: ${params.fact.text}`);
			if (params.removeFact !== undefined) lines.push("Removed fact.");

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { user },
			};
		},
	});

	// ── System prompt injection ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const project = getProject(ctx.cwd);
			const user = loadUser();
			const block = buildPromptBlock(project, user);
			renderMemoryStatus(ctx, project);
			writeMemorySessionMeta(ctx.cwd, project);

			// Only tighten the injected profile for small/low-context models; large
			// models keep the full block (structure-safe trim, never a mid-line cut).
			const budget = budgetForModel(ctx.model);
			const budgeted =
				budget < CONTEXT_BUDGET.awarenessBudget ? clampToBudget(block, budget) : block;

			return {
				systemPrompt: `${event.systemPrompt}\n\n${budgeted}`,
			};
		} catch {
			/* best-effort; return event unchanged */
		}
		return { systemPrompt: event.systemPrompt };
	});

	// ── Session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			// Eager-load project profile on session start so it's ready
			const project = getProject(ctx.cwd);
			renderMemoryStatus(ctx, project);
			writeMemorySessionMeta(ctx.cwd, project);
			// Auto-detect user preferences in background (non-blocking)
			detectUser(ctx.cwd)
				.then((detected) => {
					try {
						const user = loadUser();
						let changed = false;
						if (detected.commitStyle && !user.commitStyle) {
							user.commitStyle = detected.commitStyle;
							changed = true;
						}
						if (detected.indent && !user.indent) {
							user.indent = detected.indent;
							changed = true;
						}
						if (changed) saveUser(user);
					} catch {
						/* best-effort */
					}
				})
				.catch(() => {
					/* best-effort */
				});
		} catch {
			/* best-effort */
		}
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Show or update project/user memory. /memory rescan to re-detect.",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const restStr = rest.join(" ");

			switch (sub) {
				case "": {
					const project = getProject(ctx.cwd);
					const user = loadUser();
					renderMemoryStatus(ctx, project);
					writeMemorySessionMeta(ctx.cwd, project);
					ctx.ui.notify(buildPromptBlock(project, user), "info");
					return;
				}
				case "rescan": {
					projectProfile = null;
					const project = loadProject(ctx.cwd);
					// Force a full re-detect, overlaying detected fields onto the stored
					// profile so manual conventions/facts and quest's research survive.
					const fresh = reconcile(ctx.cwd, project);
					saveProject(ctx.cwd, fresh);
					projectProfile = fresh;
					projectProfileCwd = ctx.cwd;
					renderMemoryStatus(ctx, fresh);
					writeMemorySessionMeta(ctx.cwd, fresh);
					ctx.ui.notify(
						`Project re-scanned: ${fresh.language ?? "?"} • ${fresh.packageManager ?? "?"} • ${fresh.framework ?? "no framework"}`,
						"info",
					);
					return;
				}
				case "clear": {
					projectProfile = null;
					const fresh = detectProject(ctx.cwd);
					fresh.conventions = [];
					fresh.facts = [];
					saveProject(ctx.cwd, fresh);
					projectProfile = fresh;
					projectProfileCwd = ctx.cwd;
					renderMemoryStatus(ctx, fresh);
					writeMemorySessionMeta(ctx.cwd, fresh);
					ctx.ui.notify("Project memory cleared. Auto-detected tech stack preserved.", "info");
					return;
				}
				case "project": {
					if (!restStr.includes("=")) {
						ctx.ui.notify(
							"Usage: /memory project <key=value>. Keys: convention, fact, packageManager, language, framework, designSystem, buildTool, testRunner, linter, formatter",
							"error",
						);
						return;
					}
					const eq = restStr.indexOf("=");
					const key = restStr.slice(0, eq).trim();
					const value = restStr.slice(eq + 1).trim();
					const project = getProject(ctx.cwd);
					const now = Date.now();
					if (key === "convention") {
						project.conventions.push(value);
					} else if (key === "fact") {
						project.facts.push({ scope: "project", text: value, createdAt: now, updatedAt: now });
					} else if (key in project) {
						(project as any)[key] = value;
					} else {
						ctx.ui.notify(`Unknown key: ${key}`, "error");
						return;
					}
					saveProject(ctx.cwd, project);
					renderMemoryStatus(ctx, project);
					writeMemorySessionMeta(ctx.cwd, project);
					ctx.ui.notify(`Project ${key} → ${value}`, "info");
					return;
				}
				case "user": {
					if (!restStr.includes("=")) {
						ctx.ui.notify(
							"Usage: /memory user <key=value>. Keys: communication, commitStyle, indent, quotes, preferredPackageManager, errorHandling, convention, fact",
							"error",
						);
						return;
					}
					const eq = restStr.indexOf("=");
					const key = restStr.slice(0, eq).trim();
					const value = restStr.slice(eq + 1).trim();
					const user = loadUser();
					const now = Date.now();
					if (key === "convention") {
						user.conventions.push(value);
					} else if (key === "fact") {
						user.facts.push({ scope: "user", text: value, createdAt: now, updatedAt: now });
					} else if (key in user) {
						(user as any)[key] = value;
					} else {
						ctx.ui.notify(`Unknown key: ${key}`, "error");
						return;
					}
					saveUser(user);
					ctx.ui.notify(`User ${key} → ${value}`, "info");
					return;
				}
				case "compact": {
					const project = getProject(ctx.cwd);
					const user = loadUser();

					const pBefore = { c: project.conventions.length, f: project.facts.length };
					const uBefore = { c: user.conventions.length, f: user.facts.length };

					// Normalize whitespace, deduplicate, and remove empty conventions
					project.conventions = project.conventions
						.map((c) => c.trim())
						.filter((c) => c)
						.filter((c, i, arr) => arr.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);
					user.conventions = user.conventions
						.map((c) => c.trim())
						.filter((c) => c)
						.filter((c, i, arr) => arr.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);

					// Normalize whitespace, deduplicate, and remove empty facts (same scope + same text)
					project.facts = project.facts
						.map((f) => ({ ...f, text: f.text.trim() }))
						.filter((f) => f.text)
						.filter(
							(f, i, arr) =>
								arr.findIndex(
									(x) => x.text.toLowerCase() === f.text.toLowerCase() && x.scope === f.scope,
								) === i,
						);
					user.facts = user.facts
						.map((f) => ({ ...f, text: f.text.trim() }))
						.filter((f) => f.text)
						.filter(
							(f, i, arr) =>
								arr.findIndex(
									(x) => x.text.toLowerCase() === f.text.toLowerCase() && x.scope === f.scope,
								) === i,
						);

					const pRemoved = {
						c: pBefore.c - project.conventions.length,
						f: pBefore.f - project.facts.length,
					};
					const uRemoved = {
						c: uBefore.c - user.conventions.length,
						f: uBefore.f - user.facts.length,
					};

					saveProject(ctx.cwd, project);
					saveUser(user);
					renderMemoryStatus(ctx, project);
					writeMemorySessionMeta(ctx.cwd, project);

					const total = pRemoved.c + pRemoved.f + uRemoved.c + uRemoved.f;
					ctx.ui.notify(
						`Compacted: removed ${total} items (project: ${pRemoved.c} conventions, ${pRemoved.f} facts; user: ${uRemoved.c} conventions, ${uRemoved.f} facts)`,
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /memory [project key=value|user key=value|compact|rescan|clear]. Keys: convention, fact, +tech fields",
						"error",
					);
			}
		},
	});
}
