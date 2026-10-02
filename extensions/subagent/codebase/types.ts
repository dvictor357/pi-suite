export { CODEBASE_CONTRACT_VERSION } from "../../../core";
export type { SymbolEntry, ImportEntry, ExportEntry, FileEntry, IndexData } from "../../../core";
export const DEFAULT_MAX_FILES = 50_000;

/** Options for scanIndex. */
export interface ScanOptions {
	/** Repo root (default: cwd). */
	rootDir?: string;
	/** Extra glob patterns to exclude (added to defaults). */
	extraExcludes?: string[];
	/** Skip staleness check and force a re-scan. */
	force?: boolean;
	/** Safety limit on scanned files. */
	maxFiles?: number;
}

/** Options for query functions. */
export interface QueryOptions {
	rootDir?: string;
}
