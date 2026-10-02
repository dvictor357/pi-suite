/**
 * Shared source-file discovery for the codebase index.
 *
 * Prefers git's tracked/untracked view so scans respect .gitignore, then
 * falls back to a recursive filesystem walk for non-git temp directories.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_EXCLUDES = [
	"node_modules",
	".git",
	".pi",
	".venv",
	"venv",
	"env",
	".env",
	"vendor",
	"target",
	"dist",
	"build",
	"out",
	"bin",
	"obj",
	".next",
	".nuxt",
	".cache",
	"coverage",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".turbo",
	".vercel",
	".output",
	"*.min.js",
	"*.min.mjs",
	"*.min.cjs",
	".DS_Store",
];

const SOURCE_FILENAMES = new Set([
	"Dockerfile",
	"Containerfile",
	"Makefile",
	"Rakefile",
	"Gemfile",
	"Podfile",
	"Fastfile",
	"Jenkinsfile",
	"CMakeLists.txt",
	"WORKSPACE",
	"BUILD",
	"BUILD.bazel",
	"MODULE.bazel",
]);

export const SOURCE_EXTS = new Set([
	".asm",
	".astro",
	".awk",
	".bash",
	".bat",
	".c",
	".cc",
	".clj",
	".cljs",
	".cjs",
	".cmake",
	".coffee",
	".cpp",
	".cs",
	".csh",
	".css",
	".cts",
	".cu",
	".cuh",
	".cxx",
	".dart",
	".elm",
	".erl",
	".ex",
	".exs",
	".f",
	".f90",
	".fs",
	".fsi",
	".fsx",
	".gleam",
	".go",
	".graphql",
	".groovy",
	".h",
	".haml",
	".hbs",
	".hpp",
	".hrl",
	".hs",
	".htm",
	".html",
	".hxx",
	".java",
	".jl",
	".js",
	".jsx",
	".kt",
	".kts",
	".less",
	".lua",
	".m",
	".mm",
	".mjs",
	".ml",
	".mli",
	".mts",
	".nim",
	".php",
	".pl",
	".pm",
	".proto",
	".ps1",
	".py",
	".pyi",
	".r",
	".rb",
	".rs",
	".sass",
	".scala",
	".scss",
	".sh",
	".sol",
	".sql",
	".svelte",
	".swift",
	".tcl",
	".tf",
	".toml",
	".ts",
	".tsx",
	".vue",
	".zig",
	".zsh",
]);

export function shouldExcludePath(relativePathOrName: string, extraExcludes: string[]): boolean {
	const normalized = relativePathOrName.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	const basename = parts.at(-1) ?? normalized;
	const all = [...DEFAULT_EXCLUDES, ...extraExcludes];

	return all.some((pattern) => {
		const normalizedPattern = pattern.replace(/\\/g, "/").replace(/\/$/, "");
		if (normalizedPattern.includes("*")) {
			const regex = new RegExp(
				"^" + normalizedPattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
			);
			return regex.test(basename) || regex.test(normalized);
		}

		return (
			basename === normalizedPattern ||
			parts.includes(normalizedPattern) ||
			normalized === normalizedPattern ||
			normalized.startsWith(`${normalizedPattern}/`)
		);
	});
}

export function isSourceFile(name: string): boolean {
	return (
		SOURCE_FILENAMES.has(path.basename(name)) || SOURCE_EXTS.has(path.extname(name).toLowerCase())
	);
}

interface DiscoverOptions {
	rootDir: string;
	extraExcludes: string[];
	maxFiles: number;
}

export function discoverSourceFiles(opts: DiscoverOptions): string[] {
	if (opts.maxFiles <= 0) return [];

	const gitFiles = gitSourceFiles(opts);
	if (gitFiles) return gitFiles;

	return walkSourceFiles(opts);
}

function gitSourceFiles(opts: DiscoverOptions): string[] | null {
	try {
		const output = childProcess.execFileSync(
			"git",
			["-C", opts.rootDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);

		return output
			.split("\0")
			.filter(Boolean)
			.filter((rel) => isSourceFile(rel) && !shouldExcludePath(rel, opts.extraExcludes))
			.sort()
			.slice(0, opts.maxFiles)
			.map((rel) => path.join(opts.rootDir, rel));
	} catch {
		return null;
	}
}

function walkSourceFiles(opts: DiscoverOptions): string[] {
	const files: string[] = [];
	const stack: string[] = [opts.rootDir];

	while (stack.length > 0 && files.length < opts.maxFiles) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];

		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const rel = path.posix.relative(
				opts.rootDir.replace(/\\/g, "/"),
				fullPath.replace(/\\/g, "/"),
			);
			if (shouldExcludePath(rel, opts.extraExcludes)) continue;

			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && isSourceFile(entry.name)) {
				files.push(fullPath);
				if (files.length >= opts.maxFiles) break;
			}
		}
	}

	return files.sort();
}
