/**
 * Project & user auto-detection for pi-memory.
 *
 * Pure tech-stack detection: fingerprinting, signal collection, the per-aspect
 * detectors (language, framework, package manager, …), and the
 * detectProject / reconcile / detectUser pipeline. No extension or runtime state
 * — kept out of index.ts so it can be unit-tested in isolation.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { ProjectMemory as ProjectProfile, UserMemory as UserProfile } from "../../core";
import { reconcileProfile } from "./profile";

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

export function projectFingerprint(cwd: string): Record<string, number> {
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

export function sameFingerprint(a?: Record<string, number>, b?: Record<string, number>): boolean {
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

export function detectProject(cwd: string): ProjectProfile {
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
export function reconcile(cwd: string, stored: ProjectProfile): ProjectProfile {
	return reconcileProfile(stored, detectProject(cwd));
}

export async function detectUser(cwd: string): Promise<Partial<UserProfile>> {
	return {
		commitStyle: await detectCommitStyle(cwd),
		indent: detectIndent(cwd),
	};
}
