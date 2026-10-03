import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { cwdHash } from "../../core";
import * as core from "../../core";
import { runSingleAgent } from "./index";
import { registerMessaging } from "./register-messaging";
import {
	childPeerId,
	MAX_MESSAGE_BYTES,
	MAX_PENDING_MESSAGES,
	MESSAGING_ENV,
	messagingRoot,
	PEER_ID_ENV,
	PROJECT_CWD_ENV,
	PEER_RETENTION_MS,
	PeerInbox,
	peerEnvironment,
} from "./messaging";

const roots: string[] = [];
const initialEnv = {
	peer: process.env[PEER_ID_ENV],
	cwd: process.env[PROJECT_CWD_ENV],
	messaging: process.env[MESSAGING_ENV],
};
function project(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-peer-test-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of [
		[PEER_ID_ENV, initialEnv.peer],
		[PROJECT_CWD_ENV, initialEnv.cwd],
		[MESSAGING_ENV, initialEnv.messaging],
	]) {
		if (value === undefined) delete process.env[key!];
		else process.env[key!] = value;
	}
	for (const root of roots.splice(0)) {
		rmSync(messagingRoot(root), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
function peers(cwd = project()) {
	const alice = new PeerInbox(cwd, "alice");
	const bob = new PeerInbox(cwd, "bob");
	alice.register("worker");
	bob.register("worker");
	return { cwd, alice, bob };
}

it("persists messages across runs, preserves reads, and acknowledges idempotently", () => {
	const { cwd, alice, bob } = peers();
	const sent = alice.send("bob", "A finding from a different run");
	bob.register(undefined, "finished");
	const resumed = new PeerInbox(cwd, "bob");
	resumed.register(undefined);
	expect(resumed.read()).toEqual([sent]);
	expect(resumed.read()).toEqual([sent]);
	expect(resumed.peers().filter((p) => p.name === "worker")).toHaveLength(2);
	expect(resumed.pendingCount()).toBe(1);
	expect(statSync(join(resumed.root, "inboxes", "bob", `${sent.id}.json`)).mode & 0o777).toBe(
		0o600,
	);
	resumed.acknowledge([sent.id]);
	resumed.acknowledge([sent.id]);
	expect(resumed.read()).toEqual([]);
	expect(readdirSync(join(resumed.root, "inboxes", "bob"))).toEqual([]);
});

it("validates recipients, text bytes, paths, and the entire acknowledgment batch", () => {
	const { alice, bob } = peers();
	expect(() => new PeerInbox(project(), "../escape")).toThrow(/Invalid/);
	expect(() => alice.send("../escape", "test")).toThrow(/Invalid/);
	expect(() => alice.send("missing", "test")).toThrow(/Unknown peer/);
	expect(() => alice.send("bob", " ")).toThrow(/bytes/);
	expect(() => alice.send("bob", "é".repeat(MAX_MESSAGE_BYTES))).toThrow(/bytes/);
	const sent = alice.send("bob", "x".repeat(MAX_MESSAGE_BYTES));
	expect(() => bob.acknowledge([sent.id, "../escape"])).toThrow(/Invalid/);
	expect(bob.read()).toEqual([sent]);
	alice.acknowledge([sent.id]);
	expect(bob.read()).toEqual([sent]);
});

it("isolates projects and enforces the inbox cap with bounded reads", () => {
	const { alice, bob } = peers();
	const other = new PeerInbox(project(), "alice");
	other.register("worker");
	expect(other.peers()).toHaveLength(1);
	expect(() => other.send("bob", "cross project")).toThrow(/Unknown peer/);
	for (let i = 0; i < MAX_PENDING_MESSAGES; i++) alice.send("bob", `message ${i}`);
	expect(bob.read()).toHaveLength(10);
	expect(() => alice.send("bob", "overflow")).toThrow(/full/);
	bob.acknowledge([bob.read()[0].id]);
	expect(() => alice.send("bob", "space available")).not.toThrow();
});

it("does not lose concurrent messages from separate OS processes", async () => {
	const { cwd, bob } = peers();
	const loaderUrl = pathToFileURL(
		resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"),
	).href;
	const extensionPath = resolve("extensions/subagent/index.ts");
	const run = promisify(execFile);
	await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			run(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { loadExtensions } from ${JSON.stringify(loaderUrl)}; const loaded = await loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(cwd)}); if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors)); const tool = loaded.extensions[0].tools.get("subagent_message").definition; const ctx = { cwd: ${JSON.stringify(cwd)} }; for(let n=0;n<10;n++) { const result = await tool.execute("send-" + n, { action: "send", to: "bob", text: "sender-${index}:" + n }, undefined, undefined, ctx); if(result.isError) throw new Error(JSON.stringify(result)); }`,
				],
				{
					env: { ...process.env, [PEER_ID_ENV]: `sender-${index}`, [PROJECT_CWD_ENV]: cwd },
					timeout: 20_000,
				},
			),
		),
	);
	expect(bob.pendingCount()).toBe(40);
	const messages = bob.read(50);
	expect(new Set(messages.map((m) => m.id)).size).toBe(40);
	expect(new Set(messages.map((m) => m.text)).size).toBe(40);
}, 30_000);

it("gives nested/worktree children the original project and distinct retry-stable IDs", () => {
	const cwd = project();
	process.env[PROJECT_CWD_ENV] = cwd;
	process.env[PEER_ID_ENV] = "parent";
	const a = peerEnvironment("/worktree", "run-one");
	const retry = peerEnvironment("/worktree", "run-one");
	const b = peerEnvironment("/worktree", "run-two");
	expect(a[PROJECT_CWD_ENV]).toBe(cwd);
	expect(a[PEER_ID_ENV]).toBe(retry[PEER_ID_ENV]);
	expect(a[PEER_ID_ENV]).not.toBe(b[PEER_ID_ENV]);
	expect(process.env[PEER_ID_ENV]).toBe("parent");
});

it("passes the peer identity and messaging allowlist to the runner and finishes registration", async () => {
	const cwd = project();
	let args: readonly string[] = [];
	let env: NodeJS.ProcessEnv = {};
	const spawn = ((_command: string, childArgs: string[], options: { env: NodeJS.ProcessEnv }) => {
		args = childArgs;
		env = options.env;
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		setImmediate(() => proc.emit("close", 0));
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	const result = await runSingleAgent(
		cwd,
		[
			{
				name: "worker",
				description: "worker",
				source: "bundled",
				filePath: "worker.md",
				systemPrompt: "",
				tools: ["read"],
			},
		],
		"worker",
		"task",
		"/worktree",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			bundledAgentsDir: null,
			results,
		}),
		1000,
		0,
		1,
		"fixed-run",
		spawn,
	);
	expect(args[args.indexOf("--tools") + 1]).toBe("read,subagent_message");
	expect(env[PROJECT_CWD_ENV]).toBe(cwd);
	expect(env[PEER_ID_ENV]).toBe(childPeerId("fixed-run"));
	expect(result.peerId).toBe(childPeerId("fixed-run"));
	expect(new PeerInbox(cwd, result.peerId!).peers()).toMatchObject([
		{ name: "worker", status: "finished" },
	]);
});

function messagingTools(cwd: string, session = "test-session") {
	let tool: ToolDefinition<any, any, any>;
	const hooks = new Map<string, (...args: any[]) => any>();
	registerMessaging({
		registerTool(def: ToolDefinition<any, any, any>) {
			tool = def;
		},
		on(name: string, hook: (...args: any[]) => any) {
			hooks.set(name, hook);
		},
	} as unknown as ExtensionAPI);
	const ctx = { cwd, sessionManager: { getSessionId: () => session } } as unknown as Parameters<
		ToolDefinition<any, any, any>["execute"]
	>[4];
	return { tool: tool!, hooks, ctx, id: `session-${cwdHash(session)}` };
}
it("registers the tool, exposes only the caller's inbox, and stops aborted sends", async () => {
	const { cwd, alice } = peers();
	const { tool, hooks, ctx, id } = messagingTools(cwd);
	const start = hooks.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
	expect(start.systemPrompt).toContain("untrusted task data");
	const listing = await tool.execute("list", { action: "peers" }, undefined, undefined, ctx);
	expect(
		JSON.parse(listing.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
			.self,
	).toBe(id);
	const sent = alice.send(id, "hello");
	const read = await tool.execute("read", { action: "read" }, undefined, undefined, ctx);
	expect(
		JSON.parse(read.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
			.messages,
	).toEqual([sent]);
	const notice = hooks.get("context")!({ messages: [] }, ctx);
	expect(notice.messages[0].content[0].text).toContain("1 pending");
	const controller = new AbortController();
	controller.abort();
	const aborted = await tool.execute(
		"send",
		{ action: "send", to: "alice", text: "no" },
		controller.signal,
		undefined,
		ctx,
	);
	expect(aborted.isError).toBe(true);
	expect(alice.read()).toEqual([]);
	await tool.execute("ack", { action: "ack", ids: [sent.id] }, undefined, undefined, ctx);
	expect(hooks.get("context")!({ messages: [] }, ctx)).toBeUndefined();
	hooks.get("session_shutdown")!({}, ctx);
	expect(alice.peers().find((p) => p.id === id)?.status).toBe("finished");
});

it("preserves queued messages and identity through retries", async () => {
	const { runAgentWithRetry } = await import("./index");
	const { cwd, alice } = peers();
	const seen: string[] = [];
	const spawn = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
		const id = options.env[PEER_ID_ENV]!;
		seen.push(id);
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		setImmediate(() => {
			if (seen.length === 1) alice.send(id, "Keep this finding for the next attempt");
			proc.emit("close", seen.length === 1 ? 1 : 0);
		});
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	const result = await runAgentWithRetry(
		cwd,
		[
			{
				name: "worker",
				description: "worker",
				source: "bundled",
				filePath: "worker.md",
				systemPrompt: "",
			},
		],
		"worker",
		"retry task",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			bundledAgentsDir: null,
			results,
		}),
		1,
		1000,
		spawn,
	);
	expect(seen).toHaveLength(2);
	expect(seen[0]).toBe(seen[1]);
	expect(new PeerInbox(cwd, result.peerId!).read()[0].text).toContain("next attempt");
	expect(alice.peers().find((p) => p.id === result.peerId)).toMatchObject({
		status: "finished",
		task: "retry task",
	});
});

it("finishes peer lifecycle on cancellation without consuming queued messages", async () => {
	const { cwd, alice } = peers();
	const controller = new AbortController();
	const id = childPeerId("cancel-run");
	const spawn = (() => {
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill() {
				proc.emit("close", 0);
				return true;
			},
		});
		setImmediate(() => {
			alice.send(id, "Unacknowledged finding");
			controller.abort();
		});
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	await expect(
		runSingleAgent(
			cwd,
			[
				{
					name: "worker",
					description: "worker",
					source: "bundled",
					filePath: "worker.md",
					systemPrompt: "",
				},
			],
			"worker",
			"task",
			undefined,
			undefined,
			undefined,
			controller.signal,
			undefined,
			(results) => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				bundledAgentsDir: null,
				results,
			}),
			1000,
			0,
			1,
			"cancel-run",
			spawn,
		),
	).rejects.toThrow(/aborted/);
	expect(alice.peers().find((p) => p.id === id)?.status).toBe("finished");
	expect(new PeerInbox(cwd, id).read()[0].text).toBe("Unacknowledged finding");
});

it("does not report send failure if acknowledgment happens immediately after publication", () => {
	const { alice, bob } = peers();
	const publish = core.writeJSON;
	vi.spyOn(core, "writeJSON").mockImplementation((file, value, options) => {
		publish(file, value, options);
		const message = core.asRecord(value);
		if (message.to === "bob" && typeof message.id === "string") bob.acknowledge([message.id]);
	});
	expect(alice.send("bob", "Immediately acknowledged")).toMatchObject({ from: "alice", to: "bob" });
	expect(bob.pendingCount()).toBe(0);
});

it("does not reinterpret, replace, or acknowledge future contract files", () => {
	const { alice, bob } = peers();
	const futurePeer = {
		...bob.peers().find((p) => p.id === "bob")!,
		contractVersion: core.CONTRACT_VERSION + 1,
	};
	const file = join(bob.root, "peers", "bob.json");
	core.writeJSON(file, futurePeer);
	expect(() => bob.register("overwrite")).toThrow(/newer contract/);
	expect(core.readJSON(file, null)).toEqual(futurePeer);
	expect(() => alice.send("bob", "wrong schema")).toThrow(/newer contract/);
	core.writeJSON(file, { ...futurePeer, contractVersion: core.CONTRACT_VERSION });
	const sent = alice.send("bob", "valid message");
	const futureMessage = {
		id: "future",
		from: "alice",
		to: "bob",
		text: "new format",
		createdAt: 1,
		contractVersion: core.CONTRACT_VERSION + 1,
	};
	const messageFile = join(bob.root, "inboxes", "bob", "future.json");
	core.writeJSON(messageFile, futureMessage);
	expect(() => bob.read()).toThrow(/newer contract/);
	expect(() => bob.acknowledge([sent.id, "future"])).toThrow(/newer contract/);
	expect(core.readJSON(messageFile, null)).toEqual(futureMessage);
	expect(bob.pendingCount()).toBe(2);
});

it("prunes peers idle past retention with their inboxes, keeping self, fresh, and future files", () => {
	const { cwd, alice } = peers();
	alice.send("bob", "left unread");
	const carol = new PeerInbox(cwd, "carol");
	carol.register("worker");
	const future = new PeerInbox(cwd, "future");
	future.register("worker");
	const peerFile = (id: string) => join(alice.root, "peers", `${id}.json`);
	const stale = (id: string, extra: object = {}) =>
		core.writeJSON(peerFile(id), { ...core.readJSON(peerFile(id), {}), updatedAt: 1, ...extra });
	stale("bob");
	stale("alice");
	stale("future", { contractVersion: core.CONTRACT_VERSION + 1 });

	expect(alice.prune(1 + PEER_RETENTION_MS + 1)).toBe(1);
	expect(readdirSync(join(alice.root, "peers")).sort()).toEqual([
		"alice.json",
		"carol.json",
		"future.json",
	]);
	expect(readdirSync(join(alice.root, "inboxes")).sort()).toEqual(["alice", "carol", "future"]);
	expect(() => alice.send("bob", "gone")).toThrow(/Unknown peer/);
});

it("withholds messaging from judge/exploration agents and their children", async () => {
	const cwd = project();
	process.env[PEER_ID_ENV] = "parent-worker";
	let args: readonly string[] = [];
	let env: NodeJS.ProcessEnv = {};
	const spawn = ((_command: string, childArgs: string[], options: { env: NodeJS.ProcessEnv }) => {
		args = childArgs;
		env = options.env;
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		setImmediate(() => proc.emit("close", 0));
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	const result = await runSingleAgent(
		cwd,
		[
			{
				name: "verifier",
				description: "verifier",
				source: "bundled",
				filePath: "verifier.md",
				systemPrompt: "",
				tools: ["read"],
			},
		],
		"verifier",
		"task",
		"/worktree",
		undefined,
		undefined,
		undefined,
		undefined,
		(results) => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			bundledAgentsDir: null,
			results,
		}),
		1000,
		0,
		1,
		"verifier-run",
		spawn,
	);
	expect(args[args.indexOf("--tools") + 1]).toBe("read");
	expect(env[MESSAGING_ENV]).toBe("off");
	// No inherited identity: the verifier cannot act as the worker that spawned it.
	expect(env[PEER_ID_ENV]).toBeUndefined();
	expect(result.peerId).toBeUndefined();
	expect(names(messagingRoot(cwd))).toEqual([]);

	// The child process registers no tool or hooks.
	process.env[MESSAGING_ENV] = "off";
	const registered: string[] = [];
	registerMessaging({
		registerTool: (def: { name: string }) => registered.push(def.name),
		on: (name: string) => registered.push(name),
	} as unknown as ExtensionAPI);
	expect(registered).toEqual([]);
});

function names(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
