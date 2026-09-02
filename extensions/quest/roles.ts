/**
 * Roles that explore/judge but must not mutate the working tree, hold write
 * claims, or be laddered. Single source of truth for the role-set — importing
 * from here prevents drift across delegate.ts (tool scope), sandbox.ts
 * (sandboxed tool plan), write-claim.ts (write claims), and ladder.ts
 * (escalation eligibility).
 */
const READ_ONLY_ROLES = new Set(["scout", "verifier", "reviewer", "planner"]);

/** True for judge/exploration roles (scout, verifier, reviewer, planner). */
export function isReadOnlyRole(role: string): boolean {
	return READ_ONLY_ROLES.has(role.trim().toLowerCase());
}
