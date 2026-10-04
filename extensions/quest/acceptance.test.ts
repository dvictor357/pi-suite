import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
	acceptancePending,
	addAcceptanceCommands,
	buildCorrectiveStep,
	createAcceptance,
	decideAcceptance,
	parseCommand,
	gatedDuplicate,
	renderAcceptanceRecap,
	sandboxBlockReason,
	type AcceptanceEvidence,
	type QuestAcceptance,
} from "./acceptance";
import { ACCEPTANCE, type AcceptanceConfig } from "./constants";
import type { SandboxPolicy } from "./types";

const cfg: AcceptanceConfig = { ...ACCEPTANCE, enabled: true, maxCorrectiveRounds: 2 };

const ev = (command: string, status: "pass" | "fail", extra: Partial<AcceptanceEvidence> = {}) =>
	({
		command,
		status,
		exitCode: status === "pass" ? 0 : 1,
		summary: "",
		at: 1,
		...extra,
	}) as AcceptanceEvidence;

const accepted = (over: Partial<QuestAcceptance> = {}): QuestAcceptance => ({
	criteria: ["users can reset their password"],
	commands: ["npm test -- reset.test.ts"],
	status: "pending",
	rounds: 0,
	evidence: [],
	...over,
});

describe("parseCommand", () => {
	test("splits plain commands and honours quotes", () => {
		assert.deepEqual(parseCommand("npm test -- reset.test.ts"), {
			file: "npm",
			args: ["test", "--", "reset.test.ts"],
		});
		assert.deepEqual(parseCommand(`node -e 'console.log("a b")'`), {
			file: "node",
			args: ["-e", `console.log("a b")`],
		});
		assert.deepEqual(parseCommand(`grep -q "a \\"b\\" c" file.txt`), {
			file: "grep",
			args: ["-q", `a "b" c`, "file.txt"],
		});
		assert.deepEqual(parseCommand(`echo ""`), { file: "echo", args: [""] });
	});

	test("shell metacharacters are fine inside quotes", () => {
		assert.deepEqual(parseCommand(`grep -E 'a|b;c' f`), {
			file: "grep",
			args: ["-E", "a|b;c", "f"],
		});
	});

	test("rejects shell syntax it can't run without a shell", () => {
		for (const bad of [
			"npm test | tail",
			"npm test && npm run lint",
			"npm test; echo done",
			"npm test > out.txt",
			"echo $(whoami)",
			"echo `whoami`",
			`echo "$(whoami)"`,
			"npm test\nrm -rf x",
			"CI=1 npm test",
			"npm test 'unterminated",
			"   ",
		]) {
			assert.ok("error" in parseCommand(bad), bad);
		}
	});
});

describe("createAcceptance", () => {
	test("complex quests must declare criteria; light tiers may skip", () => {
		const r = createAcceptance(undefined, "complex", undefined, cfg);
		assert.ok("error" in r && /complex quest needs acceptance/.test(r.error));
		assert.deepEqual(createAcceptance(undefined, "simple", undefined, cfg), {});
		assert.deepEqual(createAcceptance({ criteria: [" "] }, "medium", undefined, cfg), {});
		assert.deepEqual(
			createAcceptance(undefined, "complex", undefined, { ...cfg, enabled: false }),
			{},
		);
	});

	test("builds a pending acceptance with trimmed, deduped lists", () => {
		const r = createAcceptance(
			{ criteria: [" works ", "works"], commands: ["npm test", "npm test "] },
			"complex",
			undefined,
			cfg,
		);
		assert.ok("acceptance" in r);
		assert.deepEqual(r.acceptance, {
			criteria: ["works"],
			commands: ["npm test"],
			status: "pending",
			rounds: 0,
			evidence: [],
		});
	});

	test("rejects commands without criteria, shell syntax, and too many commands", () => {
		assert.ok("error" in createAcceptance({ commands: ["npm test"] }, "simple", undefined, cfg));
		const shell = createAcceptance(
			{ criteria: ["x"], commands: ["a && b"] },
			"simple",
			undefined,
			cfg,
		);
		assert.ok("error" in shell && /without a shell/.test(shell.error));
		const many = createAcceptance(
			{ criteria: ["x"], commands: ["a", "b", "c"] },
			"simple",
			undefined,
			{
				...cfg,
				maxCommands: 2,
			},
		);
		assert.ok("error" in many && /At most 2/.test(many.error));
	});
});

