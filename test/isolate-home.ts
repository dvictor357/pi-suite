/**
 * Test preload: redirect HOME to a throwaway dir before any module is imported.
 *
 * `core/paths.ts` resolves `AGENT_DIR` from `homedir()` at module-eval, so any
 * test that writes quest/eval/todo/memory state would otherwise land in the
 * real `~/.pi/agent` and pollute eval stats used for model routing. Loaded via
 * `node --import` in the test script; the node test runner forwards execArgv to
 * each per-file child, and children inherit the env, so the whole run shares one
 * temp home. Only the process that created the dir removes it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "PI_SUITE_TEST_HOME";

if (!process.env[KEY]) {
	const home = mkdtempSync(join(tmpdir(), "pi-suite-test-home-"));
	process.env[KEY] = home;
	process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}

process.env.HOME = process.env[KEY];
process.env.USERPROFILE = process.env[KEY];
