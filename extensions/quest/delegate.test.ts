import { test } from "node:test";
import assert from "node:assert/strict";
import { toolsForRole, resolveTaskModel, extractFinalText, buildSubAgentPrompt } from "./delegate";

test("toolsForRole gives read-only scopes exploratory/judging roles", () => {
	for (const role of ["scout", "verifier", "reviewer", "planner", "SCOUT", " Reviewer "]) {
		const tools = toolsForRole(role);
		assert.ok(!tools.includes("edit"), `${role} should not edit`);
		assert.ok(!tools.includes("write"), `${role} should not write`);
		assert.ok(!tools.includes("bash"), `${role} should not run bash`);
		assert.ok(tools.includes("read"), `${role} should read`);
	}
});

test("toolsForRole gives a full scope to implementing roles", () => {
	const tools = toolsForRole("worker");
	for (const t of ["read", "bash", "edit", "write"]) {
		assert.ok(tools.includes(t), `worker should have ${t}`);
	}
});

test("toolsForRole returns a fresh array (no shared mutable state)", () => {
	const a = toolsForRole("worker");
	a.push("danger");
	assert.ok(!toolsForRole("worker").includes("danger"));
});

test("resolveTaskModel precedence: task model wins", () => {
	assert.deepEqual(resolveTaskModel({ taskModel: "gpt-5", rememberedModel: "claude-opus-4-5" }), {
		model: "gpt-5",
		needsPrompt: false,
	});
});

test("resolveTaskModel precedence: remembered model when task has none", () => {
	assert.deepEqual(resolveTaskModel({ rememberedModel: "claude-opus-4-5" }), {
		model: "claude-opus-4-5",
		needsPrompt: false,
	});
});

test("resolveTaskModel needs a prompt when nothing is known", () => {
	assert.deepEqual(resolveTaskModel({}), { needsPrompt: true });
	assert.deepEqual(resolveTaskModel({ taskModel: "  ", rememberedModel: "" }), {
		needsPrompt: true,
	});
});

test("extractFinalText reads the last assistant message's text blocks", () => {
	const messages = [
		{ role: "user", content: "do the thing" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Part one. " },
				{ type: "text", text: "Part two." },
			],
		},
	];
	assert.equal(extractFinalText(messages), "Part one. Part two.");
});

test("extractFinalText ignores tool-result messages after the assistant turn", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
	];
	assert.equal(extractFinalText(messages), "final answer");
});

test("extractFinalText handles string content and empty input", () => {
	assert.equal(extractFinalText([{ role: "assistant", content: "plain string" }]), "plain string");
	assert.equal(extractFinalText([]), "");
	assert.equal(extractFinalText([{ role: "user", content: "no assistant here" }]), "");
});

test("buildSubAgentPrompt includes role, task, and context", () => {
	const prompt = buildSubAgentPrompt({
		role: "scout",
		content: "Map the auth module",
		context: "Focus on token refresh",
	});
	assert.match(prompt, /"scout" sub-agent/);
	assert.match(prompt, /Map the auth module/);
	assert.match(prompt, /Focus on token refresh/);
});

test("buildSubAgentPrompt leads with the persona when provided", () => {
	const prompt = buildSubAgentPrompt({
		role: "scout",
		content: "Map the auth module",
		persona: "# Scout\nYou recon code without mutating it.",
	});
	assert.match(prompt, /^# Scout\nYou recon code without mutating it\.\n\n---/);
	// persona precedes the role/task framing
	assert.ok(prompt.indexOf("# Scout") < prompt.indexOf('"scout" sub-agent'));
});

test("buildSubAgentPrompt omits the persona block when persona is blank", () => {
	const prompt = buildSubAgentPrompt({ role: "worker", content: "Do it", persona: "   " });
	assert.doesNotMatch(prompt, /---/);
	assert.match(prompt, /^You are a "worker" sub-agent/);
});

test("buildSubAgentPrompt omits empty optional sections", () => {
	const prompt = buildSubAgentPrompt({ role: "worker", content: "Do it" });
	assert.doesNotMatch(prompt, /## Context/);
	assert.doesNotMatch(prompt, /Prior results/);
});

test("buildSubAgentPrompt lists only dependencies that produced a result", () => {
	const prompt = buildSubAgentPrompt({
		role: "worker",
		content: "Wire it up",
		dependencyResults: [
			{ content: "design api", result: "REST with JWT" },
			{ content: "unfinished", result: null },
		],
		formatDirective: "Run the formatter.",
	});
	assert.match(prompt, /design api: REST with JWT/);
	assert.doesNotMatch(prompt, /unfinished/);
	assert.match(prompt, /Run the formatter\./);
});
