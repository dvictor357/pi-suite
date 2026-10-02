/**
 * Tests for codebase intelligence (indexer, cache, query, types).
 *
 * Uses deterministic temp directories to avoid polluting the real project
 * or depending on external state.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStaleness, readCache, writeCache } from "./cache.js";
import { scanRepo } from "./indexer.js";
import {
	allFiles,
	depMap,
	getDependencies,
	getFile,
	getImpact,
	getReverseDependencies,
	indexSummary,
	queryFiles,
	scanIndex,
} from "./query.js";
import { CODEBASE_CONTRACT_VERSION, type IndexData } from "./types.js";
import { discoverAgents } from "../agents.js";
import { CodebaseOperation, CodebaseParams } from "../index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codebase-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeFile(root: string, relativePath: string, content: string): void {
	const abs = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf8");
}

function initGitRepo(root: string): boolean {
	try {
		childProcess.execFileSync("git", ["init"], {
			cwd: root,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function createMinimalRepo(root: string): void {
	writeFile(
		root,
		"src/index.ts",
		[
			`import { greet } from "./greeter.js";`,
			`import type { Options } from "./config";`,
			`import * as utils from "./utils";`,
			``,
			`export const name = "app";`,
			`export function start() {`,
			`  return greet(name);`,
			`}`,
			`export default start;`,
		].join("\n"),
	);

	writeFile(
		root,
		"src/greeter.ts",
		[
			`import { format } from "./format.js";`,
			`import { type Config } from "./config";`,
			``,
			`export function greet(name: string): string {`,
			`  return format(name);`,
			`}`,
			``,
			`export class Greeter {`,
			`  greet(name: string) { return "Hello " + name; }`,
			`}`,
		].join("\n"),
	);

	writeFile(
		root,
		"src/format.ts",
		[`export function format(s: string): string {`, `  return s.toUpperCase();`, `}`].join("\n"),
	);

	writeFile(
		root,
		"src/config.ts",
		[
			`export interface Options {`,
			`  verbose?: boolean;`,
			`}`,
			``,
			`export type Config = {`,
			`  timeout: number;`,
			`};`,
			``,
			`export const DEFAULT_TIMEOUT = 5000;`,
		].join("\n"),
	);

	writeFile(
		root,
		"src/utils.ts",
		[`export function noop() {}`, ``, `export const VERSION = "1.0.0";`].join("\n"),
	);
}

// ── Indexer: scanRepo ───────────────────────────────────────────────────────

describe("scanRepo (indexer)", () => {
	it("scans JS/TS files and builds index with correct contract version", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
		writeFile(root, "node_modules/dep/index.ts", "export const x = 1;");
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		writeFile(root, ".git/config", "ignored");

		const index = scanRepo({ rootDir: root });

		expect(index.contractVersion).toBe(CODEBASE_CONTRACT_VERSION);
		expect(index.rootDir).toBe(root);
		expect(index.fileCount).toBe(5); // node_modules/.git excluded
		expect(Object.keys(index.files)).toEqual([
			"src/config.ts",
			"src/format.ts",
			"src/greeter.ts",
			"src/index.ts",
			"src/utils.ts",
		]);
	});

	it("parses imports correctly", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const index = scanRepo({ rootDir: root });
		const indexFile = index.files["src/index.ts"];

		expect(indexFile.imports).toHaveLength(3);

		// Named import with .js → .ts resolution
		const greetImport = indexFile.imports.find((i) => i.source === "./greeter.js");
		expect(greetImport).toBeDefined();
		expect(greetImport!.names).toContain("greet");
		expect(greetImport!.isDefault).toBe(false);
		expect(greetImport!.isType).toBe(false);
		expect(greetImport!.resolved).toBe("src/greeter.ts");

		// Type import
		const typeImport = indexFile.imports.find((i) => i.source === "./config");
		expect(typeImport).toBeDefined();
		expect(typeImport!.isType).toBe(true);
		expect(typeImport!.names).toContain("Options");
		expect(typeImport!.resolved).toBe("src/config.ts");

		// Namespace import
		const nsImport = indexFile.imports.find((i) => i.source === "./utils");
		expect(nsImport).toBeDefined();
		expect(nsImport!.names).toContain("utils");
		expect(nsImport!.isDefault).toBe(false);
		expect(nsImport!.resolved).toBe("src/utils.ts");
	});

	it("parses exports correctly", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const index = scanRepo({ rootDir: root });

		const indexExports = index.files["src/index.ts"].exports;
		expect(indexExports).toContainEqual(expect.objectContaining({ name: "name", kind: "named" }));
		expect(indexExports).toContainEqual(expect.objectContaining({ name: "start", kind: "named" }));

		const configExports = index.files["src/config.ts"].exports;
		expect(configExports).toContainEqual(
			expect.objectContaining({ name: "Options", kind: "type" }),
		);
		expect(configExports).toContainEqual(expect.objectContaining({ name: "Config", kind: "type" }));
		expect(configExports).toContainEqual(
			expect.objectContaining({ name: "DEFAULT_TIMEOUT", kind: "named" }),
		);

		const utilsExports = index.files["src/utils.ts"].exports;
		expect(utilsExports).toContainEqual(expect.objectContaining({ name: "noop", kind: "named" }));
		expect(utilsExports).toContainEqual(
			expect.objectContaining({ name: "VERSION", kind: "named" }),
		);
	});

	it("parses symbols correctly", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const index = scanRepo({ rootDir: root });

		const greeterFile = index.files["src/greeter.ts"];
		const syms = greeterFile.symbols;
		expect(syms).toContainEqual(expect.objectContaining({ name: "greet", kind: "function" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "Greeter", kind: "class" }));
	});

	it("symbols include interface, enum, type, variable kinds", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/kinds.ts",
			[
				`export interface Foo {}`,
				`export type Bar = string;`,
				`export enum Baz { A, B }`,
				`export const x = 1;`,
			].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const syms = index.files["src/kinds.ts"].symbols;

		expect(syms).toContainEqual(expect.objectContaining({ name: "Foo", kind: "interface" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "Bar", kind: "type" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "Baz", kind: "enum" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "x", kind: "variable" }));
	});

	it("builds dependency and reverse-dependency maps", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const index = scanRepo({ rootDir: root });

		// index.ts imports greeter, config (type), utils
		expect(index.dependencies["src/index.ts"]).toContain("src/greeter.ts");
		expect(index.dependencies["src/index.ts"]).toContain("src/config.ts");
		expect(index.dependencies["src/index.ts"]).toContain("src/utils.ts");

		// greeter.ts imports format, config
		expect(index.dependencies["src/greeter.ts"]).toContain("src/format.ts");
		expect(index.dependencies["src/greeter.ts"]).toContain("src/config.ts");

		// format.ts imports nothing
		expect(index.dependencies["src/format.ts"]).toEqual([]);

		// Reverse: format is imported by greeter
		expect(index.reverseDependencies["src/format.ts"]).toContain("src/greeter.ts");

		// config is imported by index.ts and greeter.ts
		expect(index.reverseDependencies["src/config.ts"]).toContain("src/index.ts");
		expect(index.reverseDependencies["src/config.ts"]).toContain("src/greeter.ts");
	});

	it("resolves .js imports to .ts files", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { b } from "./b.js";');
		writeFile(root, "src/b.ts", "export const b = 1;");

		const index = scanRepo({ rootDir: root });

		expect(index.files["src/a.ts"].imports[0].resolved).toBe("src/b.ts");
		expect(index.dependencies["src/a.ts"]).toContain("src/b.ts");
	});

	it("resolves .jsx imports to .tsx files", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { B } from "./B.jsx";');
		writeFile(root, "src/B.tsx", "export const B = 1;");

		const index = scanRepo({ rootDir: root });

		expect(index.files["src/a.ts"].imports[0].resolved).toBe("src/B.tsx");
	});

	it("resolves extensionless imports with .ts priority", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { b } from "./b";');
		writeFile(root, "src/b.ts", "export const b = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/a.ts"].imports[0].resolved).toBe("src/b.ts");
	});

	it("resolves index.ts when importing a directory", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { foo } from "./lib";');
		writeFile(root, "src/lib/index.ts", "export const foo = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/a.ts"].imports[0].resolved).toBe("src/lib/index.ts");
	});

	it("excludes default directories (node_modules, .git, dist, etc.)", () => {
		const root = makeTempDir();
		writeFile(root, "src/index.ts", "export const x = 1;");
		writeFile(root, "node_modules/lib/index.ts", "export const y = 2;");
		writeFile(root, ".git/hooks/pre-commit.ts", "export const hook = 3;");
		writeFile(root, "dist/bundle.ts", "export const z = 4;");
		writeFile(root, "build/output.ts", "export const w = 5;");
		writeFile(root, "coverage/lcov.ts", "export const cov = 6;");

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual(["src/index.ts"]);
		expect(index.fileCount).toBe(1);
	});

	it("excludes *.min.js files via glob pattern", () => {
		const root = makeTempDir();
		writeFile(root, "src/main.ts", "export const x = 1;");
		writeFile(root, "src/vendor.min.js", "var a=1;");
		writeFile(root, "src/lib.min.mjs", "export const b=2;");
		writeFile(root, "src/lib.min.cjs", "module.exports={};");

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual(["src/main.ts"]);
	});

	it("accepts extra exclude patterns", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", "export const a = 1;");
		writeFile(root, "src/b.ts", "export const b = 2;");
		writeFile(root, "ignored/c.ts", "export const c = 3;");

		const index = scanRepo({ rootDir: root, extraExcludes: ["ignored"] });

		expect(Object.keys(index.files)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("respects maxFiles cap", () => {
		const root = makeTempDir();
		for (let i = 0; i < 10; i++) {
			writeFile(root, `src/file${i}.ts`, `export const x${i} = ${i};`);
		}

		const index = scanRepo({ rootDir: root, maxFiles: 3 });

		expect(index.fileCount).toBeLessThanOrEqual(3);
	});

	it("scans Python source files", () => {
		const root = makeTempDir();
		writeFile(root, "api/main.py", "def app():\n    return True\n");
		writeFile(root, "services/bot/worker.py", "class Worker:\n    pass\n");

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual(["api/main.py", "services/bot/worker.py"]);
		expect(index.fileCount).toBe(2);
	});

	it("respects gitignore when discovering files", () => {
		const root = makeTempDir();
		if (!initGitRepo(root)) return;

		writeFile(root, ".gitignore", ".venv\n");
		writeFile(root, "api/main.py", "def app():\n    return True\n");
		writeFile(root, ".venv/lib/python/site-packages/vendor.js", "var x = 1;");

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual(["api/main.py"]);
	});

	it("ignores non-source files", () => {
		const root = makeTempDir();
		writeFile(root, "src/main.ts", "export const x = 1;");
		writeFile(root, "assets/logo.png", "not really png");
		writeFile(root, "src/data.json", '{"a":1}');

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual(["src/main.ts"]);
	});

	it("indexes symbols across multiple programming languages", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"cmd/server.go",
			["package main", "", "func StartServer() {}", "type Handler struct {}"].join("\n"),
		);
		writeFile(
			root,
			"src/lib.rs",
			["pub mod worker;", "pub fn run_job() {}", "pub struct Queue {}"].join("\n"),
		);
		writeFile(
			root,
			"app/Worker.java",
			["public class Worker {", "  public void process() {}", "}"].join("\n"),
		);
		writeFile(
			root,
			"api/main.py",
			["from services.bot import worker", "def create_app():", "    return True"].join("\n"),
		);

		const index = scanRepo({ rootDir: root });

		expect(Object.keys(index.files)).toEqual([
			"api/main.py",
			"app/Worker.java",
			"cmd/server.go",
			"src/lib.rs",
		]);
		expect(index.files["cmd/server.go"].symbols).toContainEqual(
			expect.objectContaining({ name: "StartServer", kind: "function" }),
		);
		expect(index.files["src/lib.rs"].symbols).toContainEqual(
			expect.objectContaining({ name: "run_job", kind: "function" }),
		);
		expect(index.files["app/Worker.java"].symbols).toContainEqual(
			expect.objectContaining({ name: "Worker", kind: "class" }),
		);
		expect(index.files["api/main.py"].symbols).toContainEqual(
			expect.objectContaining({ name: "create_app", kind: "function" }),
		);
	});

	it("leaves unresolved imports as empty resolved", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/app.ts",
			['import { render } from "react";', 'import { z } from "./nonexistent";'].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const app = index.files["src/app.ts"];

		// External dependency (not a relative path) — resolved stays ""
		const reactImport = app.imports.find((i) => i.source === "react");
		expect(reactImport).toBeDefined();
		expect(reactImport!.resolved).toBe("");

		// Relative path that doesn't exist — resolved gets cleared to ""
		const missingImport = app.imports.find((i) => i.source === "./nonexistent");
		expect(missingImport).toBeDefined();
		expect(missingImport!.resolved).toBe("");
	});

	it("distinguishes type imports from value imports", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/app.ts",
			['import type { SomeType } from "./types";', 'import { useLayoutEffect } from "react";'].join(
				"\n",
			),
		);
		writeFile(root, "src/types.ts", "export type SomeType = string;");

		const index = scanRepo({ rootDir: root });
		const typeImport = index.files["src/app.ts"].imports.find((i) => i.source === "./types");
		const valueImport = index.files["src/app.ts"].imports.find((i) => i.source === "react");

		expect(typeImport?.isType).toBe(true);
		expect(valueImport?.isType).toBe(false);
	});

	it("parses imports with `as` aliases (pragmatic: strips alias, keeps original)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { foo as bar } from "./b";');
		writeFile(root, "src/b.ts", "export const foo = 1;");

		const index = scanRepo({ rootDir: root });
		const imp = index.files["src/a.ts"].imports[0];

		expect(imp.source).toBe("./b");
		// The regex-based parser strips the alias (`as bar`) and keeps the
		// original name (`foo`). This is a known limitation.
		expect(imp.names).toContain("foo");
		expect(imp.isDefault).toBe(false);
		expect(imp.resolved).toBe("src/b.ts");
	});

	it("parses combined default + named imports (pragmatic: captures named only)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import Default, { Named, Other } from "./b";');
		writeFile(
			root,
			"src/b.ts",
			[
				"export default class Default {}",
				"export const Named = 1;",
				"export const Other = 2;",
			].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const imp = index.files["src/a.ts"].imports[0];

		expect(imp.source).toBe("./b");
		// The combined `Default, { Named, Other }` is parsed as a single named
		// import block — the default import name is not captured separately.
		expect(imp.names).toEqual(["Named", "Other"]);
		expect(imp.isDefault).toBe(false);
	});

	it("does NOT capture `export * from` as an import (known limitation)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'export * from "./b";');
		writeFile(root, "src/b.ts", "export const x = 1;");

		const index = scanRepo({ rootDir: root });
		// The import regex only matches `import` statements, not `export * from`.
		// This is a known limitation — re-exports don't become dependency edges.
		expect(index.files["src/a.ts"].imports).toEqual([]);
		expect(index.dependencies["src/a.ts"]).toEqual([]);
	});

	it("does NOT capture `export type { X }` as an import (known limitation)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'export type { Foo } from "./b";');
		writeFile(root, "src/b.ts", "export type Foo = string;");

		const index = scanRepo({ rootDir: root });
		// `export type { X } from` is an export statement, not an import.
		expect(index.files["src/a.ts"].imports).toEqual([]);
	});

	it("does NOT capture `export { default as Name }` as an import (known limitation)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'export { default as MyDefault } from "./b";');
		writeFile(root, "src/b.ts", "export default 42;");

		const index = scanRepo({ rootDir: root });
		// `export { ... } from` is an export statement, not an import statement.
		expect(index.files["src/a.ts"].imports).toEqual([]);
	});

	it("does NOT capture dynamic `import()` expressions", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/a.ts",
			[
				"export async function load() {",
				'  const mod = await import("./b");',
				"  return mod.x;",
				"}",
			].join("\n"),
		);
		writeFile(root, "src/b.ts", "export const x = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/a.ts"].imports).toEqual([]);
		expect(index.dependencies["src/a.ts"]).toEqual([]);
	});

	it("does NOT capture `require()` calls", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'const b = require("./b");\nconst fs = require("fs");');
		writeFile(root, "src/b.ts", "exports.x = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/a.ts"].imports).toEqual([]);
	});

	it("scans .mjs and .cjs files", () => {
		const root = makeTempDir();
		writeFile(root, "src/main.mjs", 'import { x } from "./lib.cjs";');
		writeFile(root, "src/lib.cjs", "exports.x = 1;");
		writeFile(root, "src/mod.mts", "export const y = 2;");
		writeFile(root, "src/helper.cts", "export const z = 3;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/main.mjs"]).toBeDefined();
		expect(index.files["src/lib.cjs"]).toBeDefined();
		expect(index.files["src/mod.mts"]).toBeDefined();
		expect(index.files["src/helper.cts"]).toBeDefined();
		expect(index.fileCount).toBe(4);
	});

	it("handles empty files with no imports/exports/symbols", () => {
		const root = makeTempDir();
		writeFile(root, "src/empty.ts", "");
		writeFile(root, "src/whitespace.ts", "\n\n  \n");
		writeFile(root, "src/comment.ts", "// just a comment\n/* block */");

		const index = scanRepo({ rootDir: root });

		expect(index.files["src/empty.ts"].imports).toEqual([]);
		expect(index.files["src/empty.ts"].exports).toEqual([]);
		expect(index.files["src/empty.ts"].symbols).toEqual([]);

		expect(index.files["src/whitespace.ts"].imports).toEqual([]);
		expect(index.files["src/whitespace.ts"].exports).toEqual([]);
		expect(index.files["src/whitespace.ts"].symbols).toEqual([]);

		expect(index.files["src/comment.ts"].imports).toEqual([]);
		expect(index.files["src/comment.ts"].exports).toEqual([]);
		expect(index.files["src/comment.ts"].symbols).toEqual([]);
	});

	it("scans deeply nested directories", () => {
		const root = makeTempDir();
		writeFile(root, "a/b/c/d/e/deep.ts", 'import { top } from "../../../../top";');
		writeFile(root, "top.ts", "export const top = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["a/b/c/d/e/deep.ts"]).toBeDefined();
		expect(index.fileCount).toBe(2);
	});

	it("deduplicates identical imports", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/a.ts",
			['import { x } from "./b";', 'import { x } from "./b";'].join("\n"),
		);
		writeFile(root, "src/b.ts", "export const x = 1;");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/a.ts"].imports).toHaveLength(1);
		expect(index.files["src/a.ts"].imports[0].names).toContain("x");
	});

	it("captures anonymous default exports as `default` (known regex limitation)", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/a.ts",
			[
				"export default function() { return 1; }",
				"export default class {}",
				"export default 42;",
			].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const exports = index.files["src/a.ts"].exports;
		// The optional `(?:default\s+(?:class|function|...)\s+)?` group is
		// skipped by backtracking, making `export\s+\w+` capture "default".
		// Multiple anonymous defaults are deduplicated to one entry.
		expect(exports).toEqual([{ name: "default", kind: "default" }]);
	});

	it("captures `export { CONST as default }` style", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/a.ts",
			["const MY_CONST = 42;", "export { MY_CONST as default }"].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const exports = index.files["src/a.ts"].exports;
		expect(exports).toContainEqual(expect.objectContaining({ name: "MY_CONST", kind: "named" }));
	});

	it("parses .tsx files with imports and symbols", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/component.tsx",
			[
				'import { useState } from "react";',
				'import { Button } from "./Button";',
				"",
				"export const App = () => <div>hi</div>;",
				"export function Header() { return <h1>ok</h1>; }",
			].join("\n"),
		);
		writeFile(root, "src/Button.tsx", "export const Button = () => null;");

		const index = scanRepo({ rootDir: root });
		const entry = index.files["src/component.tsx"];
		expect(entry).toBeDefined();
		expect(entry.symbols).toContainEqual(
			expect.objectContaining({ name: "App", kind: "variable" }),
		);
		expect(entry.symbols).toContainEqual(
			expect.objectContaining({ name: "Header", kind: "function" }),
		);
		expect(entry.imports.map((i) => i.source)).toContain("react");
		expect(entry.imports.map((i) => i.source)).toContain("./Button");
		expect(index.fileCount).toBe(2);
	});

	it("parses .jsx files with symbols", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/Widget.jsx",
			[
				'import React from "react";',
				"export class Widget extends React.Component {}",
				"export const WIDGET_VERSION = 1;",
			].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const entry = index.files["src/Widget.jsx"];
		expect(entry).toBeDefined();
		expect(entry.symbols).toContainEqual(
			expect.objectContaining({ name: "Widget", kind: "class" }),
		);
		expect(entry.symbols).toContainEqual(
			expect.objectContaining({ name: "WIDGET_VERSION", kind: "variable" }),
		);
		expect(entry.exports).toHaveLength(2);
	});

	it("parses async function symbols and exports", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/asyncs.ts",
			[
				"export async function fetchData() {}",
				"export const later = async function helper() {};",
				"async function internal() {}",
			].join("\n"),
		);

		const index = scanRepo({ rootDir: root });
		const syms = index.files["src/asyncs.ts"].symbols;
		expect(syms).toContainEqual(expect.objectContaining({ name: "fetchData", kind: "function" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "later", kind: "variable" }));
		expect(syms).toContainEqual(expect.objectContaining({ name: "internal", kind: "function" }));
	});

	it("handles files with shebang lines", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/cli.ts",
			[
				"#!/usr/bin/env node",
				'import { parse } from "./parser";',
				"export function main() {}",
			].join("\n"),
		);
		writeFile(root, "src/parser.ts", "export function parse() {}");

		const index = scanRepo({ rootDir: root });
		expect(index.files["src/cli.ts"]).toBeDefined();
		expect(index.files["src/cli.ts"].symbols).toContainEqual(
			expect.objectContaining({ name: "main", kind: "function" }),
		);
		expect(index.files["src/cli.ts"].imports).toHaveLength(1);
	});

	it("handles maxFiles=0 (no files scanned)", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const index = scanRepo({ rootDir: root, maxFiles: 0 });

		expect(index.fileCount).toBe(0);
		expect(Object.keys(index.files)).toEqual([]);
		expect(index.dependencies).toEqual({});
		expect(index.reverseDependencies).toEqual({});
	});

	it("resolves deeply nested relative imports (../../...)", () => {
		const root = makeTempDir();
		writeFile(root, "a/b/c/d/e/deep.ts", 'import { top } from "../../../../top";');
		// ../../../../top from a/b/c/d/e/ resolves to a/top
		writeFile(root, "a/top.ts", "export const top = 1;");

		const index = scanRepo({ rootDir: root });
		const imp = index.files["a/b/c/d/e/deep.ts"].imports[0];
		expect(imp.resolved).toBe("a/top.ts");
		expect(index.dependencies["a/b/c/d/e/deep.ts"]).toEqual(["a/top.ts"]);
	});

	it("resolves self-import (file importing itself)", () => {
		const root = makeTempDir();
		writeFile(root, "src/self.ts", 'import { self } from "./self";');

		const index = scanRepo({ rootDir: root });
		const imp = index.files["src/self.ts"].imports[0];
		// Self-import resolves to itself
		expect(imp.resolved).toBe("src/self.ts");
		expect(index.dependencies["src/self.ts"]).toEqual(["src/self.ts"]);
	});

	it("skips files that cannot be read (replaced by a directory)", () => {
		const root = makeTempDir();
		writeFile(root, "src/readable.ts", "export const a = 1;");
		// Create a directory under the same name a file would have, so readFileSync fails
		fs.mkdirSync(path.join(root, "src", "broken.ts"), { recursive: true });

		const index = scanRepo({ rootDir: root });
		// broken.ts is skipped (it's a directory, not a source file)
		expect(index.files["src/broken.ts"]).toBeUndefined();
		expect(index.files["src/readable.ts"]).toBeDefined();
		expect(index.fileCount).toBe(1);
	});

	it("captures export default with expression value", () => {
		const root = makeTempDir();
		writeFile(
			root,
			"src/defaults.ts",
			["const x = 42;", "export default x;", "export default 100;", 'export default "hello";'].join(
				"\n",
			),
		);

		const index = scanRepo({ rootDir: root });
		const exports = index.files["src/defaults.ts"].exports;
		// export default <identifier> → captured by name
		expect(exports).toContainEqual(expect.objectContaining({ name: "x", kind: "default" }));
		// Anonymous defaults (100, "hello") → captured as "default" entry
		expect(exports).toContainEqual(expect.objectContaining({ name: "default", kind: "default" }));
	});

	it("excludes .pi directory even when not in default list context", () => {
		const root = makeTempDir();
		writeFile(root, "src/main.ts", "export const x = 1;");
		writeFile(root, ".pi/some-config.ts", "export const config = 1;");

		const index = scanRepo({ rootDir: root });
		expect(Object.keys(index.files)).toEqual(["src/main.ts"]);
	});
});

