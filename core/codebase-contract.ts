/** Increment when the cache schema changes in a breaking way. */
export const CODEBASE_CONTRACT_VERSION = 1;

export interface SymbolEntry {
	name: string;
	kind: "function" | "class" | "variable" | "type" | "interface" | "enum" | "other";
}

export interface ImportEntry {
	/** Module specifier or relative path */
	source: string;
	names: string[];
	isDefault: boolean;
	isType: boolean;
	/** If resolved, the relative path of the resolved file (empty if unresolved or external) */
	resolved: string;
}

export interface ExportEntry {
	name: string;
	kind: "default" | "named" | "type";
}

export interface FileEntry {
	/** Absolute path */
	path: string;
	/** basename */
	name: string;
	/** Repo-relative path (stripped root) */
	relativePath: string;
	/** Import statements found */
	imports: ImportEntry[];
	/** Export statements found */
	exports: ExportEntry[];
	/** Top-level symbols defined */
	symbols: SymbolEntry[];
	/** mtime at scan time (epoch ms) */
	mtime: number;
	/** Quick content hash (SHA-256 of first 16 KiB, for staleness) */
	hash: string;
}

export interface IndexData {
	contractVersion: number;
	rootDir: string;
	scannedAt: number;
	fileCount: number;
	/** Keyed by relative path */
	files: Record<string, FileEntry>;
	/** Dependency map: relativePath → relativePaths it imports */
	dependencies: Record<string, string[]>;
	/** Reverse dependency map: relativePath → relativePaths that import it */
	reverseDependencies: Record<string, string[]>;
}

export const CODEBASE_CACHE_PATH = ".pi/codebase-index.json";

/** Cache written by subagent and read by Quest; tolerate legacy partial entries. */
export const SUPPORTED_CODEBASE_CONTRACT_VERSION = CODEBASE_CONTRACT_VERSION;

/** Quest accepts legacy partial entries while the scanner writes complete entries. */
export type CodebaseImportEntry = Partial<ImportEntry>;
export type CodebaseExportEntry = Partial<Omit<ExportEntry, "kind">> & { kind?: string };
export type CodebaseSymbolEntry = Partial<Omit<SymbolEntry, "kind">> & { kind?: string };
export type CodebaseFileEntry = Partial<Omit<FileEntry, "imports" | "exports" | "symbols">> & {
	relativePath: string;
	imports?: CodebaseImportEntry[];
	exports?: CodebaseExportEntry[];
	symbols?: CodebaseSymbolEntry[];
};
export type CodebaseIndexV1 = Omit<IndexData, "contractVersion" | "files"> & {
	contractVersion: typeof CODEBASE_CONTRACT_VERSION;
	files: Record<string, CodebaseFileEntry>;
};
