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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
} from "../../core";
import type {
	ProjectMemory as ProjectProfile,
	MemoryFact,
	UserMemory as UserProfile,
} from "../../core";
import { reconcileProfile, withForeignFromDisk } from "./profile";

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

// ── Auto-detection ───────────────────────────────────────────────────────────

interface ProjectSignals {
	cwd: string;
	pkg: Record<string, any> | null;
	deps: Set<string>;
	extCounts: Record<string, number>;
	pyprojectRaw: string | null;
	cargoRaw: string | null;
	has(path: string): boolean;
	hasAny(...paths: string[]): boolean;
	hasConfig(base: string): boolean;
	hasDep(name: string): boolean;
}

const FINGERPRINT_FILES = [
	"package.json",
	"tsconfig.json",
	"pnpm-lock.yaml",
	"package-lock.json",
	join(".git", "HEAD"),
	"pyproject.toml",
	"go.mod",
	"Cargo.toml",

	// Lock files used by detectPackageManager
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"go.sum",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"Gemfile.lock",
	"mix.lock",

	// Editor / formatting / linting
	".editorconfig",
	"biome.json",
	"biome.jsonc",
	".prettierrc",
	".prettierrc.json",
	".prettierrc.yaml",
	".prettierrc.js",
	".eslintrc.js",
	".eslintrc.json",
	".eslintrc.yaml",
	"oxlintrc.json",
	".oxlintrc.json",
	".rubocop.yml",

	// Config files checked by hasConfig(base)
	"prettier.config.ts",
	"prettier.config.js",
	"prettier.config.mjs",
	"prettier.config.cjs",
	"prettier.config.mts",
	"prettier.config.cts",
	"eslint.config.ts",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.mts",
	"eslint.config.cts",
	"vite.config.ts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
	"vite.config.mts",
	"vite.config.cts",
	"next.config.ts",
	"next.config.js",
	"next.config.mjs",
	"next.config.cjs",
	"next.config.mts",
	"next.config.cts",
	"tailwind.config.ts",
	"tailwind.config.js",
	"tailwind.config.mjs",
	"tailwind.config.cjs",
	"tailwind.config.mts",
	"tailwind.config.cts",
	"vitest.config.ts",
	"vitest.config.js",
	"vitest.config.mjs",
	"vitest.config.cjs",
	"vitest.config.mts",
	"vitest.config.cts",
	"svelte.config.ts",
	"svelte.config.js",
	"svelte.config.mjs",
	"svelte.config.cjs",
	"svelte.config.mts",
	"svelte.config.cts",
	"nuxt.config.ts",
	"nuxt.config.js",
	"nuxt.config.mjs",
	"nuxt.config.cjs",
	"nuxt.config.mts",
	"nuxt.config.cts",
	"remix.config.ts",
	"remix.config.js",
	"remix.config.mjs",
	"remix.config.cjs",
	"remix.config.mts",
	"remix.config.cts",
	"tsup.config.ts",
	"tsup.config.js",
	"tsup.config.mjs",
	"tsup.config.cjs",
	"tsup.config.mts",
	"tsup.config.cts",
	"rollup.config.ts",
	"rollup.config.js",
	"rollup.config.mjs",
	"rollup.config.cjs",
	"rollup.config.mts",
	"rollup.config.cts",
	"webpack.config.ts",
	"webpack.config.js",
	"webpack.config.mjs",
	"webpack.config.cjs",
	"webpack.config.mts",
	"webpack.config.cts",
	"esbuild.config.ts",
	"esbuild.config.js",
	"esbuild.config.mjs",
	"esbuild.config.cjs",
	"esbuild.config.mts",
	"esbuild.config.cts",

	// Misc project configs
	"components.json",
	"pnpm-workspace.yaml",
	"lerna.json",
	"nx.json",
	"turbo.json",

	// Python / Ruby
	"setup.py",
	"manage.py",
	"Gemfile",
];

