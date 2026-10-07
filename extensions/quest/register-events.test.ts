/**
 * R9: Crash-safe agent_end harness.
 *
 * Exercises the catch path that pauses the quest when the auto-pilot body
 * throws mid-handler. Uses the `runBody` seam on {@link handleAgentEnd}.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createQuestRuntime } from "./runtime";
import { clearActiveQuest, emptyQuest, loadQuest, rememberAgentModel, saveQuest } from "./storage";
import { buildFailureBrief } from "./ladder";
import {
	applyAcceptanceCheck,
	handleAgentEnd,
	recoverAgentEndCrash,
	registerEvents,
} from "./register-events";
import type { QuestStep } from "./types";

function makeStep(partial: Partial<QuestStep> = {}): QuestStep {
	return {
		content: "do the thing",
		status: "pending",
		agent: "worker",
		context: "",
		dependencies: [],
		result: null,
		attempts: 0,
		startedAt: null,
		completedAt: null,
		verified: false,
		verifyResult: null,
		verifyRetries: 0,
		commitHash: null,
		branchName: null,
		...partial,
	};
}

function harness(opts: { hasUI?: boolean } = {}) {
	const notifies: Array<{ msg: string; level: string }> = [];
	const steers: string[] = [];
	const pi = {
		sendUserMessage: (text: string) => {
			steers.push(text);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		on: () => {},
	} as unknown as ExtensionAPI;
	const cwd = mkdtempSync(join(tmpdir(), "quest-agent-end-"));
	const ctx = {
		cwd,
		hasUI: opts.hasUI ?? true,
		ui: {
			setStatus: () => {},
			notify: (msg: string, level?: string) => {
				notifies.push({ msg, level: level ?? "info" });
			},
			setWidget: () => {},
			setWorkingIndicator: () => {},
		},
	} as unknown as ExtensionContext;
	const rt = createQuestRuntime(pi);
	return {
		pi,
		rt,
		ctx,
		cwd,
		notifies,
		steers,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function seedActive(h: ReturnType<typeof harness>): ReturnType<typeof emptyQuest> {
	const quest = emptyQuest("Crash Demo", "demo goal");
	quest.status = "active";
	quest.planApproved = true;
	quest.steps = [makeStep({ content: "fragile step", status: "pending" })];
	saveQuest(quest, h.cwd);
	h.rt.setQuest(quest);
	return quest;
}

describe("handleAgentEnd crash recovery (R9)", () => {
	test("simulated throw mid-handler pauses quest with error pauseReason", async () => {
		const h = harness();
		try {
			const quest = seedActive(h);
			const boom = new Error("simulated mid-handler boom");

			// Must not reject — crash path swallows the error.
			await assert.doesNotReject(() =>
				handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx, {
					runBody: () => {
						throw boom;
					},
				}),
			);

			assert.equal(quest.status, "paused");
			assert.match(quest.pauseReason ?? "", /Auto-pilot error:.*simulated mid-handler boom/);
			assert.equal(h.rt.getQuest(h.cwd)?.status, "paused");

			// Persist attempted and durable on disk
			const fromDisk = loadQuest(h.cwd);
			assert.ok(fromDisk);
			assert.equal(fromDisk!.status, "paused");
			assert.match(fromDisk!.pauseReason ?? "", /simulated mid-handler boom/);

			// UI notified
			assert.ok(
				h.notifies.some((n) => n.level === "error" && /simulated mid-handler boom/.test(n.msg)),
			);
		} finally {
			h.cleanup();
		}
	});

	test("async throw mid-handler is also recovered without uncaught rejection", async () => {
		const h = harness({ hasUI: false });
		try {
			const quest = seedActive(h);

			await assert.doesNotReject(() =>
				handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx, {
					runBody: async () => {
						await Promise.resolve();
						throw new Error("async crash");
					},
				}),
			);

			assert.equal(quest.status, "paused");
			assert.match(quest.pauseReason ?? "", /async crash/);
			assert.equal(loadQuest(h.cwd)?.status, "paused");
			// No UI → no notify
			assert.equal(h.notifies.length, 0);
		} finally {
			h.cleanup();
		}
	});

	test("non-Error throw still produces a pauseReason string", async () => {
		const h = harness();
		try {
			const quest = seedActive(h);

			await assert.doesNotReject(() =>
				handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx, {
					runBody: () => {
						throw "stringy failure";
					},
				}),
			);

			assert.equal(quest.status, "paused");
			assert.match(quest.pauseReason ?? "", /Auto-pilot error: stringy failure/);
		} finally {
			h.cleanup();
		}
	});

	test("locked auto-pilot skips body (no throw, no pause)", async () => {
		const h = harness();
		try {
			const quest = seedActive(h);
			h.rt.setAutoPilotLocked(true);
			let ran = false;

			await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx, {
				runBody: () => {
					ran = true;
					throw new Error("should not run");
				},
			});

			assert.equal(ran, false);
			assert.equal(quest.status, "active");
			assert.equal(quest.pauseReason, null);
		} finally {
			h.cleanup();
		}
	});

	test("registerEvents wires agent_end to the crash-safe handler", async () => {
		const h = harness();
		try {
			const quest = seedActive(h);
			type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
			const handlers = new Map<string, Handler>();
			const pi = {
				...h.pi,
				on: (name: string, handler: Handler) => handlers.set(name, handler),
			} as unknown as ExtensionAPI;

			// Re-create runtime bound to the capturing pi
			const rt = createQuestRuntime(pi);
			rt.setQuest(quest);
			registerEvents(pi, rt);

			const agentEnd = handlers.get("agent_end");
			assert.ok(agentEnd, "agent_end handler registered");

			// Locked path: registered handler must not throw / pause.
			rt.setAutoPilotLocked(true);
			await assert.doesNotReject(async () => {
				await agentEnd!({ messages: [] }, h.ctx);
			});
			assert.equal(quest.status, "active");
		} finally {
			h.cleanup();
		}
	});
});

describe("recoverAgentEndCrash", () => {
	test("pauses and persists when a quest is cached", () => {
		const h = harness();
		try {
			const quest = seedActive(h);
			recoverAgentEndCrash(h.rt, h.ctx, new Error("direct recovery"));

			assert.equal(quest.status, "paused");
			assert.match(quest.pauseReason ?? "", /direct recovery/);
			assert.equal(loadQuest(h.cwd)?.status, "paused");
		} finally {
			h.cleanup();
		}
	});

	test("no-ops safely when no quest is loaded", () => {
		const h = harness();
		try {
			assert.doesNotThrow(() => {
				recoverAgentEndCrash(h.rt, h.ctx, new Error("no quest"));
			});
			assert.equal(h.rt.getQuest(h.cwd), null);
			assert.equal(loadQuest(h.cwd), null);
		} finally {
			h.cleanup();
		}
	});
});

describe("sub-agent usage telemetry", () => {
	test("subagent tool result usage lands on the step, then on the eval entry once", async () => {
		const h = harness();
		try {
			const quest = emptyQuest("Usage Demo", "demo goal");
			quest.status = "active";
			quest.planApproved = true;
			quest.lastFiredStepIndex = 0;
			quest.steps = [makeStep({ status: "running", phase: "running", attempts: 1 })];
			saveQuest(quest, h.cwd);

			type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
			const handlers = new Map<string, Handler>();
			const pi = {
				...h.pi,
				on: (name: string, handler: Handler) => handlers.set(name, handler),
			} as unknown as ExtensionAPI;
			const rt = createQuestRuntime(pi);
			rt.setQuest(quest);
			registerEvents(pi, rt);

			const usage = {
				input: 1200,
				output: 300,
				cacheRead: 400,
				cacheWrite: 50,
				cost: 0.0125,
				contextTokens: 1900,
				turns: 3,
			};
			await handlers.get("tool_execution_start")!(
				{ toolCallId: "call-1", toolName: "subagent", args: { agent: "worker", task: "go" } },
				h.ctx,
			);
			await handlers.get("tool_execution_end")!(
				{
					toolCallId: "call-1",
					toolName: "subagent",
					isError: false,
					result: {
						details: { mode: "single", results: [{ usage, thinking: "medium" }] },
					},
				},
				h.ctx,
			);

			assert.equal(quest.steps[0].usage?.input, 1200);
			assert.equal(loadQuest(h.cwd)?.steps[0].usage?.cost, 0.0125, "usage persisted");

			const entry = rt.makeEval(quest, quest.steps[0], 0, "done", true, "ok");
			assert.equal(entry.tokensIn, 1200);
			assert.equal(entry.tokensOut, 300);
			assert.equal(entry.cacheRead, 400);
			assert.equal(entry.cost, 0.0125);
			assert.equal(entry.turns, 3);
			assert.equal(entry.thinking, "medium");
			assert.equal(quest.steps[0].usage, undefined, "usage consumed by makeEval");

			const again = rt.makeEval(quest, quest.steps[0], 0, "done", true, "ok");
			assert.equal(again.tokensIn, 0);
			assert.equal(again.turns, undefined, "no double counting");
		} finally {
			h.cleanup();
		}
	});
});

describe("subagent runtime routing enforcement", () => {
	test("tool_call rewrites a deviating subagent call to the routed model + thinking", async () => {
		const h = harness();
		try {
			const quest = emptyQuest("Routing Demo", "demo goal");
			quest.status = "active";
			quest.planApproved = true;
			quest.lastFiredStepIndex = 0;
			quest.steps = [
				makeStep({
					status: "running",
					phase: "running",
					attempts: 1,
					// One verified quality failure on this (unladdered) step.
					failureBriefs: [
						buildFailureBrief({
							attempt: 1,
							evidence: "wrong behaviour",
							attempted: null,
							inferred: false,
							failureCode: "MODEL_QUALITY",
						}),
					],
				}),
			];
			saveQuest(quest, h.cwd);
			rememberAgentModel(h.cwd, "worker", {
				model: "approved-model",
				thinkingLevel: "low",
				timestamp: 1,
			});

			type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
			const handlers = new Map<string, Handler>();
			const pi = {
				...h.pi,
				on: (name: string, handler: Handler) => handlers.set(name, handler),
			} as unknown as ExtensionAPI;
			const rt = createQuestRuntime(pi);
			rt.setQuest(quest);
			registerEvents(pi, rt);

			const input: Record<string, unknown> = {
				agent: "worker",
				task: "go",
				model: "something-else",
				thinking: "minimal",
			};
			const res = await handlers.get("tool_call")!(
				{ toolCallId: "c1", toolName: "subagent", input },
				h.ctx,
			);

			assert.equal((res as { block?: boolean } | undefined)?.block, undefined);
			assert.equal(input.model, "approved-model");
			// Baseline "low" + one quality failure → "medium".
			assert.equal(input.thinking, "medium");
			assert.ok(
				h.notifies.some((n) =>
					/Quest routing: step #1 model something-else → approved-model/.test(n.msg),
				),
			);
		} finally {
			h.cleanup();
		}
	});
});

describe("auto-pilot dialogs answered after a lifecycle change", () => {
	for (const change of ["pause", "abort", "replace"] as const) {
		test(`a stale "Retry failed steps" answer after ${change} does nothing`, async () => {
			const h = harness();
			try {
				const quest = seedActive(h);
				quest.steps[0] = makeStep({ content: "broken step", status: "failed", phase: "failed" });
				saveQuest(quest, h.cwd);
				const replacement = change === "replace" ? emptyQuest("Replacement", "new goal") : null;
				const ui = h.ctx.ui as unknown as Record<string, unknown>;
				ui.select = async () => {
					// The user changes the quest while the dialog is open.
					if (change === "pause") {
						quest.status = "paused";
						h.rt.persist(h.ctx, quest);
					} else {
						clearActiveQuest(h.cwd);
						if (replacement) saveQuest(replacement, h.cwd);
						h.rt.setQuest(replacement);
					}
					return "Retry failed steps";
				};

				await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx);

				assert.equal(quest.steps[0].status, "failed", "stale answer not applied");
				assert.equal(h.steers.length, 0, "no work dispatched");
				if (change === "pause") {
					assert.equal(quest.status, "paused");
					assert.equal(loadQuest(h.cwd)?.status, "paused");
				} else {
					assert.equal(h.rt.getQuest(h.cwd), replacement, "current quest stays in the cache");
					assert.equal(loadQuest(h.cwd)?.name ?? null, replacement?.name ?? null);
				}
			} finally {
				h.cleanup();
			}
		});
	}
});

describe("quest acceptance gate", () => {
	const flagCheck = (cwd: string) =>
		`${JSON.stringify(process.execPath)} -e 'process.exit(require("fs").existsSync(${JSON.stringify(join(cwd, "flag"))}) ? 0 : 1)'`;

	function seedAccepted(h: ReturnType<typeof harness>, rounds = 0) {
		const quest = emptyQuest("Acceptance Demo", "flag exists");
		quest.status = "active";
		quest.planApproved = true;
		quest.tier = "medium";
		quest.steps = [makeStep({ status: "done", phase: "done", completedAt: 1 })];
		quest.acceptance = {
			criteria: ["the flag file exists"],
			commands: [flagCheck(h.cwd)],
			status: "pending",
			rounds,
			evidence: [],
		};
		saveQuest(quest, h.cwd);
		h.rt.setQuest(quest);
		return quest;
	}

	test("all steps done is not done: a failing command adds and fires one corrective step", async () => {
		const h = harness();
		try {
			const quest = seedAccepted(h);
			await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx);

			assert.equal(quest.status, "active", "not completed");
			assert.equal(quest.steps.length, 2);
			assert.match(quest.steps[1].content, /^Fix acceptance: /);
			assert.match(quest.steps[1].context, /the flag file exists/);
			assert.notEqual(quest.steps[1].status, "pending", "corrective step was fired");
			assert.equal(quest.acceptance?.status, "failed");
			assert.equal(quest.acceptance?.rounds, 1);
			assert.equal(quest.acceptance?.evidence[0].status, "fail");
			assert.equal(loadQuest(h.cwd)?.acceptance?.rounds, 1, "persisted");

			// The corrective step lands; the gate re-runs and the quest completes.
			writeFileSync(join(h.cwd, "flag"), "");
			Object.assign(quest.steps[1], { status: "done", phase: "done", completedAt: 2 });
			await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx);

			assert.equal(quest.status, "done");
			assert.equal(quest.acceptance?.status, "passing");
			const recap = h.steers.at(-1) ?? "";
			assert.match(recap, /### Acceptance/);
			assert.match(recap, /- the flag file exists/);
			assert.match(recap, /✅ passing after 1 corrective round/);
		} finally {
			h.cleanup();
		}
	});

	test("out of corrective rounds pauses instead of looping", async () => {
		const h = harness();
		try {
			const quest = seedAccepted(h, 2);
			await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx);
			assert.equal(quest.status, "paused");
			assert.match(quest.pauseReason ?? "", /Acceptance still failing after 2 corrective round/);
			assert.equal(quest.steps.length, 1, "no further corrective step");
		} finally {
			h.cleanup();
		}
	});

	test("a turn ending mid-gate doesn't start a second gate; pausing mid-gate wins", async () => {
		const h = harness();
		try {
			const quest = seedAccepted(h);
			// Slow command so the gate is still running when the next turn ends.
			const slow = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => process.exit(1), 300)'`;
			quest.acceptance!.commands = [slow];
			const first = applyAcceptanceCheck(h.rt, h.ctx, quest);
			assert.equal(await applyAcceptanceCheck(h.rt, h.ctx, quest), false, "second gate is a no-op");

			quest.status = "paused"; // user hits Esc while the command runs
			assert.equal(await first, false);
			assert.equal(quest.status, "paused", "not completed or resumed");
			assert.equal(quest.steps.length, 1, "no corrective step fired behind the user's back");
			assert.equal(quest.acceptance?.evidence[0].status, "fail", "evidence still recorded");
			assert.equal(quest.acceptance?.rounds, 0);
		} finally {
			h.cleanup();
		}
	});

	test("a gate finishing after abort or replacement cannot restore its stale quest", async () => {
		for (const replace of [false, true]) {
			const h = harness();
			try {
				const quest = seedAccepted(h);
				quest.acceptance!.commands = [
					`${JSON.stringify(process.execPath)} -e 'setTimeout(() => process.exit(0), 50)'`,
				];
				const pending = applyAcceptanceCheck(h.rt, h.ctx, quest);
				clearActiveQuest(h.cwd);
				const current = replace ? emptyQuest("Replacement", "new goal") : null;
				if (current) saveQuest(current, h.cwd);
				h.rt.setQuest(current);

				assert.equal(await pending, false);
				assert.equal(h.rt.getQuest(h.cwd), current, "current quest stays in the cache");
				assert.equal(loadQuest(h.cwd)?.name ?? null, current?.name ?? null, "disk stays current");
				assert.equal(h.steers.length, 0, "no stale work dispatched");
			} finally {
				h.cleanup();
			}
		}
	});

	test("a passing gate completes the quest on the first try", async () => {
		const h = harness();
		try {
			writeFileSync(join(h.cwd, "flag"), "");
			const quest = seedAccepted(h);
			await handleAgentEnd(h.pi, h.rt, { messages: [] }, h.ctx);
			assert.equal(quest.status, "done");
			assert.equal(quest.steps.length, 1);
		} finally {
			h.cleanup();
		}
	});
});