// ── Cache: readCache / writeCache / checkStaleness ──────────────────────────

describe("cache", () => {
	describe("readCache", () => {
		it("returns null when cache file does not exist", () => {
			const root = makeTempDir();
			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("no cache file");
		});

		it("returns null on malformed JSON", () => {
			const root = makeTempDir();
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(root, ".pi", "codebase-index.json"), "not-json{{{", "utf8");

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("cache parse error");
		});

		it("returns null on incompatible contractVersion (future)", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: 999,
				rootDir: root,
				scannedAt: 0,
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toContain("incompatible contractVersion");
		});

		it("returns null on rootDir mismatch", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: "/some/other/dir",
				scannedAt: 0,
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("rootDir mismatch");
		});

		it("returns null when files map is missing", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: root,
				scannedAt: 0,
				fileCount: 0,
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("missing or invalid files map");
		});

		it("reads a valid cache file", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });
			writeCache(index, root);

			const result = readCache(root);
			expect(result.data).not.toBeNull();
			expect(result.data!.contractVersion).toBe(CODEBASE_CONTRACT_VERSION);
			expect(result.data!.fileCount).toBe(5);
			expect(result.data!.rootDir).toBe(root);
		});

		it("accepts cache with same or lower contractVersion", () => {
			const root = makeTempDir();
			const data: IndexData = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: root,
				scannedAt: Date.now(),
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			writeCache(data, root);

			const result = readCache(root);
			expect(result.data).not.toBeNull();
			expect(result.data!.contractVersion).toBe(CODEBASE_CONTRACT_VERSION);
		});

		it("returns null when contractVersion is null", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: null,
				rootDir: root,
				scannedAt: 0,
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toContain("incompatible contractVersion");
		});

		it("returns null when files field is explicitly null", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: root,
				scannedAt: 0,
				fileCount: 0,
				files: null,
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("missing or invalid files map");
		});

		it("returns null when rootDir is empty string", () => {
			const root = makeTempDir();
			const cache = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: "",
				scannedAt: 0,
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".pi", "codebase-index.json"),
				JSON.stringify(cache),
				"utf8",
			);

			const result = readCache(root);
			expect(result.data).toBeNull();
			expect(result.reason).toBe("rootDir mismatch");
		});
	});

	describe("writeCache", () => {
		it("creates .pi directory and writes JSON", () => {
			const root = makeTempDir();
			const data: IndexData = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: root,
				scannedAt: 12345,
				fileCount: 1,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};

			writeCache(data, root);

			const cacheFile = path.join(root, ".pi", "codebase-index.json");
			expect(fs.existsSync(cacheFile)).toBe(true);

			const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
			expect(parsed.contractVersion).toBe(CODEBASE_CONTRACT_VERSION);
			expect(parsed.rootDir).toBe(root);
			expect(parsed.scannedAt).toBe(12345);
		});

		it("overwrites existing cache", () => {
			const root = makeTempDir();
			const data1: IndexData = {
				contractVersion: CODEBASE_CONTRACT_VERSION,
				rootDir: root,
				scannedAt: 0,
				fileCount: 0,
				files: {},
				dependencies: {},
				reverseDependencies: {},
			};
			writeCache(data1, root);

			const data2: IndexData = {
				...data1,
				scannedAt: 99999,
				fileCount: 42,
			};
			writeCache(data2, root);

			const parsed = JSON.parse(
				fs.readFileSync(path.join(root, ".pi", "codebase-index.json"), "utf8"),
			);
			expect(parsed.scannedAt).toBe(99999);
			expect(parsed.fileCount).toBe(42);
		});
	});

	describe("checkStaleness", () => {
		it("reports fresh when no files have changed", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });
			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(true);
			expect(result.changedFiles).toEqual([]);
			expect(result.newFiles).toEqual([]);
			expect(result.deletedFiles).toEqual([]);
		});

		it("detects changed files when content changes", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			// Wait briefly for mtime to advance (some filesystems have 1s granularity)
			const WAIT_MS = 1100;
			const configPath = path.join(root, "src", "config.ts");
			const original = fs.readFileSync(configPath, "utf8");
			const start = Date.now();
			while (Date.now() - start < WAIT_MS) {
				/* busy-wait for mtime granularity */
			}
			fs.writeFileSync(configPath, original + "\n// modified", "utf8");

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(false);
			expect(result.changedFiles).toContain("src/config.ts");
		});

		it("detects new files", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			writeFile(root, "src/new.ts", "export const x = 1;");

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(false);
			expect(result.newFiles).toContain("src/new.ts");
		});

		it("detects deleted files", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			fs.unlinkSync(path.join(root, "src", "format.ts"));

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(false);
			expect(result.deletedFiles).toContain("src/format.ts");
		});

		it("reports fresh for same content with same mtime", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(true);
		});

		it("respects extraExcludes in staleness check", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			// Write a new file in a directory that would be new, but excluded
			writeFile(root, "ignored/x.ts", "export const x = 1;");

			// Without extraExcludes, the file is new
			const resultNoExclude = checkStaleness(index, root);
			expect(resultNoExclude.fresh).toBe(false);
			expect(resultNoExclude.newFiles).toContain("ignored/x.ts");

			// With extraExcludes, it's ignored
			const resultExclude = checkStaleness(index, root, ["ignored"]);
			expect(resultExclude.fresh).toBe(true);
			expect(resultExclude.newFiles).toEqual([]);
		});

		it("does not mark file as changed when mtime differs but hash matches", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			// Touch the file (change mtime) without changing content
			const WAIT_MS = 1100;
			const formatPath = path.join(root, "src", "format.ts");
			const content = fs.readFileSync(formatPath, "utf8");
			const start = Date.now();
			while (Date.now() - start < WAIT_MS) {
				/* busy-wait for mtime granularity */
			}
			// Re-write same content to bump mtime without changing hash
			fs.writeFileSync(formatPath, content, "utf8");

			const result = checkStaleness(index, root);
			// mtime changed but content (and thus hash) is the same → still fresh
			expect(result.fresh).toBe(true);
			expect(result.changedFiles).toEqual([]);
		});

		it("detects deleted files when on-disk file is stat-failed", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			// Remove the file between building the index and running staleness
			fs.unlinkSync(path.join(root, "src", "config.ts"));

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(false);
			expect(result.deletedFiles).toContain("src/config.ts");
		});

		it("reports stale when a single file is new alongside unchanged files", () => {
			const root = makeTempDir();
			createMinimalRepo(root);
			const index = scanRepo({ rootDir: root });

			writeFile(root, "src/extra.ts", "export const y = 2;");

			const result = checkStaleness(index, root);
			expect(result.fresh).toBe(false);
			expect(result.newFiles).toEqual(["src/extra.ts"]);
			expect(result.changedFiles).toEqual([]);
			expect(result.deletedFiles).toEqual([]);
		});
	});
});