function projectFingerprint(cwd: string): Record<string, number> {
	const fingerprint: Record<string, number> = {};
	for (const rel of FINGERPRINT_FILES) {
		try {
			const p = join(cwd, rel);
			if (existsSync(p)) fingerprint[rel] = statSync(p).mtimeMs;
		} catch {
			/* ignore missing/inaccessible key files */
		}
	}
	return fingerprint;
}

function sameFingerprint(a?: Record<string, number>, b?: Record<string, number>): boolean {
	if (!a || !b) return false;
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

/** Check if a file or directory exists relative to cwd. */
function has(cwd: string, ...paths: string[]): boolean {
	return existsSync(join(cwd, ...paths));
}

function readPkg(cwd: string): Record<string, any> | null {
	const p = join(cwd, "package.json");
	try {
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		/* ignore */
	}
	return null;
}

/** Single-scan extension counts (capped at 100 per extension). */
function collectExtCounts(cwd: string): Record<string, number> {
	const counts: Record<string, number> = {};
	const TARGET_EXTS = new Set([
		".ts",
		".tsx",
		".js",
		".jsx",
		".py",
		".rs",
		".go",
		".rb",
		".ex",
		".exs",
		".java",
		".kt",
		".swift",
		".c",
		".cpp",
		".h",
		".hpp",
	]);

	function walk(dir: string, depth: number): void {
		if (depth > 3) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.startsWith(".") && e !== ".pi") continue;
			if (e === "node_modules" || e === "target" || e === "__pycache__" || e === ".git") continue;
			const full = join(dir, e);
			let st: { isDirectory(): boolean; isFile(): boolean };
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(full, depth + 1);
			} else if (st.isFile()) {
				for (const ext of TARGET_EXTS) {
					if (e.endsWith(ext)) {
						counts[ext] = Math.min((counts[ext] || 0) + 1, 100);
						break;
					}
				}
			}
		}
	}

	walk(cwd, 0);
	return counts;
}

/** Config-file extensions checked by hasConfig. */
const CONFIG_EXTS = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"];

/** Collect all project signals in one pass. */
function collectSignals(cwd: string): ProjectSignals {
	const pkg = readPkg(cwd);
	const deps = new Set<string>();
	if (pkg) {
		for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
			if (section && typeof section === "object") {
				for (const name of Object.keys(section)) deps.add(name);
			}
		}
	}

	const extCounts = collectExtCounts(cwd);

	let pyprojectRaw: string | null = null;
	try {
		const pp = join(cwd, "pyproject.toml");
		if (existsSync(pp)) pyprojectRaw = readFileSync(pp, "utf8");
	} catch {
		/* ignore */
	}

	let cargoRaw: string | null = null;
	try {
		const cp = join(cwd, "Cargo.toml");
		if (existsSync(cp)) cargoRaw = readFileSync(cp, "utf8");
	} catch {
		/* ignore */
	}

	return {
		cwd,
		pkg,
		deps,
		extCounts,
		pyprojectRaw,
		cargoRaw,
		has(path: string): boolean {
			return existsSync(join(cwd, path));
		},
		hasAny(...paths: string[]): boolean {
			return paths.some((p) => existsSync(join(cwd, p)));
		},
		hasConfig(base: string): boolean {
			return CONFIG_EXTS.some((ext) => existsSync(join(cwd, `${base}${ext}`)));
		},
		hasDep(name: string): boolean {
			return deps.has(name);
		},
	};
}

/** Detect package manager from lock/config files, in priority order. */
function detectPackageManager(s: ProjectSignals): string | null {
	if (s.hasAny("bun.lockb", "bun.lock")) return "bun";
	if (s.has("pnpm-lock.yaml")) return "pnpm";
	if (s.has("yarn.lock")) return "yarn";
	if (s.has("package-lock.json")) return "npm";
	if (s.has("uv.lock")) return "uv";
	if (s.has("poetry.lock")) return "poetry";
	if (s.has("Pipfile.lock")) return "pipenv";
	if (s.has("Cargo.lock")) return "cargo";
	if (s.has("Gemfile.lock")) return "bundler";
	if (s.has("go.sum")) return "go mod";
	if (s.has("mix.lock")) return "mix";
	return null;
}

