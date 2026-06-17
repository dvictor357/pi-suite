/**
 * Ambient shims for pi's runtime packages and typebox.
 *
 * These are NOT the real type definitions — they are permissive stand-ins so
 * `tsc --noEmit` can typecheck the suite's own code (undefined identifiers, bad
 * references, unused symbols) without requiring the pi host packages to be
 * installed. The real types are provided by the pi runtime at load time.
 *
 * `core/` does not import any of these — it is pure Node — so the shared
 * contract is typechecked strictly regardless.
 */

declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionAPI = any;
	export type ExtensionContext = any;
}

declare module "@earendil-works/pi-ai" {
	export const StringEnum: any;
}

declare module "@earendil-works/pi-tui" {
	export const matchesKey: any;
	export const Key: any;
	export const Text: any;
}

declare module "typebox" {
	export const Type: any;
}