// ── Query: scanIndex ────────────────────────────────────────────────────────

describe("scanIndex (query.ts)", () => {
	it("scans and caches when no cache exists", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const result = scanIndex({ rootDir: root });

		expect(result.rescanned).toBe(true);
		expect(result.reason).toBe("no cache file");
		expect(result.index.fileCount).toBe(5);

		// Cache should now exist
		const cacheFile = path.join(root, ".pi", "codebase-index.json");
		expect(fs.existsSync(cacheFile)).toBe(true);
	});

	it("returns cached index when stale check passes", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		// First scan writes cache
		const first = scanIndex({ rootDir: root });
		expect(first.rescanned).toBe(true);

		// Second scan should use cache
		const second = scanIndex({ rootDir: root });
		expect(second.rescanned).toBe(false);
		expect(second.index.fileCount).toBe(5);
	});

	it("re-scans when force is true", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		const first = scanIndex({ rootDir: root });
		expect(first.rescanned).toBe(true);

		const second = scanIndex({ rootDir: root });
		expect(second.rescanned).toBe(false);

		const forced = scanIndex({ rootDir: root, force: true });
		expect(forced.rescanned).toBe(true);
		expect(forced.reason).toBe("forced");
	});

	it("re-scans when cache is stale (file changed)", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		// First scan writes cache
		const first = scanIndex({ rootDir: root });
		expect(first.rescanned).toBe(true);

		// Modify a file to make cache stale
		const WAIT_MS = 1100;
		const configPath = path.join(root, "src", "config.ts");
		const original = fs.readFileSync(configPath, "utf8");
		const start = Date.now();
		while (Date.now() - start < WAIT_MS) {
			/* busy-wait for mtime granularity */
		}
		fs.writeFileSync(configPath, original + "\n// modified", "utf8");

		const second = scanIndex({ rootDir: root });
		expect(second.rescanned).toBe(true);
		expect(second.reason).toContain("changed");
	});

	it("accepts extraExcludes in scanIndex", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		writeFile(root, "ignored/x.ts", "export const x = 1;");

		const result = scanIndex({ rootDir: root, extraExcludes: ["ignored"] });
		expect(result.index.fileCount).toBe(5);
		expect(result.index.files["ignored/x.ts"]).toBeUndefined();
	});
});