/** Detect primary language from single-scan extension counts. */
function detectLanguage(s: ProjectSignals): string | null {
	const counts = s.extCounts;
	if (Object.keys(counts).length === 0) return null;
	const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	switch (best[0]) {
		case ".ts":
		case ".tsx":
			return "TypeScript";
		case ".js":
		case ".jsx":
			return "JavaScript";
		case ".py":
			return "Python";
		case ".rs":
			return "Rust";
		case ".go":
			return "Go";
		case ".rb":
			return "Ruby";
		case ".ex":
		case ".exs":
			return "Elixir";
		case ".java":
			return "Java";
		case ".kt":
			return "Kotlin";
		case ".swift":
			return "Swift";
		case ".c":
		case ".cpp":
		case ".h":
		case ".hpp":
			return "C/C++";
		default:
			return best[0].slice(1).toUpperCase();
	}
}

/** Detect web / backend framework from config files and dependencies. */
function detectFramework(s: ProjectSignals): string | null {
	// JavaScript / TypeScript
	if (s.hasDep("next")) return "Next.js";
	if (s.hasDep("remix") || s.hasDep("@remix-run/react")) return "Remix";
	if (s.hasDep("astro")) return "Astro";
	if (s.hasConfig("svelte.config") || s.hasDep("svelte")) return "Svelte";
	if (s.hasDep("nuxt") || s.hasConfig("nuxt.config")) return "Nuxt";
	if ((s.hasDep("vue") || s.hasDep("@vue")) && s.hasDep("vite")) return "Vue + Vite";
	// Check config-first for Next.js (reachable even when react dep is in a sub-package)
	if (s.hasConfig("next.config")) return "Next.js";
	if (s.hasDep("react") || s.hasDep("preact")) {
		if (s.hasConfig("vite.config")) return "React + Vite";
		if (s.hasConfig("remix.config")) return "Remix";
		return "React";
	}
	if (s.hasConfig("vite.config")) return "Vite";
	if (s.hasDep("express")) return "Express";
	if (s.hasDep("fastify")) return "Fastify";
	if (s.hasDep("koa")) return "Koa";
	if (s.hasDep("hono")) return "Hono";
	if (s.hasDep("elysia")) return "Elysia";

	// Python
	if (s.hasDep("fastapi")) return "FastAPI";
	if (s.hasDep("flask")) return "Flask";
	if (s.hasDep("django")) return "Django";
	if (s.has("manage.py")) return "Django";
	if (s.pyprojectRaw) {
		if (/fastapi/i.test(s.pyprojectRaw)) return "FastAPI";
		if (/flask/i.test(s.pyprojectRaw)) return "Flask";
		if (/django/i.test(s.pyprojectRaw)) return "Django";
	}

	// Rust
	if (s.cargoRaw) {
		if (/actix-web|actix_web/i.test(s.cargoRaw)) return "Actix Web";
		if (/axum/i.test(s.cargoRaw)) return "Axum";
		if (/rocket/i.test(s.cargoRaw)) return "Rocket";
		if (/leptos/i.test(s.cargoRaw)) return "Leptos";
		if (/yew/i.test(s.cargoRaw)) return "Yew";
		if (/tauri/i.test(s.cargoRaw)) return "Tauri";
		return null;
	}

	return null;
}

