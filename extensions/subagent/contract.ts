/**
 * Structured output contracts.
 *
 * An agent (frontmatter `output:`) or a single invocation (`output` param) can
 * declare a JSON Schema for its final answer. The contract is appended to the
 * task, the final message's JSON is extracted and validated, and one repair
 * run is attempted on mismatch. Chains and pipelines then pass the validated
 * value on as canonical JSON, with `{previous.field}` access.
 */

import { Errors } from "typebox/value";

export type JsonSchema = Record<string, unknown>;

const MAX_REPORTED_ERRORS = 20;

export function isJsonSchema(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contractInstructions(schema: JsonSchema): string {
	return [
		"",
		"",
		"---",
		"OUTPUT CONTRACT: your final message must contain exactly one JSON value that validates against the JSON Schema below.",
		"Put it in a single ```json fenced code block. Do not put any other JSON code block in the final message.",
		"Schema:",
		"```json",
		JSON.stringify(schema, null, 2),
		"```",
	].join("\n");
}

type Extracted = { ok: true; value: unknown } | { ok: false; error: string };

function tryParse(text: string): Extracted {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Pull the JSON answer out of a final message: the last fenced block that
 * parses, else the whole message, else the outermost {...} / [...] span.
 */
export function extractJson(text: string): Extracted {
	const fenced = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)```/g)];
	let lastError = "";
	for (const match of fenced.reverse()) {
		const parsed = tryParse(match[1].trim());
		if (parsed.ok) return parsed;
		lastError = parsed.error;
	}

	const trimmed = text.trim();
	if (!trimmed) return { ok: false, error: "final message is empty" };
	const whole = tryParse(trimmed);
	if (whole.ok) return whole;

	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	]) {
		const start = trimmed.indexOf(open);
		const end = trimmed.lastIndexOf(close);
		if (start !== -1 && end > start) {
			const span = tryParse(trimmed.slice(start, end + 1));
			if (span.ok) return span;
		}
	}
	return {
		ok: false,
		error: `no parseable JSON found in final message${lastError ? ` (fenced block: ${lastError})` : ""}`,
	};
}

/** Validation errors as "path: message" lines; empty when valid. */
export function validateOutput(schema: JsonSchema, value: unknown): string[] {
	try {
		const errors = Errors(schema as never, value);
		if (errors.length === 0) return [];
		const lines = errors.map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
		const unique = [...new Set(lines)];
		return unique.length > MAX_REPORTED_ERRORS
			? [...unique.slice(0, MAX_REPORTED_ERRORS), `… ${unique.length - MAX_REPORTED_ERRORS} more`]
			: unique;
	} catch (error) {
		return [
			`output schema could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
}

export function checkContract(
	schema: JsonSchema,
	finalText: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
	const extracted = extractJson(finalText);
	if (!extracted.ok) return { ok: false, errors: [extracted.error] };
	const errors = validateOutput(schema, extracted.value);
	return errors.length === 0 ? { ok: true, value: extracted.value } : { ok: false, errors };
}

/** Task for the one repair attempt: fix the format, don't redo the work. */
export function repairTask(
	originalTask: string,
	schema: JsonSchema,
	previousAnswer: string,
	errors: string[],
): string {
	return (
		[
			"A previous run of this task produced an answer that does not satisfy its output contract.",
			"Rewrite that answer as JSON that satisfies the schema. Only investigate again if information needed by the schema is genuinely missing from the answer.",
			"",
			"Validation errors:",
			...errors.map((e) => `- ${e}`),
			"",
			"Original task:",
			"<<<",
			originalTask,
			">>>",
			"",
			"Previous final answer:",
			"<<<",
			previousAnswer,
			">>>",
		].join("\n") + contractInstructions(schema)
	);
}

/** Canonical text form of a structured result, used for `{previous}`. */
export function formatStructured(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function resolvePath(value: unknown, segments: string[]): { found: boolean; value?: unknown } {
	let current = value;
	for (const segment of segments) {
		if (Array.isArray(current) && /^\d+$/.test(segment)) {
			const index = Number(segment);
			if (index >= current.length) return { found: false };
			current = current[index];
		} else if (
			typeof current === "object" &&
			current !== null &&
			Object.prototype.hasOwnProperty.call(current, segment)
		) {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return { found: false };
		}
	}
	return { found: true, value: current };
}

/**
 * Fill `{previous}` and `{previous.a.b}` placeholders. `{previous}` is the
 * prior step's text (canonical JSON when it had a contract). A path requires
 * structured output and must exist — a silent empty substitution would hand
 * the next agent a broken task.
 */
export function substitutePrevious(
	template: string,
	previousText: string,
	previousStructured: unknown,
): { ok: true; text: string } | { ok: false; error: string } {
	let error: string | null = null;
	const text = template.replace(
		/\{previous((?:\.[A-Za-z0-9_$-]+)*)\}/g,
		(match, pathPart: string) => {
			if (!pathPart) return previousText;
			if (previousStructured === undefined) {
				error ??= `${match} needs structured output from the previous step; give that step an output schema`;
				return match;
			}
			const resolved = resolvePath(previousStructured, pathPart.slice(1).split("."));
			if (!resolved.found) {
				error ??= `${match}: path not found in the previous step's output`;
				return match;
			}
			return typeof resolved.value === "string" ? resolved.value : JSON.stringify(resolved.value);
		},
	);
	return error ? { ok: false, error } : { ok: true, text };
}