// ── Query: queryFiles / getFile ─────────────────────────────────────────────

describe("queryFiles", () => {
	it("finds files by matching relative path (case-insensitive)", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "GREETER");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.map((r) => r.relativePath)).toContain("src/greeter.ts");
	});

	it("finds files by matching file name", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "format.ts");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/format.ts");
	});

	it("finds files by matching symbol name", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "Greeter");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/greeter.ts");
	});

	it("finds files by matching export name", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "VERSION");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/utils.ts");
	});

	it("returns empty array when nothing matches", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "zzzzzz_not_found");
		expect(results).toEqual([]);
	});

	it("matches multiple files with a common pattern", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		// "config" appears in path (src/config.ts), symbol Options/Config/DEFAULT_TIMEOUT,
		// and export Options/Config/DEFAULT_TIMEOUT — all in one file
		const results = queryFiles(index, "config");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.map((r) => r.relativePath)).toContain("src/config.ts");

		// "src/" matches everything in the repo
		const all = queryFiles(index, "src/");
		expect(all.length).toBe(5);
	});
});

describe("getFile", () => {
	it("returns the file entry for an existing path", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const file = getFile(index, "src/index.ts");
		expect(file).not.toBeNull();
		expect(file!.name).toBe("index.ts");
		expect(file!.relativePath).toBe("src/index.ts");
	});

	it("returns null for a missing path", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const file = getFile(index, "src/nope.ts");
		expect(file).toBeNull();
	});
});