/** Detect design system / UI library. */
function detectDesignSystem(s: ProjectSignals): string | null {
	if (s.hasConfig("tailwind.config") || s.hasDep("tailwindcss")) {
		if (s.hasDep("@radix-ui") || s.hasDep("shadcn-ui") || s.has("components.json"))
			return "Tailwind + shadcn/ui";
		if (s.hasDep("daisyui")) return "Tailwind + DaisyUI";
		if (s.hasDep("flowbite") || s.hasDep("flowbite-react")) return "Tailwind + Flowbite";
		if (s.hasDep("headlessui") || s.hasDep("@headlessui/react")) return "Tailwind + Headless UI";
		return "Tailwind CSS";
	}
	if (s.hasDep("@mui/material") || s.hasDep("@mui/icons-material")) return "MUI";
	if (s.hasDep("@chakra-ui/react")) return "Chakra UI";
	if (s.hasDep("antd")) return "Ant Design";
	if (s.hasDep("bootstrap")) return "Bootstrap";
	if (s.hasDep("@mantine/core")) return "Mantine";
	if (s.hasDep("@nextui-org/react") || s.hasDep("heroui")) return "NextUI";
	return null;
}

/** Detect build tool. */
function detectBuildTool(s: ProjectSignals): string | null {
	if (s.hasConfig("vite.config")) return "Vite";
	if (s.hasConfig("tsup.config")) return "tsup";
	if (s.hasConfig("rollup.config")) return "Rollup";
	if (s.hasConfig("webpack.config")) return "Webpack";
	if (s.hasConfig("esbuild.config")) return "esbuild";
	if (s.has("turbo.json")) return "Turbopack";
	if (s.has("tsconfig.json") && !s.hasDep("vite") && !s.hasDep("next")) return "tsc";
	if (s.hasDep("tsup")) return "tsup";
	if (s.hasDep("unbuild")) return "unbuild";
	if (s.has("Cargo.toml")) return "Cargo";
	if (s.hasAny("setup.py", "pyproject.toml")) return "setuptools";
	return null;
}

/** Detect test runner. */
function detectTestRunner(s: ProjectSignals): string | null {
	if (s.hasConfig("vitest.config") || s.hasDep("vitest")) return "Vitest";
	if (s.hasDep("jest")) return "Jest";
	if (s.hasDep("mocha")) return "Mocha";
	if (s.hasDep("ava")) return "AVA";
	if (s.hasDep("playwright") || s.hasDep("@playwright/test")) return "Playwright";
	if (s.hasDep("cypress")) return "Cypress";
	if (s.hasDep("pytest")) return "pytest";
	if (s.hasDep("unittest")) return "unittest";
	if (s.cargoRaw) {
		if (/\[dev-dependencies\]/.test(s.cargoRaw)) return "cargo test";
	}
	if (s.has("spec") || s.has("test")) {
		try {
			const entries = readdirSync(join(s.cwd, "spec"));
			if (entries.some((e) => e.endsWith("_spec.rb"))) return "RSpec";
		} catch {}
	}
	return null;
}

/** Detect linter. */
function detectLinter(s: ProjectSignals): string | null {
	if (s.hasAny("biome.json", "biome.jsonc")) return "Biome";
	if (s.hasConfig("eslint.config") || s.hasAny(".eslintrc.js", ".eslintrc.json", ".eslintrc.yaml"))
		return "ESLint";
	if (s.hasAny("oxlintrc.json", ".oxlintrc.json")) return "Oxlint";
	if (s.hasDep("eslint")) return "ESLint";
	if (s.hasDep("oxlint")) return "Oxlint";

	// Python
	if (s.pyprojectRaw) {
		if (/\[tool\.ruff\]/.test(s.pyprojectRaw)) return "Ruff";
		if (/\[tool\.pylint\]/.test(s.pyprojectRaw)) return "Pylint";
	}

	// Ruby
	if (s.has(".rubocop.yml")) return "Rubocop";

	// Rust
	if (s.cargoRaw) {
		if (/clippy/i.test(s.cargoRaw)) return "Clippy";
	}

	return null;
}