describe("sandboxed quests", () => {
	const sandbox: SandboxPolicy = {
		mode: "restricted",
		allowedPaths: ["**"],
		deniedPaths: [],
		allowCommands: ["npm test"],
		denyCommands: [],
		allowNetwork: false,
		allowPackageInstall: false,
		worktree: null,
	};

	test("commands the sandbox would block are rejected at declaration", () => {
		assert.equal(sandboxBlockReason("npm test -- a.test.ts", sandbox), null);
		assert.equal(sandboxBlockReason("curl http://x", undefined), null, "no sandbox, no guard");
		assert.ok(sandboxBlockReason("curl http://x", sandbox));
		const r = createAcceptance(
			{ criteria: ["x"], commands: ["curl http://x"] },
			"simple",
			{ sandbox },
			cfg,
		);
		assert.ok("error" in r && /blocked by the quest sandbox/.test(r.error));
		const grow = addAcceptanceCommands(accepted(), ["rm -rf src"], { sandbox }, cfg);
		assert.ok("error" in grow && /blocked by the quest sandbox/.test(grow.error));
	});
});

describe("commands the step gate already runs", () => {
	const gatedCommands = [
		"npm run typecheck",
		"npm run lint",
		"npm run test",
		"npm run format:check",
	];

	test("repo-wide checks are rejected, whatever the shorthand", () => {
		for (const [command, gated] of [
			["npm test", "npm run test"],
			["npm t", "npm run test"],
			["npm run test", "npm run test"],
			["npm  run   typecheck", "npm run typecheck"],
			["npm run lint", "npm run lint"],
		]) {
			assert.equal(gatedDuplicate(command, gatedCommands), gated, command);
		}
		assert.equal(gatedDuplicate("yarn test", ["yarn run test"]), "yarn run test");
		assert.equal(gatedDuplicate("pnpm typecheck", ["pnpm run typecheck"]), "pnpm run typecheck");
	});

	test("targeted commands are allowed", () => {
		for (const command of [
			"npm test -- src/reset.test.ts",
			"npm run test -- extensions/quest/usage.test.ts",
			"npx vitest run src/a.test.ts",
			"npm run e2e",
			"npm typecheck", // not an npm alias: npm would reject it, so it isn't the gated check
		]) {
			assert.equal(gatedDuplicate(command, gatedCommands), null, command);
		}
		assert.equal(gatedDuplicate("npm test", undefined), null, "no gate known");
	});

	test("declaring or appending one fails with a pointer to targeted commands", () => {
		const r = createAcceptance(
			{ criteria: ["x"], commands: ["npm run typecheck", "npm test"] },
			"medium",
			{ gatedCommands },
			cfg,
		);
		assert.ok("error" in r);
		assert.match(r.error, /repeats `npm run typecheck`, which quest already runs after every step/);
		assert.match(r.error, /targeted command/);
		const grow = addAcceptanceCommands(accepted(), ["npm test"], { gatedCommands }, cfg);
		assert.ok("error" in grow && /repeats `npm run test`/.test(grow.error));
		const ok = addAcceptanceCommands(accepted(), ["npm test -- a.test.ts"], { gatedCommands }, cfg);
		assert.ok("acceptance" in ok);
	});
});