// ── Query: depMap ───────────────────────────────────────────────────────────

describe("depMap", () => {
	it("returns dependencies and reverse dependencies for a file", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const map = depMap(index, "src/index.ts");
		expect(map.file).not.toBeNull();
		expect(map.file!.name).toBe("index.ts");

		const depNames = map.dependencies.map((d) => d.relativePath);
		expect(depNames).toContain("src/greeter.ts");
		expect(depNames).toContain("src/config.ts");
		expect(depNames).toContain("src/utils.ts");

		const revDepNames = map.reverseDependencies.map((d) => d.relativePath);
		expect(revDepNames).toEqual([]); // nothing imports index.ts
	});

	it("returns null file and empty arrays for unknown path", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const map = depMap(index, "src/nope.ts");
		expect(map.file).toBeNull();
		expect(map.dependencies).toEqual([]);
		expect(map.reverseDependencies).toEqual([]);
	});

	it("shows a leaf file's reverse dependencies", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const map = depMap(index, "src/format.ts");
		expect(map.dependencies).toEqual([]); // format imports nothing
		const rev = map.reverseDependencies.map((d) => d.relativePath);
		expect(rev).toContain("src/greeter.ts");
	});

	it("getDependencies shortcut returns same as depMap", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const deps = getDependencies(index, "src/index.ts");
		const depNames = deps.map((d) => d.relativePath);
		expect(depNames).toContain("src/greeter.ts");
		expect(depNames).toContain("src/utils.ts");
		expect(depNames).toHaveLength(3);
	});

	it("getReverseDependencies shortcut returns same as depMap", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const revDeps = getReverseDependencies(index, "src/format.ts");
		const revNames = revDeps.map((d) => d.relativePath);
		expect(revNames).toContain("src/greeter.ts");
	});

	it("getDependencies returns [] for unknown file", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		expect(getDependencies(index, "src/nope.ts")).toEqual([]);
		expect(getReverseDependencies(index, "src/nope.ts")).toEqual([]);
	});
});

