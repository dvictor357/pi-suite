import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	allFiles,
	depMap,
	getImpact,
	indexSummary,
	queryFiles,
	scanIndex,
} from "./codebase/query.js";
import type { IndexData } from "./codebase/types.js";
import { CodebaseParams } from "./schema.js";

export function registerCodebaseTool(pi: ExtensionAPI): void {
	// ── Codebase tool ──────────────────────────────────────────────────────────

	interface CodebaseDetails {
		operation: string;
		rootDir: string;
		rescanned: boolean;
		indexSummary: ReturnType<typeof indexSummary>;
		results: Array<{
			relativePath: string;
			name: string;
			symbols: string[];
			exports: string[];
			imports?: string[];
			dependencies?: string[];
			reverseDependencies?: string[];
			impact?: string[];
		}>;
		resultCount: number;
		error?: string;
	}

	type Ctx = { cwd: string; hasUI: boolean };

	function getIndex(
		ctx: Ctx,
		force: boolean,
	): { index: IndexData; rescanned: boolean; reason?: string } {
		const result = scanIndex({ rootDir: ctx.cwd, force });
		return {
			index: result.index,
			rescanned: result.rescanned,
			reason: result.reason,
		};
	}

	pi.registerTool({
		name: "codebase",
		label: "Codebase",
		description:
			"Scan, query, and analyze the codebase dependency graph. Operations: scan (refresh index), query (find files by pattern), map (show dependencies + reverse deps for a file), impact (transitive reverse dependency closure). Cached to .pi/codebase-index.json.",
		parameters: CodebaseParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const op = params.operation ?? "query";
			const force = (params.force ?? false) || op === "scan";

			const { index, rescanned, reason } = getIndex(ctx, force);
			const summary = indexSummary(index);

			const details: CodebaseDetails = {
				operation: op,
				rootDir: index.rootDir,
				rescanned,
				indexSummary: summary,
				results: [],
				resultCount: 0,
			};

			const buildLine = (): string => {
				if (rescanned && reason) {
					return `(re-scanned: ${reason})`;
				}
				return `(cached · ${summary.fileCount} files · ${new Date(summary.scannedAt).toISOString().replace("T", " ").slice(0, 19)})`;
			};

			switch (op) {
				case "scan": {
					details.results = allFiles(index).map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					details.resultCount = details.results.length;
					return {
						content: [
							{
								type: "text" as const,
								text: `Indexed ${summary.fileCount} files. ${buildLine()}`,
							},
						],
						details,
					};
				}

				case "query": {
					const pattern = params.pattern?.trim();
					if (!pattern) {
						details.resultCount = -1;
						details.error = "No pattern provided for query operation.";
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const matches = queryFiles(index, pattern);
					details.resultCount = matches.length;
					details.results = matches.map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					if (matches.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No files matching "${pattern}" in ${summary.fileCount} indexed files. ${buildLine()}`,
								},
							],
							details,
						};
					}
					const lines = matches.map(
						(f) =>
							`${f.relativePath}${f.symbols.length ? ` [${f.symbols.map((s) => s.name).join(", ")}]` : ""}`,
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `${matches.length} files matching "${pattern}":\n${lines.join("\n")}`,
							},
						],
						details,
					};
				}

				case "map": {
					const file = params.file?.trim();
					if (!file) {
						details.error = "No file path provided for map operation.";
						details.resultCount = -1;
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const map = depMap(index, file);
					if (!map.file) {
						return {
							content: [
								{
									type: "text" as const,
									text: `File "${file}" not found in index. ${buildLine()}`,
								},
							],
							details,
						};
					}
					const result: CodebaseDetails["results"][0] = {
						relativePath: map.file.relativePath,
						name: map.file.name,
						symbols: map.file.symbols.map((s) => s.name),
						exports: map.file.exports.map((e) => e.name),
						imports: map.file.imports.map((i) => i.source),
						dependencies: map.dependencies.map((d) => d.relativePath),
						reverseDependencies: map.reverseDependencies.map((d) => d.relativePath),
					};
					details.results = [result];
					details.resultCount = 1;
					const deps =
						map.dependencies.length > 0
							? `\nDependencies (${map.dependencies.length}):\n${map.dependencies.map((d) => `  ${d.relativePath}`).join("\n")}`
							: "\nDependencies: none";
					const rev =
						map.reverseDependencies.length > 0
							? `\nReverse dependencies (${map.reverseDependencies.length}):\n${map.reverseDependencies.map((d) => `  ${d.relativePath}`).join("\n")}`
							: "\nReverse dependencies: none";
					return {
						content: [
							{
								type: "text" as const,
								text: `${map.file.relativePath}${deps}${rev}\n${buildLine()}`,
							},
						],
						details,
					};
				}

				case "impact": {
					const file = params.file?.trim();
					if (!file) {
						details.error = "No file path provided for impact operation.";
						details.resultCount = -1;
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${details.error}`,
								},
							],
							details,
							isError: true,
						};
					}
					const impact = getImpact(index, file);
					details.resultCount = impact.length;
					details.results = impact.map((f) => ({
						relativePath: f.relativePath,
						name: f.name,
						symbols: f.symbols.map((s) => s.name),
						exports: f.exports.map((e) => e.name),
					}));
					if (impact.length === 0) {
						// Check if the file itself exists
						const exists = index.files[file];
						if (!exists) {
							return {
								content: [
									{
										type: "text" as const,
										text: `File "${file}" not found in index. ${buildLine()}`,
									},
								],
								details,
							};
						}
						return {
							content: [
								{
									type: "text" as const,
									text: `No files depend on "${file}". ${buildLine()}`,
								},
							],
							details,
						};
					}
					const lines = impact.map((f) => f.relativePath);
					return {
						content: [
							{
								type: "text" as const,
								text: `${impact.length} file${impact.length > 1 ? "s" : ""} impacted by "${file}":\n${lines.join("\n")}\n${buildLine()}`,
							},
						],
						details,
					};
				}

				default:
					return {
						content: [
							{
								type: "text" as const,
								text: `Unknown operation: ${op}`,
							},
						],
						details,
					};
			}
		},

		renderCall(args, theme, _context) {
			const op = args.operation ?? "query";
			const force = args.force ?? false;
			let sub = "";
			if (op === "query" && args.pattern) {
				sub = theme.fg("dim", ` "${args.pattern}"`);
			} else if ((op === "map" || op === "impact") && args.file) {
				sub = theme.fg("dim", ` ${args.file}`);
			}
			let text = theme.fg("toolTitle", theme.bold("codebase ")) + theme.fg("accent", op) + sub;
			if (force) text += theme.fg("warning", " --force");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as CodebaseDetails | undefined;

			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const summary = details.indexSummary;
			const cacheLine = ` (${summary.fileCount} files · ${new Date(summary.scannedAt).toISOString().replace("T", " ").slice(0, 19)})`;

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (!expanded) {
				const icon = theme.fg("success", "✓");
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("codebase "))}${theme.fg("accent", details.operation)}`;
				text += ` ${theme.fg("dim", `${details.resultCount} result${details.resultCount !== 1 ? "s" : ""}`)}`;
				text += `\n${theme.fg("muted", cacheLine)}`;
				if (details.results.length > 0) {
					const show = details.results.slice(0, 5);
					for (const r of show) {
						const syms =
							r.symbols.length > 0
								? ` [${r.symbols.slice(0, 3).join(", ")}${r.symbols.length > 3 ? ", …" : ""}]`
								: "";
						text += `\n  ${theme.fg("accent", r.relativePath)}${theme.fg("muted", syms)}`;
					}
					if (details.results.length > 5) {
						text += `\n  ${theme.fg("muted", `… +${details.results.length - 5} more`)}`;
					}
				}
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Expanded view
			const container = new Container();
			let header =
				theme.fg("success", "✓ ") +
				theme.fg("toolTitle", theme.bold("codebase ")) +
				theme.fg("accent", details.operation);
			if (details.rescanned) {
				header += theme.fg("warning", " (re-scanned)");
			}
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("dim", `Root: ${details.rootDir}`), 0, 0));
			container.addChild(new Text(theme.fg("muted", cacheLine), 0, 0));
			container.addChild(new Spacer(1));

			if (details.operation === "scan") {
				const top = details.results.slice(0, 20);
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							`─── Indexed ${details.resultCount} files${details.resultCount > 20 ? ` (showing first 20)` : ""} ───`,
						),
						0,
						0,
					),
				);
				for (const r of top) {
					container.addChild(new Text(`  ${r.relativePath}`, 0, 0));
				}
				return container;
			}

			for (const r of details.results) {
				container.addChild(
					new Text(theme.fg("muted", "─── ") + theme.fg("accent", r.relativePath), 0, 0),
				);
				if (r.symbols.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "symbols:")} ${r.symbols.join(", ")}`, 0, 0),
					);
				}
				if (r.exports.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "exports:")} ${r.exports.join(", ")}`, 0, 0),
					);
				}
				if (r.imports && r.imports.length > 0) {
					container.addChild(
						new Text(`  ${theme.fg("dim", "imports:")} ${r.imports.join(", ")}`, 0, 0),
					);
				}
				if (r.dependencies && r.dependencies.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", `  Dependencies (${r.dependencies.length}):`), 0, 0),
					);
					for (const d of r.dependencies.slice(0, 10)) {
						container.addChild(new Text(`    ${d}`, 0, 0));
					}
					if (r.dependencies.length > 10) {
						container.addChild(
							new Text(theme.fg("muted", `    … +${r.dependencies.length - 10} more`), 0, 0),
						);
					}
				}
				if (r.reverseDependencies && r.reverseDependencies.length > 0) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", `  Reverse deps (${r.reverseDependencies.length}):`), 0, 0),
					);
					for (const d of r.reverseDependencies.slice(0, 10)) {
						container.addChild(new Text(`    ${d}`, 0, 0));
					}
					if (r.reverseDependencies.length > 10) {
						container.addChild(
							new Text(theme.fg("muted", `    … +${r.reverseDependencies.length - 10} more`), 0, 0),
						);
					}
				}
				container.addChild(new Spacer(1));
			}

			return container;
		},
	});
}
