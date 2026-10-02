/**
 * Codebase indexer — recursive repo scanner
 *
 * Discovers source files (respecting gitignore when possible) and parses
 * JS/TS imports, exports, and top-level symbols with pragmatic regexes.
 * Builds dependency and reverse-dependency maps.
 *
 * Dependencies: Node built-ins only (fs, path, crypto).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverSourceFiles } from "./file-discovery.js";
import {
	type FileEntry,
	type ImportEntry,
	type ExportEntry,
	type IndexData,
	type ScanOptions,
	type SymbolEntry,
	CODEBASE_CONTRACT_VERSION,
	DEFAULT_MAX_FILES,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function quickHash(content: string): string {
	return crypto.createHash("sha256").update(content.slice(0, 16384), "utf8").digest("hex");
}

// ── Regex-based parsers (pragmatic, not spec-complete) ──────────────────────

const IMPORT_RE =
	/import\s+(?:type\s+)?(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;

const IMPORT_NAMED_RE = /\{([^}]+)\}/;

const EXPORT_RE =
	/export\s+\{([^}]+)\}|export\s+default\s+(?:(?:class|function|async\s+function)\s+([A-Za-z_$][\w$]*)|(?!function\b|class\b|async\b)([A-Za-z_$][\w$]*))|export\s+(?:type\s+)?(?:const|let|var|function|class|interface|enum|type|async\s+function)\s+([A-Za-z_$][\w$]*)/g;

const ANONYMOUS_DEFAULT_EXPORT_RE =
	/export\s+default\s+(?:(?:async\s+function|function)\s*\(|class\s*\{|[^A-Za-z_$\s])/;

const SYMBOL_RE =
	/(?:^|\n)\s*(?:export\s+)?(?:const|let|var|function|class|interface|enum|type|async\s+function)\s+(\w+)/g;

function parseImports(content: string, relativeDir: string, relativePath: string): ImportEntry[] {
	const imports: ImportEntry[] = [];
	const seen = new Set<string>();
	const ext = path.extname(relativePath).toLowerCase();

	const addImport = (entry: ImportEntry) => {
		const key = `${entry.source}|${entry.names.join(",")}|${entry.resolved}`;
		if (seen.has(key)) return;
		seen.add(key);
		imports.push(entry);
	};

	for (const match of content.matchAll(IMPORT_RE)) {
		const source = match[1];
		const stmt = match[0];
		const isType = stmt.startsWith("import type");
		const names: string[] = [];
		const namedMatch = stmt.match(IMPORT_NAMED_RE);
		if (namedMatch) {
			names.push(
				...namedMatch[1]
					.split(",")
					.map((s) => s.replace(/as\s+\w+/, "").trim())
					.filter(Boolean),
			);
		} else if (stmt.includes("* as ")) {
			const nsMatch = stmt.match(/\*\s+as\s+(\w+)/);
			if (nsMatch) names.push(nsMatch[1]);
		} else {
			// default import
			const defaultMatch = stmt.match(/import\s+(\w+)/);
			if (defaultMatch && defaultMatch[1] !== "type") {
				names.push(defaultMatch[1]);
			}
		}

		let resolved = "";
		if (source.startsWith(".")) {
			resolved = path.posix.normalize(path.posix.join(relativeDir, source));
		}

		addImport({
			source,
			names,
			isDefault: !namedMatch && !stmt.includes("* as "),
			isType,
			resolved,
		});
	}

	if ([".py", ".pyi"].includes(ext)) {
		const fromRe = /^\s*from\s+([\w.]+|\.+[\w.]*)\s+import\s+([^#\n]+)/gm;
		const importRe = /^\s*import\s+([^#\n]+)/gm;
		for (const match of content.matchAll(fromRe)) {
			const source = match[1];
			const names = match[2]
				.split(",")
				.map((s) => s.replace(/\s+as\s+\w+/, "").trim())
				.filter(Boolean);
			const resolved = source.startsWith(".")
				? path.posix.normalize(path.posix.join(relativeDir, source.replace(/^\./, "")))
				: source.replace(/\./g, "/");
			addImport({ source, names, isDefault: false, isType: false, resolved });
		}
		for (const match of content.matchAll(importRe)) {
			const specs = match[1]
				.split(",")
				.map((s) => s.replace(/\s+as\s+\w+/, "").trim())
				.filter(Boolean);
			for (const source of specs) {
				addImport({
					source,
					names: [],
					isDefault: true,
					isType: false,
					resolved: source.replace(/\./g, "/"),
				});
			}
		}
	}

	const includeRe = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm;
	for (const match of content.matchAll(includeRe)) {
		const source = match[1];
		addImport({
			source,
			names: [],
			isDefault: false,
			isType: false,
			resolved: source.includes("/")
				? path.posix.normalize(path.posix.join(relativeDir, source))
				: source,
		});
	}

	if ([".go"].includes(ext)) {
		const blockRe = /import\s*\(([^)]+)\)/gm;
		const singleRe = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
		for (const match of content.matchAll(blockRe)) {
			for (const line of match[1].split("\n")) {
				const source = line.match(/"([^"]+)"/)?.[1];
				if (!source) continue;
				addImport({
					source,
					names: [],
					isDefault: false,
					isType: false,
					resolved: source,
				});
			}
		}
		for (const match of content.matchAll(singleRe)) {
			addImport({
				source: match[1],
				names: [],
				isDefault: false,
				isType: false,
				resolved: match[1],
			});
		}
	}

	if ([".rs"].includes(ext)) {
		const useRe = /^\s*(?:pub\s+)?use\s+([^;]+);/gm;
		const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
		for (const match of content.matchAll(useRe)) {
			addImport({
				source: match[1].trim(),
				names: [],
				isDefault: false,
				isType: false,
				resolved: "",
			});
		}
		for (const match of content.matchAll(modRe)) {
			addImport({
				source: match[1],
				names: [],
				isDefault: false,
				isType: false,
				resolved: path.posix.join(relativeDir, match[1]),
			});
		}
	}

	return imports;
}

function parseExports(content: string): ExportEntry[] {
	const exports: ExportEntry[] = [];
	const seen = new Set<string>();

	let match: RegExpExecArray | null;
	const re = new RegExp(EXPORT_RE.source, "g");
	while ((match = re.exec(content)) !== null) {
		if (match[1]) {
			// export { a, b, c }
			const names = match[1]
				.split(",")
				.map((s) => s.replace(/as\s+\w+/, "").trim())
				.filter(Boolean);
			for (const name of names) {
				if (!seen.has(name)) {
					seen.add(name);
					exports.push({ name, kind: "named" });
				}
			}
		} else if (match[2] || match[3]) {
			// export default <name> or export default function/class <name>
			const name = match[2] ?? match[3];
			if (!seen.has(name)) {
				seen.add(name);
				exports.push({ name, kind: "default" });
			}
		} else if (match[4]) {
			// export const/function/class/interface/enum/type Name
			const name = match[4];
			const isTypeExport =
				/export\s+type\s+/.test(match[0]) ||
				/export\s+interface\s+/.test(match[0]) ||
				/export\s+enum\s+/.test(match[0]);
			if (!seen.has(name)) {
				seen.add(name);
				exports.push({ name, kind: isTypeExport ? "type" : "named" });
			}
		}
	}

	if (ANONYMOUS_DEFAULT_EXPORT_RE.test(content) && !seen.has("default")) {
		exports.push({ name: "default", kind: "default" });
	}

	return exports;
}

function parseSymbols(content: string, ext: string): SymbolEntry[] {
	const symbols: SymbolEntry[] = [];
	const seen = new Set<string>();

	const addSymbol = (name: string, kind: SymbolEntry["kind"]) => {
		if (!name || seen.has(name)) return;
		seen.add(name);
		symbols.push({ name, kind });
	};

	let match: RegExpExecArray | null;
	const re = new RegExp(SYMBOL_RE.source, "g");
	while ((match = re.exec(content)) !== null) {
		const name = match[1];
		const kind: SymbolEntry["kind"] = (() => {
			const decl = match[0];
			if (decl.includes("function") || decl.includes("async")) return "function";
			if (decl.includes("class")) return "class";
			if (decl.includes("interface")) return "interface";
			if (decl.includes("enum")) return "enum";
			if (decl.includes("type")) return "type";
			return "variable";
		})();

		addSymbol(name, kind);
	}

	const genericPatterns: Array<[RegExp, SymbolEntry["kind"]]> = [];

	if ([".py", ".pyi"].includes(ext)) {
		genericPatterns.push(
			[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, "function"],
			[/^\s*class\s+([A-Za-z_]\w*)\b/gm, "class"],
		);
	}

	if (ext === ".rs") {
		genericPatterns.push(
			[/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/gm, "function"],
			[/^\s*(?:pub\s+)?(?:struct|trait|impl)\s+([A-Za-z_]\w*)\b/gm, "class"],
			[/^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)\b/gm, "enum"],
		);
	}

	if (ext === ".go") {
		genericPatterns.push(
			[/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, "function"],
			[/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm, "type"],
		);
	}

	if ([".java", ".kt", ".kts", ".swift", ".cs"].includes(ext)) {
		genericPatterns.push(
			[
				/^\s*(?:public|private|protected|internal|static|final|abstract|open|data|sealed|record|partial|async|override|virtual|inline|suspend|fun\s+)*\s*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)\b/gm,
				"class",
			],
			[
				/^\s*(?:public|private|protected|internal|static|final|abstract|open|override|virtual|inline|suspend|async|fun\s+)*\s*(?:fun|function)\s+([A-Za-z_]\w*)\s*\(/gm,
				"function",
			],
		);
	}

	if ([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"].includes(ext)) {
		genericPatterns.push([
			/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|inline|constexpr|consteval|func)\s+)*(?:[A-Za-z_$][\w$:<>,.?*&\[\] ]*\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|=>)/gm,
			"function",
		]);
	}

	if ([".lua"].includes(ext)) {
		genericPatterns.push([/^\s*(?:local\s+)?function\s+([A-Za-z_]\w*)\s*\(/gm, "function"]);
	}

	for (const [pattern, kind] of genericPatterns) {
		for (const genericMatch of content.matchAll(pattern)) {
			addSymbol(genericMatch[1], kind);
		}
	}

	return symbols;
}

function resolveImportPath(rawResolved: string, knownFiles: Set<string>): string | null {
	if (!rawResolved) return null;

	const ext = path.posix.extname(rawResolved);
	const modulePath = rawResolved.replace(/\./g, "/");
	const sourceExts = [
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".mts",
		".cts",
		".py",
		".pyi",
		".go",
		".rs",
		".java",
		".kt",
		".kts",
		".swift",
		".rb",
		".php",
		".cs",
		".c",
		".h",
		".cc",
		".cpp",
		".hpp",
		".cxx",
		".hxx",
		".lua",
		".ex",
		".exs",
		".erl",
		".hrl",
	];
	const indexNames = ["index", "__init__", "mod"];
	const candidates = ext
		? [
				rawResolved,
				rawResolved.replace(/\.(js|jsx|mjs|cjs)$/i, ".ts"),
				rawResolved.replace(/\.(js|jsx|mjs|cjs)$/i, ".tsx"),
			]
		: [
				rawResolved,
				...sourceExts.flatMap((sourceExt) => [
					`${rawResolved}${sourceExt}`,
					`${modulePath}${sourceExt}`,
				]),
				...indexNames.flatMap((indexName) =>
					sourceExts.map((sourceExt) => `${rawResolved}/${indexName}${sourceExt}`),
				),
			];

	for (const candidate of candidates) {
		if (knownFiles.has(candidate)) return candidate;
	}

	return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan a repository and build a fresh index (no cache interaction).
 * Returns the raw IndexData without touching disk.
 */