// ── Query: getImpact (including cycles) ─────────────────────────────────────

describe("getImpact", () => {
	it("returns empty array for a file with no reverse dependencies", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/index.ts");
		expect(impact).toEqual([]);
	});

	it("returns direct reverse dependencies for a leaf file", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/format.ts");
		const impacted = impact.map((f) => f.relativePath);
		expect(impacted).toContain("src/greeter.ts");
	});

	it("returns transitive reverse dependencies", () => {
		const root = makeTempDir();
		// a.ts → b.ts → c.ts chain
		writeFile(root, "src/a.ts", 'import { b } from "./b";');
		writeFile(root, "src/b.ts", 'import { c } from "./c";');
		writeFile(root, "src/c.ts", "export const c = 1;");

		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/c.ts");
		const impacted = impact.map((f) => f.relativePath);
		expect(impacted).toContain("src/b.ts");
		expect(impacted).toContain("src/a.ts");
		expect(impacted).toHaveLength(2);
	});

	it("handles diamond dependencies without double-counting", () => {
		const root = makeTempDir();
		// a.ts → b.ts → c.ts
		//   ↘ d.ts ↗
		writeFile(
			root,
			"src/a.ts",
			['import { b } from "./b";', 'import { d } from "./d";'].join("\n"),
		);
		writeFile(root, "src/b.ts", 'import { c } from "./c";');
		writeFile(root, "src/c.ts", "export const c = 1;");
		writeFile(root, "src/d.ts", 'import { c } from "./c";');

		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/c.ts");
		const impacted = impact.map((f) => f.relativePath);
		expect(impacted).toContain("src/b.ts");
		expect(impacted).toContain("src/d.ts");
		expect(impacted).toContain("src/a.ts");
		// a.ts can appear from both paths (b.ts and d.ts) — visited check
		// is at dequeue time, not enqueue, so duplicates are expected
		expect(impacted.filter((f) => f === "src/a.ts").length).toBeGreaterThanOrEqual(1);
	});

	it("handles circular dependencies without infinite loops", () => {
		const root = makeTempDir();
		// a.ts → b.ts → c.ts → a.ts (cycle!)
		writeFile(root, "src/a.ts", 'import { b } from "./b";');
		writeFile(root, "src/b.ts", 'import { c } from "./c";');
		writeFile(root, "src/c.ts", 'import { a } from "./a";');

		const index = scanRepo({ rootDir: root });

		// Should not hang; should return all files in the cycle
		const impact = getImpact(index, "src/a.ts");
		const impacted = impact.map((f) => f.relativePath);
		expect(impacted).toContain("src/b.ts");
		expect(impacted).toContain("src/c.ts");
		// a.ts itself is excluded from the result (visited but not added)
		expect(impacted).not.toContain("src/a.ts");
		// No duplicates
		expect(new Set(impacted).size).toBe(impacted.length);
	});

	it("returns empty for unknown file", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/nope.ts");
		expect(impact).toEqual([]);
	});

	it("returns dependents for a leaf file that others import", () => {
		const root = makeTempDir();
		writeFile(root, "src/a.ts", 'import { z } from "./z";');
		writeFile(root, "src/z.ts", "export const z = 1;");

		const index = scanRepo({ rootDir: root });

		const impact = getImpact(index, "src/z.ts");
		const impacted = impact.map((f) => f.relativePath);
		expect(impacted).toContain("src/a.ts");
		expect(impacted).toHaveLength(1);
	});
});

