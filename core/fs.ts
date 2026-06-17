import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Optional sink for I/O errors. Extensions can install a logger (e.g. one that
 * appends to their own error log) without core taking a hard dependency on any
 * logging implementation. Defaults to a no-op so a missing logger never throws.
 */
let errorSink: (context: string, error: unknown) => void = () => {};

export function setErrorSink(sink: (context: string, error: unknown) => void): void {
	errorSink = sink;
}

/** Read and parse a JSON file, returning `fallback` if it is missing or corrupt. */
export function readJSON<T>(path: string, fallback: T): T {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (e) {
		errorSink(`readJSON(${path})`, e);
	}
	return fallback;
}

/**
 * Serialize `data` as pretty JSON, creating parent directories as needed.
 *
 * Writes to a temp file and atomically `rename`s it into place, so a crash
 * mid-write can never leave a partially-written (corrupt) file that the
 * best-effort readers would silently discard. Best-effort: never throws.
 */
export function writeJSON(path: string, data: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (e) {
		errorSink(`writeJSON(${path})`, e);
	}
}

/**
 * Atomically read-modify-write a JSON file shared by more than one extension.
 *
 * Reads the current value (or `fallback`), applies `mutate`, and writes the
 * result. The read and write are both synchronous with no suspension point
 * between them, so within a single process no other handler can interleave; the
 * write itself is atomic (temp + rename), so a concurrent process can never
 * observe a torn file. Use this instead of a bare `readJSON` + `writeJSON` pair
 * whenever the file is co-owned, so a stale in-memory snapshot can't silently
 * clobber another writer's update.
 *
 * If `mutate` returns the SAME reference it was given, no write happens — a
 * cheap way for a caller to bail out (e.g. "this file is newer than I
 * understand; leave it alone"). Returns the resulting value. Best-effort: never
 * throws (errors go to the error sink).
 *
 * Note: this guards intra-process interleaving and torn writes, not lost
 * updates between two separate OS processes racing on the same file.
 */
export function updateJSON<T>(path: string, mutate: (current: T) => T, fallback: T): T {
	try {
		const current = readJSON<T>(path, fallback);
		const next = mutate(current);
		if (next !== current) writeJSON(path, next);
		return next;
	} catch (e) {
		errorSink(`updateJSON(${path})`, e);
		return fallback;
	}
}

/** Append a single line to a file, creating parent directories as needed. Best-effort. */
export function appendLine(path: string, line: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
	} catch {
		/* best-effort telemetry — never throw from a log write */
	}
}