describe("addAcceptanceCommands", () => {
	test("appends new commands, skips known ones, and reopens a passing gate", () => {
		const r = addAcceptanceCommands(
			accepted({ status: "passing" }),
			["npm test -- reset.test.ts", "npm run e2e"],
			undefined,
			cfg,
		);
		assert.ok("acceptance" in r);
		assert.deepEqual(r.added, ["npm run e2e"]);
		assert.deepEqual(r.acceptance.commands, ["npm test -- reset.test.ts", "npm run e2e"]);
		assert.equal(r.acceptance.status, "pending");
	});

	test("nothing new leaves the acceptance untouched", () => {
		const a = accepted({ status: "passing" });
		const r = addAcceptanceCommands(a, ["npm test -- reset.test.ts"], undefined, cfg);
		assert.ok("acceptance" in r);
		assert.equal(r.acceptance, a);
	});

	test("existing commands count toward the cap", () => {
		const r = addAcceptanceCommands(accepted(), ["b"], undefined, { ...cfg, maxCommands: 1 });
		assert.ok("error" in r);
	});
});

describe("acceptancePending", () => {
	test("only quests with an unmet acceptance are gated", () => {
		assert.equal(acceptancePending({}, cfg), false, "legacy quest completes as before");
		assert.equal(acceptancePending({ acceptance: accepted() }, cfg), true);
		assert.equal(acceptancePending({ acceptance: accepted({ status: "failed" }) }, cfg), true);
		assert.equal(acceptancePending({ acceptance: accepted({ status: "passing" }) }, cfg), false);
		assert.equal(acceptancePending({ acceptance: accepted() }, { ...cfg, enabled: false }), false);
	});
});

describe("decideAcceptance", () => {
	test("all passing, or nothing to run, passes", () => {
		assert.deepEqual(decideAcceptance([ev("a", "pass")], 0, cfg), { kind: "pass" });
		assert.deepEqual(decideAcceptance([], 0, cfg), { kind: "pass" });
	});

	test("a failure with rounds left asks for one corrective round", () => {
		const d = decideAcceptance([ev("a", "pass"), ev("b", "fail")], 1, cfg);
		assert.equal(d.kind, "corrective");
		assert.ok(d.kind === "corrective");
		assert.equal(d.round, 2);
		assert.deepEqual(
			d.failures.map((f) => f.command),
			["b"],
		);
	});

	test("out of rounds pauses with the failing commands", () => {
		const d = decideAcceptance([ev("b", "fail")], 2, cfg);
		assert.ok(d.kind === "pause");
		assert.match(d.reason, /after 2 corrective round/);
		assert.match(d.reason, /b/);
	});
});

describe("buildCorrectiveStep", () => {
	test("targets the failing commands with their output and the criteria", () => {
		const step = buildCorrectiveStep(
			[ev("npm test -- reset.test.ts", "fail", { exitCode: 1, summary: "expected 200, got 404" })],
			1,
			["users can reset their password"],
		);
		assert.equal(step.content, "Fix acceptance: npm test -- reset.test.ts");
		assert.equal(step.agent, "worker");
		assert.match(step.context, /round 1/);
		assert.match(step.context, /expected 200, got 404/);
		assert.match(step.context, /without weakening/);
		assert.match(step.context, /- users can reset their password/);
	});
});

describe("renderAcceptanceRecap", () => {
	test("legacy quests render nothing", () => {
		assert.deepEqual(renderAcceptanceRecap(undefined), []);
	});

	test("shows criteria, per-command evidence, and the result", () => {
		const text = renderAcceptanceRecap(
			accepted({
				commands: ["npm test -- reset.test.ts", "npm run e2e"],
				status: "passing",
				rounds: 1,
				evidence: [
					ev("npm test -- reset.test.ts", "pass", { redAtBaseline: true }),
					ev("npm run e2e", "pass"),
				],
			}),
		).join("\n");
		assert.match(text, /### Acceptance/);
		assert.match(text, /- users can reset their password/);
		assert.match(text, /`npm test -- reset.test.ts` — pass \(red at baseline → green\)/);
		assert.match(text, /`npm run e2e` — pass$/m);
		assert.match(text, /Result:\*\* ✅ passing after 1 corrective round/);
	});

	test("flags criteria that no command verified", () => {
		const text = renderAcceptanceRecap(accepted({ commands: [] })).join("\n");
		assert.match(text, /not machine-verified/);
	});
});
