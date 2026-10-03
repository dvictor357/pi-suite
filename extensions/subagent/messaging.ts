/** Project-scoped peer inboxes. Immutable message files avoid cross-process lost updates. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { asRecord, cwdHash, isFutureContract, optStr, readJSON, writeJSON } from "../../core";

export const PEER_ID_ENV = "PI_SUBAGENT_PEER_ID";
export const PROJECT_CWD_ENV = "PI_SUBAGENT_PROJECT_CWD";
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_PENDING_MESSAGES = 100;
/** Set to "off" in a child's environment to withhold messaging; inherited by its own children. */
export const MESSAGING_ENV = "PI_SUBAGENT_MESSAGING";
/**
 * Judge/exploration agents never get messaging: a concurrently running worker could
 * otherwise message the verifier that judges it. Matched by agent name.
 */
export const NO_MESSAGING_AGENTS: ReadonlySet<string> = new Set([
	"verifier",
	"reviewer",
	"scout",
	"planner",
]);
/** Peers (and their inboxes) idle longer than this are pruned, whatever their status. */
export const PEER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface Peer {
	id: string;
	name: string;
	updatedAt: number;
	status: "running" | "finished";
	task?: string;
}
export interface PeerMessage {
	id: string;
	from: string;
	to: string;
	text: string;
	createdAt: number;
}
function validId(id: string): string {
	if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
		throw new Error("Invalid peer/message ID; use an ID returned by subagent_message.");
	return id;
}
function names(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
function read(file: string): Record<string, unknown> {
	const blob = asRecord(readJSON<unknown>(file, null));
	if (isFutureContract(blob))
		throw new Error(
			`Peer messaging file has a newer contract version: ${file}. Upgrade before using it.`,
		);
	return blob;
}
function write(file: string, value: unknown): void {
	writeJSON(file, value, { mode: 0o600, throwOnError: true });
}

export function messagingRoot(cwd: string): string {
	return join(getAgentDir(), "subagent-mail", cwdHash(cwd));
}
export function childPeerId(runId: string): string {
	return `agent-${cwdHash(runId)}`;
}
export function messagingEnabled(agentName: string): boolean {
	return process.env[MESSAGING_ENV] !== "off" && !NO_MESSAGING_AGENTS.has(agentName);
}
/** Child environment without messaging: no inherited peer identity to impersonate. */
export function noMessagingEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, [MESSAGING_ENV]: "off" };
	delete env[PEER_ID_ENV];
	return env;
}
export function peerEnvironment(cwd: string, runId: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		[PEER_ID_ENV]: childPeerId(runId),
		[PROJECT_CWD_ENV]: process.env[PROJECT_CWD_ENV] || cwd,
	};
}

export class PeerInbox {
	readonly root: string;
	constructor(
		cwd: string,
		readonly peerId: string,
	) {
		validId(peerId);
		this.root = messagingRoot(cwd);
	}
	private peerPath(id: string): string {
		return join(this.root, "peers", `${validId(id)}.json`);
	}
	private inbox(id: string): string {
		return join(this.root, "inboxes", validId(id));
	}
	register(name: string | undefined, status: Peer["status"] = "running", task?: string): Peer {
		const previous = read(this.peerPath(this.peerId));
		const peer: Peer = {
			id: this.peerId,
			name: (name ?? optStr(previous.name) ?? "orchestrator").slice(0, 80),
			task: (task ?? optStr(previous.task))?.slice(0, 200),
			status,
			updatedAt: Date.now(),
		};
		mkdirSync(join(this.root, "peers"), { recursive: true, mode: 0o700 });
		mkdirSync(this.inbox(this.peerId), { recursive: true, mode: 0o700 });
		write(this.peerPath(this.peerId), peer);
		return peer;
	}
	/**
	 * Remove other peers idle past the retention window, with their inboxes. A
	 * concurrent send to a pruned peer can leave an orphan inbox; it holds no peer
	 * file, so it is unreachable and harmless. Unreadable/future files are skipped.
	 */
	prune(now = Date.now(), retentionMs = PEER_RETENTION_MS): number {
		let removed = 0;
		for (const name of names(join(this.root, "peers"))) {
			const id = name.slice(0, -".json".length);
			if (id === this.peerId) continue;
			try {
				const peer = read(join(this.root, "peers", name));
				const updatedAt = typeof peer.updatedAt === "number" ? peer.updatedAt : 0;
				if (now - updatedAt <= retentionMs) continue;
				rmSync(this.inbox(id), { recursive: true, force: true });
				rmSync(join(this.root, "peers", name), { force: true });
				removed++;
			} catch {
				/* Skip files we cannot read or must not touch. */
			}
		}
		return removed;
	}
	peers(offset = 0, limit = 50): Peer[] {
		return names(join(this.root, "peers"))
			.map((name) => read(join(this.root, "peers", name)))
			.filter(
				(p): p is Record<string, unknown> & Peer =>
					typeof p.id === "string" &&
					typeof p.name === "string" &&
					typeof p.updatedAt === "number" &&
					(p.status === "running" || p.status === "finished"),
			)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			.slice(offset, offset + limit);
	}
	pendingCount(): number {
		return names(this.inbox(this.peerId)).length;
	}
	send(to: string, text: string): PeerMessage {
		if (!text.trim() || Buffer.byteLength(text) > MAX_MESSAGE_BYTES)
			throw new Error(`Message must contain 1-${MAX_MESSAGE_BYTES} UTF-8 bytes.`);
		if (read(this.peerPath(to)).id !== to)
			throw new Error(`Unknown peer "${to}" in this project. List peers first.`);
		const dir = this.inbox(to);
		// Soft cap: concurrent sends can overshoot it; a strict quota would need a cross-process lock.
		if (names(dir).length >= MAX_PENDING_MESSAGES)
			throw new Error(
				`Peer "${to}" inbox is full; it must acknowledge messages before more can be sent.`,
			);
		const message: PeerMessage = {
			id: randomUUID(),
			from: this.peerId,
			to,
			text,
			createdAt: Date.now(),
		};
		write(join(dir, `${message.id}.json`), message);
		return message;
	}
	read(limit = 10): PeerMessage[] {
		const dir = this.inbox(this.peerId);
		return names(dir)
			.map((name) => read(join(dir, name)))
			.filter(
				(m): m is Record<string, unknown> & PeerMessage =>
					typeof m.id === "string" &&
					typeof m.from === "string" &&
					m.to === this.peerId &&
					typeof m.text === "string" &&
					typeof m.createdAt === "number",
			)
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
			.slice(0, limit);
	}
	acknowledge(ids: string[]): void {
		// Validate the whole batch before removing anything. Reads never consume messages.
		ids.forEach(validId);
		ids.forEach((id) => read(join(this.inbox(this.peerId), `${id}.json`)));
		for (const id of ids) {
			try {
				unlinkSync(join(this.inbox(this.peerId), `${id}.json`));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}