/** Detect formatter. */
function detectFormatter(s: ProjectSignals): string | null {
	if (s.hasAny("biome.json", "biome.jsonc")) return "Biome";
	if (
		s.hasAny(".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.js") ||
		s.hasConfig("prettier.config")
	)
		return "Prettier";
	if (s.hasDep("prettier")) return "Prettier";
	if (s.hasDep("dprint")) return "dprint";

	// Python
	if (s.pyprojectRaw) {
		if (/\[tool\.ruff\]/.test(s.pyprojectRaw)) return "Ruff";
		if (/\[tool\.black\]/.test(s.pyprojectRaw)) return "Black";
	}

	return null;
}

/** Detect directory architecture pattern. */
function detectDirectoryPattern(s: ProjectSignals): string | null {
	// Go standard
	if (s.has("cmd") && s.has("internal") && s.has("pkg")) return "Go standard (cmd/internal/pkg)";

	// Next.js App Router
	if ((s.has("app/layout.tsx") || s.has("app/layout.ts")) && s.has("app/page.tsx"))
		return "Next.js App Router";

	// Feature-based
	if (s.has("src/features") || s.has("features")) return "Feature-based";

	// Layer-based React
	const layers = ["components", "hooks", "utils", "pages", "services", "stores"];
	const layerCount = layers.filter((l) => s.has(`src/${l}`) || s.has(l)).length;
	if (layerCount >= 3) return "Layer-based (components/hooks/utils/...)";

	// MVC
	const mvcCount = ["models", "views", "controllers"].filter(
		(d) => s.has(`src/${d}`) || s.has(d),
	).length;
	if (mvcCount >= 2) return "MVC";

	// Flat
	const flatDirs = ["src", "lib", "utils", "helpers"];
	if (flatDirs.some((d) => s.has(d))) return "Flat";

	return null;
}

const COMMIT_STYLE_CACHE_MAX = 100;
const commitStyleCache = new Map<string, { value: string | null; expiresAt: number }>();

function pruneCommitStyleCache(): void {
	if (commitStyleCache.size <= COMMIT_STYLE_CACHE_MAX) return;
	// Evict expired entries first
	const now = Date.now();
	for (const [key, entry] of commitStyleCache) {
		if (entry.expiresAt <= now) commitStyleCache.delete(key);
	}
	// If still over, evict oldest (Map insertion order)
	while (commitStyleCache.size > COMMIT_STYLE_CACHE_MAX) {
		const oldest = commitStyleCache.keys().next().value;
		if (oldest === undefined) break;
		commitStyleCache.delete(oldest);
	}
}

