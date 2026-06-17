import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// session-meta writes to a fixed path under ~/.pi/agent. We redirect HOME to a
// temp dir, then dynamic-import the module so AGENT_DIR resolves to the temp
// home (paths.ts reads homedir() at module-eval time). Must use a dynamic
// import — a static import would evaluate paths.ts before HOME is set. Node
// caches the module by URL, so AGENT_DIR is fixed after the first import; hence
// a single test that exercises both the empty-shell and merge cases in order.
test("session-meta: empty shell when absent, then non-clobbering per-extension merge", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-suite-meta-"));
	const prevHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const { writeSessionMeta, readSessionMeta } = await import("./session-meta");

		// Absent file → empty shell.
		assert.deepEqual(readSessionMeta(), { extensions: {} });

		writeSessionMeta("todo", "/proj", { total: 3 });
		writeSessionMeta("memory", "/proj", { facts: 5 });
		writeSessionMeta("todo", "/proj", { total: 7 }); // overwrites only todo's own blob

		const meta = readSessionMeta();
		assert.equal(meta.cwd, "/proj");
		assert.equal(meta.extensions?.todo?.total, 7, "todo blob updated in place");
		assert.equal(meta.extensions?.memory?.facts, 5, "memory blob NOT clobbered by todo writes");
		assert.equal(typeof meta.updatedAt, "number");
		assert.equal(typeof meta.cwdHash, "string");
		assert.equal(typeof meta.extensions?.todo?.updatedAt, "number", "per-blob timestamp stamped");
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(home, { recursive: true, force: true });
	}
});
