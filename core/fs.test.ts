import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJSON, writeJSON, updateJSON, appendLine, setErrorSink } from "./fs";

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

test("updateJSON applies the mutation against current state and persists", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "counter.json");
		writeJSON(p, { n: 1 });
		const result = updateJSON<{ n: number }>(p, (cur) => ({ n: cur.n + 1 }), { n: 0 });
		assert.deepEqual(result, { n: 2 });
		assert.deepEqual(readJSON(p, null), { n: 2 }, "mutation persisted to disk");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateJSON uses fallback (and creates the file) when absent", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "new.json");
		updateJSON<{ items: string[] }>(p, (cur) => ({ items: [...cur.items, "a"] }), { items: [] });
		assert.deepEqual(readJSON(p, null), { items: ["a"] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateJSON does NOT write when the mutator returns the same reference", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "guard.json");
		// File never created — mutator bails by returning its input unchanged.
		updateJSON<{ v: number }>(p, (cur) => cur, { v: 7 });
		const leftovers = readdirSync(dir);
		assert.deepEqual(leftovers, [], "no file written when mutator returns input unchanged");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateJSON merges the LATEST on-disk state, not a stale snapshot", () => {
	const dir = freshDir();
	try {
		const p = join(dir, "shared.json");
		// Two writers: A captures a stale snapshot, B writes in between, then A
		// commits via updateJSON. A's merge must see B's write.
		writeJSON(p, { mine: "a0", foreign: "f0" });
		const staleSnapshot = readJSON<{ mine: string; foreign: string }>(p, { mine: "", foreign: "" });
		writeJSON(p, { mine: "a0", foreign: "f1" }); // foreign writer lands first
		updateJSON<{ mine: string; foreign: string }>(
			p,
			(onDisk) => ({ mine: "a1", foreign: onDisk.foreign }), // keep latest foreign
			staleSnapshot,
		);
		assert.deepEqual(
			readJSON(p, null),
			{ mine: "a1", foreign: "f1" },
			"foreign write not clobbered",
		);
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