/** Auto-detect commit style from recent commits (async, non-blocking). */
async function detectCommitStyle(cwd: string): Promise<string | null> {
	const cached = commitStyleCache.get(cwd);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	let value: string | null = null;
	try {
		const child = spawn("git", ["log", "--format=%s", "-20", "--no-decorate"], {
			cwd,
			timeout: 2000,
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.resume();
		const code = await new Promise<number | null>((resolve) => {
			child.on("close", resolve);
			child.on("error", () => resolve(null));
		});
		if (code === 0) {
			const stdout = Buffer.concat(chunks).toString("utf8");
			const lines = stdout.trim().split("\n").filter(Boolean);
			if (lines.length > 0) {
				const matchCount = lines.filter((l) => /^\w+(\s*\(.*?\))?!?:\s/.test(l)).length;
				if (matchCount >= lines.length * 0.6) value = "conventional";
				else {
					const imperative = lines.filter((l) => /^[A-Z][a-z]/.test(l)).length;
					value = imperative >= lines.length * 0.6 ? "imperative" : "mixed";
				}
			}
		}
	} catch {
		/* git unavailable or timed out */
	}

	commitStyleCache.set(cwd, { value, expiresAt: Date.now() + 3_600_000 });
	pruneCommitStyleCache();
	return value;
}

/** Auto-detect indent style from project files. */
function detectIndent(cwd: string): string | null {
	// Check .editorconfig first
	const ec = join(cwd, ".editorconfig");
	if (existsSync(ec)) {
		try {
			const content = readFileSync(ec, "utf8");
			const tabMatch = /indent_style\s*=\s*tab/.test(content);
			if (tabMatch) return "tabs";
			const spaceMatch = /indent_style\s*=\s*space/.test(content);
			if (spaceMatch) {
				const sizeMatch = content.match(/indent_size\s*=\s*(\d+)/);
				return `spaces-${sizeMatch?.[1] ?? "2"}`;
			}
		} catch {}
	}
	// Check Prettier config
	if (has(cwd, ".prettierrc")) {
		try {
			const pr = JSON.parse(readFileSync(join(cwd, ".prettierrc"), "utf8"));
			if (pr.useTabs) return "tabs";
			if (pr.tabWidth) return `spaces-${pr.tabWidth}`;
		} catch {}
	}
	// Sample a ts/tsx file
	for (const dir of ["src", "app", "lib", "."]) {
		const full = join(cwd, dir);
		if (!existsSync(full)) continue;
		try {
			const entries = readdirSync(full);
			const tsFile = entries.find((e) => e.endsWith(".ts") && !e.endsWith(".d.ts"));
			if (tsFile) {
				const content = readFileSync(join(full, tsFile), "utf8");
				// Count tab vs space indents in first 50 non-empty lines
				let tabLines = 0,
					spaceLines = 0;
				for (const line of content.split("\n").slice(0, 50)) {
					if (line.startsWith("\t")) tabLines++;
					else if (line.startsWith("  ")) spaceLines++;
				}
				if (tabLines > spaceLines) return "tabs";
				if (spaceLines > 0) {
					// Check space size
					const match = content.match(/^ {2,}(?=\S)/m);
					const size = match ? match[0].length : 2;
					return `spaces-${size}`;
				}
			}
		} catch {}
	}
	return null;
}

// ── Full detection pipeline ──────────────────────────────────────────────────

function detectProject(cwd: string): ProjectProfile {
	const s = collectSignals(cwd);
	const name = s.pkg?.name ?? basename(cwd);

	return {
		name,
		packageManager: detectPackageManager(s),
		language: detectLanguage(s),
		framework: detectFramework(s),
		designSystem: detectDesignSystem(s),
		buildTool: detectBuildTool(s),
		testRunner: detectTestRunner(s),
		linter: detectLinter(s),
		formatter: detectFormatter(s),
		monorepo: s.hasAny("pnpm-workspace.yaml", "lerna.json") || !!s.pkg?.workspaces,
		directoryPattern: detectDirectoryPattern(s),
		conventions: [], // filled manually by agent
		facts: [], // filled manually by agent
		lastScanned: Date.now(),
		fingerprint: projectFingerprint(cwd),
	};
}

/**
 * Reconcile: overlay freshly auto-detected tech-stack fields onto the stored
 * profile, preserving manual conventions/facts AND any field pi-memory does not
 * own (e.g. quest's `research`/`lastModified`). See `reconcileProfile`.
 */
function reconcile(cwd: string, stored: ProjectProfile): ProjectProfile {
	return reconcileProfile(stored, detectProject(cwd));
}

async function detectUser(cwd: string): Promise<Partial<UserProfile>> {
	return {
		commitStyle: await detectCommitStyle(cwd),
		indent: detectIndent(cwd),
	};
}

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
		// If key project files have not changed, refresh the timestamp and skip the
		// expensive directory walk/count detectors.
		if (!stored.lastScanned || Date.now() - stored.lastScanned > 3_600_000) {
			const currentFingerprint = projectFingerprint(cwd);
			if (sameFingerprint(stored.fingerprint, currentFingerprint)) {
				projectProfile = { ...stored, lastScanned: Date.now(), fingerprint: currentFingerprint };
				saveProject(cwd, projectProfile);
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

			return {
				systemPrompt: `${event.systemPrompt}\n\n${block}`,
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
