/**
 * Typed coercion helpers for the disk-read boundary.
 *
 * Every extension parses untrusted JSON off disk (another extension, an older
 * contract, or a hand-edited file may have written it). Historically each read
 * site typed the parsed blob as `any` and reached into it field-by-field, which
 * defeats the type checker exactly where the data is least trustworthy. These
 * helpers take `unknown` and narrow it explicitly, so a malformed field becomes
 * a typed default instead of an `any` that silently propagates.
 *
 * Pure Node, no pi imports — safe for core.
 */

/** Narrow an unknown JSON value to a string-keyed record, or `{}` if it isn't one. */
export function asRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Keep only the string elements of an unknown value that should be a string array. */
export function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Coerce to boolean, falling back to `fallback` when the value isn't a boolean. */
export function boolOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Coerce to number, falling back to `fallback` when the value isn't a finite number. */
export function numOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Coerce to a non-empty string, falling back to `fallback` otherwise (trims). */
export function strOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Return the value when it is a string, else `undefined` (no trimming). */
export function optStr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Return the value when it is a finite number, else `undefined`. */
export function optNum(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** True when `value` is one of `allowed` (typed membership test for literal unions). */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
