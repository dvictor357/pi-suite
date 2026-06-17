import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION } from "./contract";

// session-meta writes to a fixed path under ~/.pi/agent. Redirect HOME to a temp
// dir BEFORE the module is imported (paths.ts reads homedir() at module-eval),
// then load it lazily in `before`. Node caches the module by URL, so AGENT_DIR
// is fixed to this home for every test in the file; each test resets the file.
const home = mkdtempSync(join(tmpdir(), "pi-suite-meta-"));
process.env.HOME = home;
const metaPath = join(home, ".pi", "agent", "session-meta.json");

let sm: typeof import("./session-meta");
before(async () => {
	sm = await import("./session-meta");
});
after(() => rmSync(home, { recursive: true, force: true }));

function reset() {
	if (existsSync(metaPath)) rmSync(metaPath);
}

test("readSessionMeta returns an empty shell when the file is absent", () => {
	reset();
	assert.deepEqual(sm.readSessionMeta(), { extensions: {} });
});

test("writeSessionMeta merges per-extension blobs and stamps the contract version", () => {
	reset();
	sm.writeSessionMeta("todo", "/proj", { total: 3 });
	sm.writeSessionMeta("memory", "/proj", { facts: 5 });
	sm.writeSessionMeta("todo", "/proj", { total: 7 }); // overwrites only todo's own blob

	const meta = sm.readSessionMeta();
	assert.equal(meta.cwd, "/proj");
	assert.equal(meta.contractVersion, CONTRACT_VERSION, "write stamps the contract version");
	assert.equal(meta.extensions?.todo?.total, 7, "todo blob updated in place");
	assert.equal(meta.extensions?.memory?.facts, 5, "memory blob NOT clobbered by todo writes");
	assert.equal(typeof meta.extensions?.todo?.updatedAt, "number", "per-blob timestamp stamped");
});

test("readSessionMeta degrades to an empty shell for a future-version file", () => {
	reset();
	writeFileSync(
		metaPath,
		JSON.stringify({ contractVersion: CONTRACT_VERSION + 1, extensions: { quest: { x: 1 } } }),
		"utf8",
	);
	assert.deepEqual(sm.readSessionMeta(), { extensions: {} }, "don't misread a newer shape");
});

test("writeSessionMeta does not clobber a file written by a newer contract", () => {
	reset();
	const future = { contractVersion: CONTRACT_VERSION + 1, extensions: { quest: { sentinel: 42 } } };
	writeFileSync(metaPath, JSON.stringify(future), "utf8");

	sm.writeSessionMeta("todo", "/proj", { total: 1 });

	const onDisk = JSON.parse(readFileSync(metaPath, "utf8"));
	assert.deepEqual(onDisk, future, "newer-contract file left untouched");
});