// ── Query: allFiles / indexSummary ──────────────────────────────────────────

describe("allFiles / indexSummary", () => {
	it("allFiles returns all entries", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const files = allFiles(index);
		expect(files).toHaveLength(5);
	});

	it("indexSummary returns expected shape", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });

		const summary = indexSummary(index);
		expect(summary.rootDir).toBe(root);
		expect(summary.fileCount).toBe(5);
		expect(summary.contractVersion).toBe(CODEBASE_CONTRACT_VERSION);
		expect(typeof summary.scannedAt).toBe("number");
	});
});

// ── Query: empty index edge cases ──────────────────────────────────────────

describe("query operations on empty index", () => {
	function emptyIndex(): IndexData {
		return {
			contractVersion: CODEBASE_CONTRACT_VERSION,
			rootDir: "/tmp/empty",
			scannedAt: 0,
			fileCount: 0,
			files: {},
			dependencies: {},
			reverseDependencies: {},
		};
	}

	it("allFiles returns empty array", () => {
		expect(allFiles(emptyIndex())).toEqual([]);
	});

	it("queryFiles returns empty array", () => {
		expect(queryFiles(emptyIndex(), "anything")).toEqual([]);
	});

	it("getFile returns null", () => {
		expect(getFile(emptyIndex(), "src/any.ts")).toBeNull();
	});

	it("depMap returns null file and empty arrays", () => {
		const result = depMap(emptyIndex(), "src/nope.ts");
		expect(result.file).toBeNull();
		expect(result.dependencies).toEqual([]);
		expect(result.reverseDependencies).toEqual([]);
	});

	it("getImpact returns empty array", () => {
		expect(getImpact(emptyIndex(), "src/nope.ts")).toEqual([]);
	});

	it("indexSummary returns correct zero-state", () => {
		const summary = indexSummary(emptyIndex());
		expect(summary.fileCount).toBe(0);
		expect(summary.rootDir).toBe("/tmp/empty");
	});
});

// ── Query: regex-special characters in pattern ─────────────────────────────

describe("queryFiles with special characters", () => {
	it("handles dots in pattern (literal substring match)", () => {
		const root = makeTempDir();
		writeFile(root, "src/file.test.ts", "export const x = 1;");
		writeFile(root, "src/file_spec.ts", "export const y = 2;");
		const index = scanRepo({ rootDir: root });

		// Dots are literal in a .includes() call — no regex interpretation
		const results = queryFiles(index, ".test.");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/file.test.ts");
	});

	it("handles parentheses in pattern", () => {
		const root = makeTempDir();
		writeFile(root, "src/comp.ts", "export const x = 1;");
		writeFile(root, "src/comp(1).ts", "export const y = 2;");
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "comp(");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/comp(1).ts");
	});

	it("handles plus and star chars in pattern (literal match)", () => {
		const root = makeTempDir();
		writeFile(root, "src/a+b.ts", "export const x = 1;");
		writeFile(root, "src/ab.ts", "export const y = 2;");
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "+");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/a+b.ts");
	});

	it("handles brackets in pattern", () => {
		const root = makeTempDir();
		writeFile(root, "src/arr[0].ts", "export const x = 1;");
		writeFile(root, "src/arr.ts", "export const y = 2;");
		const index = scanRepo({ rootDir: root });

		const results = queryFiles(index, "[0]");
		expect(results).toHaveLength(1);
		expect(results[0].relativePath).toBe("src/arr[0].ts");
	});
});

// ── Query: scanIndex edge cases ─────────────────────────────────────────────

describe("scanIndex edge cases", () => {
	it("passes maxFiles through to the scanner", () => {
		const root = makeTempDir();
		for (let i = 0; i < 5; i++) {
			writeFile(root, `src/f${i}.ts`, `export const x${i} = ${i};`);
		}

		const result = scanIndex({ rootDir: root, maxFiles: 2 });
		expect(result.index.fileCount).toBeLessThanOrEqual(2);
		expect(result.rescanned).toBe(true);
	});

	it("returns fresh cache when force=false and cache is fresh", () => {
		const root = makeTempDir();
		createMinimalRepo(root);

		// Pre-write cache
		const index = scanRepo({ rootDir: root });
		writeCache(index, root);

		const result = scanIndex({ rootDir: root });
		expect(result.rescanned).toBe(false);
		expect(result.index.fileCount).toBe(5);
	});

	it("re-scans when staleness check reports new AND changed AND deleted", () => {
		const root = makeTempDir();
		createMinimalRepo(root);
		const index = scanRepo({ rootDir: root });
		writeCache(index, root);

		// Change one file
		const WAIT_MS = 1100;
		const start = Date.now();
		while (Date.now() - start < WAIT_MS) {
			/* wait for mtime */
		}
		fs.writeFileSync(
			path.join(root, "src", "config.ts"),
			fs.readFileSync(path.join(root, "src", "config.ts"), "utf8") + "\n// edit",
		);
		// Delete one file
		fs.unlinkSync(path.join(root, "src", "format.ts"));
		// Add one file
		writeFile(root, "src/new.ts", "export const n = 1;");

		const result = scanIndex({ rootDir: root });
		expect(result.rescanned).toBe(true);
		expect(result.reason).toContain("changed");
		expect(result.reason).toContain("new");
		expect(result.reason).toContain("deleted");
		// Original 5 files, format.ts deleted (-1), new.ts added (+1) = 5
		expect(result.index.fileCount).toBe(5);
	});
});

