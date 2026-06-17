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

/** Append a single line to a file, creating parent directories as needed. Best-effort. */
export function appendLine(path: string, line: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
	} catch {
		/* best-effort telemetry — never throw from a log write */
	}
}