export function scanRepo(opts: ScanOptions = {}): IndexData {
	const rootDir = path.resolve(opts.rootDir ?? process.cwd());
	const extraExcludes = opts.extraExcludes ?? [];
	const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

	const absFiles = discoverSourceFiles({ rootDir, extraExcludes, maxFiles });

	const files: Record<string, FileEntry> = {};
	const dependencies: Record<string, string[]> = {};
	// Temporary set-of-sets for reverse deps (built after)
	const revDepsTemp = new Map<string, Set<string>>();

	let fileCount = 0;

	for (const absPath of absFiles) {
		let content: string;
		try {
			content = fs.readFileSync(absPath, "utf8");
		} catch {
			continue;
		}

		const relativePath = path.posix.relative(
			rootDir.replace(/\\/g, "/"),
			absPath.replace(/\\/g, "/"),
		);
		const stat = fs.statSync(absPath);
		const relativeDir = path.posix.dirname(relativePath);

		const entry: FileEntry = {
			path: absPath,
			name: path.basename(absPath),
			relativePath,
			imports: parseImports(content, relativeDir === "." ? "" : relativeDir, relativePath),
			exports: parseExports(content),
			symbols: parseSymbols(content, path.extname(relativePath).toLowerCase()),
			mtime: stat.mtimeMs,
			hash: quickHash(content),
		};

		files[relativePath] = entry;
		fileCount++;
	}

	const knownFiles = new Set(Object.keys(files));

	for (const [relativePath, entry] of Object.entries(files)) {
		const deps: string[] = [];
		for (const imp of entry.imports) {
			const resolved = resolveImportPath(imp.resolved, knownFiles);
			if (!resolved) {
				imp.resolved = "";
				continue;
			}

			imp.resolved = resolved;
			deps.push(resolved);
			let revSet = revDepsTemp.get(resolved);
			if (!revSet) {
				revSet = new Set();
				revDepsTemp.set(resolved, revSet);
			}
			revSet.add(relativePath);
		}
		dependencies[relativePath] = [...new Set(deps)];
	}

	// Convert reverse deps Map<Set> → Record<string, string[]>
	const reverseDependencies: Record<string, string[]> = {};
	for (const [target, sources] of revDepsTemp) {
		reverseDependencies[target] = [...sources];
	}

	// Ensure every file has entries in maps
	for (const rel of Object.keys(files)) {
		if (!dependencies[rel]) dependencies[rel] = [];
		if (!reverseDependencies[rel]) reverseDependencies[rel] = [];
	}

	return {
		contractVersion: CODEBASE_CONTRACT_VERSION,
		rootDir,
		scannedAt: Date.now(),
		fileCount,
		files,
		dependencies,
		reverseDependencies,
	};
}
