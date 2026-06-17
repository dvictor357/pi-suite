import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJSON, writeJSON, appendLine, setErrorSink } from "./fs";

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-suite-fs-"));
}

afterEach(() => {
	// Restore the default no-op sink between tests that install a capturing one.
	setErrorSink(() => {});
});

test("writeJSON then readJSON round-trips", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "data.json");
		const value = { a: 1, b: ["x", "y"], nested: { ok: true } };
		writeJSON(p, value);
		assert.deepEqual(readJSON(p, null), value);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeJSON creates missing parent directories", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "deep", "nested", "data.json");
		writeJSON(p, { ok: 1 });
		assert.deepEqual(readJSON(p, null), { ok: 1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeJSON leaves no leftover .tmp files on success (atomic rename)", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "data.json");
		writeJSON(p, { ok: 1 });
		const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
		assert.deepEqual(leftovers, [], "atomic write should not leave .tmp files behind");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readJSON returns fallback for a missing file", () => {
	const dir = freshDir();
	try {
		const fallback = { default: true };
		assert.deepEqual(readJSON(join(dir, "nope.json"), fallback), fallback);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readJSON returns fallback and reports via error sink for corrupt JSON", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "corrupt.json");
		writeFileSync(p, "{ not valid json ", "utf8");
		const errors: string[] = [];
		setErrorSink((ctx) => errors.push(ctx));
		assert.deepEqual(readJSON(p, { fallback: true }), { fallback: true });
		assert.equal(errors.length, 1, "corrupt read should hit the error sink once");
		assert.match(errors[0], /readJSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appendLine appends newline-terminated lines, creating dirs", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "logs", "out.log");
		appendLine(p, "first");
		appendLine(p, "second\n"); // already terminated — must not double up
		assert.deepEqual(readJSONRaw(p), ["first", "second"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Read a newline-delimited file into non-empty lines.
function readJSONRaw(p: string): string[] {
	return readFileSync(p, "utf8").split("\n").filter(Boolean);
}