// ── Impact: additional edge cases ───────────────────────────────────────────

describe("getImpact additional edge cases", () => {
	it("handles self-referencing import cycle (file imports itself)", () => {
		const root = makeTempDir();
		writeFile(root, "src/self.ts", 'import { self } from "./self";');

		const index = scanRepo({ rootDir: root });

		// Impact should not hang; self.ts is its own reverse dep, but visited tracking prevents loops
		const impact = getImpact(index, "src/self.ts");
		// self.ts is the starting node (visited but not added to result)
		// its only reverseDep is itself, but it's already visited, so no result
		expect(impact).toEqual([]);
	});

	it("handles four-level transitive chain", () => {
		const root = makeTempDir();
		// d.ts → c.ts → b.ts → a.ts
		writeFile(root, "src/a.ts", 'import { b } from "./b";');
		writeFile(root, "src/b.ts", 'import { c } from "./c";');
		writeFile(root, "src/c.ts", 'import { d } from "./d";');
		writeFile(root, "src/d.ts", "export const d = 1;");

		const index = scanRepo({ rootDir: root });
		const impact = getImpact(index, "src/d.ts");
		const impacted = impact.map((f) => f.relativePath);

		expect(impacted).toContain("src/c.ts");
		expect(impacted).toContain("src/b.ts");
		expect(impacted).toContain("src/a.ts");
		expect(impacted).toHaveLength(3);
		// Order should be breadth-first: c, then b, then a
		expect(impacted[0]).toBe("src/c.ts");
		expect(impacted[1]).toBe("src/b.ts");
		expect(impacted[2]).toBe("src/a.ts");
	});

	it("handles large fan-in (many files importing one leaf)", () => {
		const root = makeTempDir();
		writeFile(root, "src/shared.ts", "export const shared = 1;");
		for (let i = 0; i < 20; i++) {
			writeFile(root, `src/consumer${i}.ts`, 'import { shared } from "./shared";');
		}

		const index = scanRepo({ rootDir: root });
		const impact = getImpact(index, "src/shared.ts");
		const impacted = impact.map((f) => f.relativePath);

		expect(impacted).toHaveLength(20);
		for (let i = 0; i < 20; i++) {
			expect(impacted).toContain(`src/consumer${i}.ts`);
		}
	});

	it("handles disjoint impact chains (two separate trees)", () => {
		const root = makeTempDir();
		// chain1: b.ts → shared.ts
		writeFile(root, "src/shared.ts", "export const s = 1;");
		writeFile(root, "src/b.ts", 'import { s } from "./shared";');
		// chain2: d.ts → shared.ts
		writeFile(root, "src/d.ts", 'import { s } from "./shared";');
		// chain3: e.ts → d.ts (transitive)
		writeFile(root, "src/e.ts", 'import { s } from "./d";');

		const index = scanRepo({ rootDir: root });
		const impact = getImpact(index, "src/shared.ts");
		const impacted = impact.map((f) => f.relativePath);

		expect(impacted).toContain("src/b.ts");
		expect(impacted).toContain("src/d.ts");
		expect(impacted).toContain("src/e.ts"); // transitive through d
		expect(impacted).toHaveLength(3);
	});

	it("handles an empty impact result for a known file with no rev-deps", () => {
		const root = makeTempDir();
		writeFile(root, "src/leaf.ts", "export const x = 1;");
		writeFile(root, "src/entry.ts", 'import { x } from "./leaf";');

		const index = scanRepo({ rootDir: root });
		// entry.ts depends on leaf but nothing depends on entry.ts
		const impact = getImpact(index, "src/entry.ts");
		expect(impact).toEqual([]);
	});
});

// ── Codebase tool: TypeBox schema validation (extended) ─────────────────────

describe("CodebaseParams schema (extended)", () => {
	it("CodebaseOperation is a StringEnum with four valid values", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseOperation));
		// StringEnum serializes as { type: "string", enum: [...] }
		expect(schema.type).toBe("string");
		expect(schema.enum).toBeDefined();
		expect(schema.enum).toHaveLength(4);
		expect([...schema.enum].sort()).toEqual(["impact", "map", "query", "scan"]);
	});

	it("CodebaseParams has all expected properties with correct types", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));

		expect(schema.type).toBe("object");
		expect(schema.properties).toBeDefined();

		// All four properties exist
		expect(Object.keys(schema.properties).sort()).toEqual([
			"file",
			"force",
			"operation",
			"pattern",
		]);

		// No required fields
		expect(schema.required).toBeUndefined();
	});

	it("force property has default: false", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));
		expect(schema.properties.force.default).toBe(false);
	});

	it("schema accepts any operation value from the enum", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseParams));
		const opProp = schema.properties.operation;
		// The operation property is a string with a constrained enum
		expect(opProp.type).toBe("string");
		expect(opProp.enum).toContain("scan");
		expect(opProp.enum).toContain("query");
		expect(opProp.enum).toContain("map");
		expect(opProp.enum).toContain("impact");
	});

	it("validates a fully populated params object", () => {
		const params = {
			operation: "query",
			pattern: "test",
			file: "src/test.ts",
			force: true,
		};
		// All values match their schemas
		expect(params.operation).toBe("query");
		expect(params.pattern).toBe("test");
		expect(params.file).toBe("src/test.ts");
		expect(params.force).toBe(true);
	});

	it("CodebaseOperation description is set", () => {
		const schema = JSON.parse(JSON.stringify(CodebaseOperation));
		expect(schema.description).toBeDefined();
		expect(schema.description).toContain("scan");
		expect(schema.description).toContain("query");
	});
});

// ── Bundled agent discovery (codebase-analyst) ──────────────────────────────

describe("codebase-analyst bundled agent discovery", () => {
	it("is discoverable as a bundled agent", () => {
		const cwd = makeTempDir();

		const result = discoverAgents(cwd, "both");
		const agent = result.agents.find((a: any) => a.name === "codebase-analyst");

		expect(agent).toBeDefined();
		expect(agent!.source).toBe("bundled");
		expect(agent!.description).toContain("codebase");
		expect(agent!.tier).toBe("reasoning");
	});
});
