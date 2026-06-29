import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	resolveSandboxProfile,
	isSandboxActive,
	sandboxedTools,
	sandboxToolsForRole,
	SENSITIVE_DENIED_GLOBS,
	getSensitiveDeniedPaths,
	classifyCommand,
	isPackageInstallCommand,
	isDestructiveCommand,
	sanitizeBranchName,
	questBranchName,
	worktreePath,
	computeWorktreePlan,
	buildWorktreeSnapshot,
	cleanupIntent,
	validateTaskName,
	DEFAULT_SANDBOX_POLICY,
	type SandboxProfile,
} from "./sandbox";
import type { SandboxPolicy, SandboxOverrides, WorktreeConfig } from "./types";

const WORKTREE: WorktreeConfig = {
	enabled: true,
	baseBranch: "main",
	path: ".pi/worktrees/test-quest",
	autoCleanup: true,
};

// ── resolveSandboxProfile ────────────────────────────────────────────────────

describe("resolveSandboxProfile", () => {
	test("returns default full-access profile when policy and overrides are both absent", () => {
		const profile = resolveSandboxProfile();
		assert.deepEqual(profile, {
			mode: "none",
			allowedPaths: [],
			deniedPaths: SENSITIVE_DENIED_GLOBS,
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		} satisfies SandboxProfile);
	});

	test("passes through quest-level policy when there are no overrides", () => {
		const policy: SandboxPolicy = {
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: ["src/secrets/**"],
			allowCommands: ["npm test", "npm run build"],
			denyCommands: ["rm -rf"],
			allowNetwork: false,
			allowPackageInstall: false,
			worktree: null,
		};
		const profile = resolveSandboxProfile(policy);
		assert.deepEqual(profile, {
			mode: "restricted",
			allowedPaths: ["src/**"],
			deniedPaths: [...SENSITIVE_DENIED_GLOBS, "src/secrets/**"],
			allowCommands: ["npm test", "npm run build"],
			denyCommands: ["rm -rf"],
			allowNetwork: false,
			allowPackageInstall: false,
			worktree: null,
		});
	});

	test("escapes mode: task can escalate but not de-escalate", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			mode: "restricted",
		};

		// Escalate: restricted → isolated
		assert.equal(resolveSandboxProfile(policy, { mode: "isolated" }).mode, "isolated");

		// De-escalate attempt: isolated → none (silently ignored)
		const isolated: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, mode: "isolated" };
		assert.equal(resolveSandboxProfile(isolated, { mode: "none" }).mode, "isolated");

		// Same level (no-op)
		assert.equal(resolveSandboxProfile(policy, { mode: "restricted" }).mode, "restricted");
	});

	test("intersects allowed paths from quest and task", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowedPaths: ["src/**", "tests/**", "docs/**"],
		};
		const overrides: SandboxOverrides = {
			allowedPaths: ["src/**", "docs/**"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowedPaths, ["src/**", "docs/**"]);
	});

	test("when quest has no allowed paths in restricted mode, task override paths are ignored (strict tightening)", () => {
		const policy: SandboxPolicy = {
			mode: "restricted",
			allowedPaths: [],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		};
		const overrides: SandboxOverrides = {
			allowedPaths: ["safe/**"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowedPaths, [], "empty quest deny-all stays empty");
	});

	test("when quest has no allowed commands in restricted mode, task override commands are ignored (strict tightening)", () => {
		const policy: SandboxPolicy = {
			mode: "restricted",
			allowedPaths: [],
			deniedPaths: [],
			allowCommands: [],
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		};
		const overrides: SandboxOverrides = {
			allowCommands: ["npm test"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowCommands, [], "empty quest deny-all stays empty");
	});

	test("when quest has no allowed paths in none mode, task override paths are used (full access baseline)", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowedPaths: [],
		};
		const overrides: SandboxOverrides = {
			allowedPaths: ["safe/**"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowedPaths, ["safe/**"]);
	});

	test("task escalation to restricted with allowedPaths is still empty when quest has no allow-list", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowedPaths: [],
		};
		const overrides: SandboxOverrides = {
			mode: "restricted",
			allowedPaths: ["src/**"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.equal(profile.mode, "restricted");
		assert.deepEqual(profile.allowedPaths, [], "mode escalated but quest has no base allow-list");
	});

	test("unions denied paths from quest and task", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			deniedPaths: ["secrets/**", "*.key"],
		};
		const overrides: SandboxOverrides = {
			deniedPaths: ["*.pem"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.deniedPaths, [
			...SENSITIVE_DENIED_GLOBS,
			"secrets/**",
			"*.key",
			"*.pem",
		]);
	});

	test("deduplicates denied paths in the union", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			deniedPaths: ["a", "b"],
		};
		const overrides: SandboxOverrides = {
			deniedPaths: ["b", "c"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.deniedPaths, [...SENSITIVE_DENIED_GLOBS, "a", "b", "c"]);
	});

	test("intersects allowed commands from quest and task", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowCommands: ["npm test", "npm run lint", "npm run build"],
		};
		const overrides: SandboxOverrides = {
			allowCommands: ["npm test", "npm run build"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowCommands, ["npm test", "npm run build"]);
	});

	test("when quest has no allowed commands in none mode, task override commands are used", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowCommands: [],
		};
		const overrides: SandboxOverrides = {
			allowCommands: ["npm test"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.allowCommands, ["npm test"]);
	});

	test("unions denied commands from quest and task", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			denyCommands: ["rm -rf", "sudo"],
		};
		const overrides: SandboxOverrides = {
			denyCommands: ["chmod 777"],
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.deepEqual(profile.denyCommands, ["rm -rf", "sudo", "chmod 777"]);
	});

	test("tightens boolean flags (true → false only)", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowNetwork: true,
			allowPackageInstall: true,
		};
		const overrides: SandboxOverrides = {
			allowNetwork: false,
			allowPackageInstall: false,
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.equal(profile.allowNetwork, false);
		assert.equal(profile.allowPackageInstall, false);
	});

	test("boolean overrides cannot loosen (false → true ignored)", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			allowNetwork: false,
			allowPackageInstall: false,
		};
		const overrides: SandboxOverrides = {
			allowNetwork: true,
			allowPackageInstall: true,
		};
		const profile = resolveSandboxProfile(policy, overrides);
		assert.equal(profile.allowNetwork, false);
		assert.equal(profile.allowPackageInstall, false);
	});

	test("worktree is null unless mode is isolated", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			mode: "restricted",
			worktree: WORKTREE,
		};
		const profile = resolveSandboxProfile(policy);
		assert.equal(profile.worktree, null);
	});

	test("worktree config is included when mode is isolated", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			mode: "isolated",
			worktree: WORKTREE,
		};
		const profile = resolveSandboxProfile(policy);
		assert.deepEqual(profile.worktree, WORKTREE);
	});

	test("worktree is null when mode is isolated but worktree config is missing", () => {
		const policy: SandboxPolicy = {
			...DEFAULT_SANDBOX_POLICY,
			mode: "isolated",
			worktree: null,
		};
		const profile = resolveSandboxProfile(policy);
		assert.equal(profile.worktree, null);
	});
});

// ── isSandboxActive ──────────────────────────────────────────────────────────

describe("isSandboxActive", () => {
	test("false when mode is none", () => {
		assert.equal(
			isSandboxActive({ ...DEFAULT_SANDBOX_POLICY, mode: "none" } as SandboxProfile),
			false,
		);
	});

	test("true when mode is restricted", () => {
		assert.equal(
			isSandboxActive({ ...DEFAULT_SANDBOX_POLICY, mode: "restricted" } as SandboxProfile),
			true,
		);
	});

	test("true when mode is isolated", () => {
		assert.equal(
			isSandboxActive({ ...DEFAULT_SANDBOX_POLICY, mode: "isolated" } as SandboxProfile),
			true,
		);
	});
});

// ── sandboxedTools ───────────────────────────────────────────────────────────

describe("sandboxedTools", () => {
	test("returns role tools unchanged when sandbox is off", () => {
		assert.deepEqual(
			sandboxedTools({ ...DEFAULT_SANDBOX_POLICY, mode: "none" } as SandboxProfile, [
				"read",
				"bash",
				"edit",
				"write",
			]),
			["read", "bash", "edit", "write"],
		);
	});

	test("returns null unchanged when tools are null and sandbox is off", () => {
		assert.equal(
			sandboxedTools({ ...DEFAULT_SANDBOX_POLICY, mode: "none" } as SandboxProfile, null),
			null,
		);
	});

	test("removes edit, write, and bash when sandbox allows no commands", () => {
		const filtered = sandboxedTools(
			{ ...DEFAULT_SANDBOX_POLICY, mode: "restricted" } as SandboxProfile,
			["read", "grep", "find", "bash", "edit", "write"],
		);
		assert.deepEqual(filtered, ["read", "grep", "find"]);
	});

	test("keeps bash when sandbox allows commands", () => {
		const filtered = sandboxedTools(
			{
				...DEFAULT_SANDBOX_POLICY,
				mode: "isolated",
				allowCommands: ["npm test"],
			} as SandboxProfile,
			["read", "grep", "find", "bash", "edit", "write"],
		);
		assert.deepEqual(filtered, ["read", "grep", "find", "bash"]);
	});

	test("does not mutate the input array", () => {
		const original = ["read", "edit", "write"];
		const copy = [...original];
		sandboxedTools({ ...DEFAULT_SANDBOX_POLICY, mode: "restricted" } as SandboxProfile, copy);
		assert.deepEqual(copy, original);
	});

	test("preserves ls and other non-write tools", () => {
		const filtered = sandboxedTools(
			{ ...DEFAULT_SANDBOX_POLICY, mode: "isolated" } as SandboxProfile,
			["read", "grep", "find", "ls"],
		);
		assert.deepEqual(filtered, ["read", "grep", "find", "ls"]);
	});
});

// ── sandboxToolsForRole ─────────────────────────────────────────────────────

describe("sandboxToolsForRole", () => {
	test("planner/scout/reviewer/verifier default to read-only tools", () => {
		for (const role of ["planner", "scout", "reviewer", "verifier"]) {
			assert.deepEqual(sandboxToolsForRole(role), ["read", "grep", "find", "ls"]);
		}
	});

	test("worker and unknown roles default to write-capable tools", () => {
		assert.deepEqual(sandboxToolsForRole("worker"), [
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
		assert.deepEqual(sandboxToolsForRole("custom-agent"), [
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
	});

	test("active sandbox with no allowed commands removes bash and write tools from worker scope", () => {
		assert.deepEqual(
			sandboxToolsForRole("worker", {
				...DEFAULT_SANDBOX_POLICY,
				mode: "restricted",
			} as SandboxProfile),
			["read", "grep", "find", "ls"],
		);
	});

	test("active sandbox with allowed commands keeps bash for worker scope", () => {
		assert.deepEqual(
			sandboxToolsForRole("worker", {
				...DEFAULT_SANDBOX_POLICY,
				mode: "restricted",
				allowCommands: ["npm test"],
			} as SandboxProfile),
			["read", "bash", "grep", "find", "ls"],
		);
	});

	test("returns fresh arrays", () => {
		const first = sandboxToolsForRole("worker");
		first.pop();
		assert.deepEqual(sandboxToolsForRole("worker"), [
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
	});
});

// ── Sensitive paths ─────────────────────────────────────────────────────────

describe("sensitive paths", () => {
	test("SENSITIVE_DENIED_GLOBS covers common secret files", () => {
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/.env*"), "should block .env variants");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/.env.*"), "should block .env.production etc");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/*.pem"), "should block PEM keys");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/*.key"), "should block key files");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/secrets.*"), "should block secrets files");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/id_rsa*"), "should block SSH private keys");
		assert.ok(SENSITIVE_DENIED_GLOBS.includes("**/.token"), "should block token files");
	});

	test("getSensitiveDeniedPaths returns a fresh copy", () => {
		const a = getSensitiveDeniedPaths();
		const b = getSensitiveDeniedPaths();
		assert.deepEqual(a, b);
		assert.notStrictEqual(a, b);

		a.push("custom/**");
		assert.ok(!b.includes("custom/**"), "mutation does not leak");
	});

	test("getSensitiveDeniedPaths matches the constant", () => {
		assert.deepEqual(getSensitiveDeniedPaths(), SENSITIVE_DENIED_GLOBS);
	});
});

// ── Command classification ──────────────────────────────────────────────────

describe("classifyCommand", () => {
	test("null for empty or whitespace-only input", () => {
		assert.equal(classifyCommand(""), null);
		assert.equal(classifyCommand("   "), null);
	});

	test("classifies npm install as package-install", () => {
		assert.equal(classifyCommand("npm install"), "package-install");
		assert.equal(classifyCommand("npm i"), "package-install");
		assert.equal(classifyCommand("npm add express"), "package-install");
	});

	test("classifies yarn and pnpm install as package-install", () => {
		assert.equal(classifyCommand("yarn install"), "package-install");
		assert.equal(classifyCommand("yarn add lodash"), "package-install");
		assert.equal(classifyCommand("pnpm install"), "package-install");
		assert.equal(classifyCommand("pnpm add react"), "package-install");
	});

	test("classifies bun install as package-install", () => {
		assert.equal(classifyCommand("bun install"), "package-install");
		assert.equal(classifyCommand("bun add vite"), "package-install");
	});

	test("classifies pip install as package-install", () => {
		assert.equal(classifyCommand("pip install requests"), "package-install");
		assert.equal(classifyCommand("pip3 install flask"), "package-install");
	});

	test("classifies cargo install/add as package-install", () => {
		assert.equal(classifyCommand("cargo install serde"), "package-install");
		assert.equal(classifyCommand("cargo add serde"), "package-install");
	});

	test("classifies go get/install as package-install", () => {
		assert.equal(classifyCommand("go get github.com/foo"), "package-install");
		assert.equal(classifyCommand("go install ./..."), "package-install");
	});

	test("classifies composer install/require as package-install", () => {
		assert.equal(classifyCommand("composer install"), "package-install");
		assert.equal(classifyCommand("composer require monolog/monolog"), "package-install");
	});

	test("classifies rm -rf as destructive", () => {
		assert.equal(classifyCommand("rm -rf /tmp/stuff"), "destructive");
		assert.equal(classifyCommand("rm file.txt"), "destructive");
		assert.equal(classifyCommand("sudo rm -rf /"), "destructive");
	});

	test("classifies git push --force as destructive", () => {
		assert.equal(classifyCommand("git push --force"), "destructive");
		assert.equal(classifyCommand("git push --delete origin old-branch"), "destructive");
	});

	test("classifies git reset --hard as destructive", () => {
		assert.equal(classifyCommand("git reset --hard HEAD~1"), "destructive");
	});

	test("classifies docker rm/prune as destructive", () => {
		assert.equal(classifyCommand("docker rm container"), "destructive");
		assert.equal(classifyCommand("docker system prune"), "destructive");
		assert.equal(classifyCommand("podman rm container"), "destructive");
	});

	test("classifies curl and wget as network", () => {
		assert.equal(classifyCommand("curl https://example.com"), "network");
		assert.equal(classifyCommand("wget https://example.com"), "network");
	});

	test("classifies git clone/fetch/pull as network", () => {
		assert.equal(classifyCommand("git clone https://github.com/user/repo"), "network");
		assert.equal(classifyCommand("git fetch origin"), "network");
		assert.equal(classifyCommand("git pull"), "network");
	});

	test("classifies ssh and scp as network", () => {
		assert.equal(classifyCommand("ssh user@host"), "network");
		assert.equal(classifyCommand("scp file user@host:~"), "network");
	});

	test("classifies cloud CLI commands as network", () => {
		assert.equal(classifyCommand("aws s3 ls"), "network");
		assert.equal(classifyCommand("gcloud compute instances list"), "network");
		assert.equal(classifyCommand("az group list"), "network");
	});

	test("classifies npm run build as build", () => {
		assert.equal(classifyCommand("npm run build"), "build");
		assert.equal(classifyCommand("yarn run build"), "build");
		assert.equal(classifyCommand("pnpm run build"), "build");
	});

	test("classifies cargo build as build", () => {
		assert.equal(classifyCommand("cargo build"), "build");
	});

	test("classifies make / cmake / gcc as build", () => {
		assert.equal(classifyCommand("make"), "build");
		assert.equal(classifyCommand("cmake ."), "build");
		assert.equal(classifyCommand("gcc -o prog main.c"), "build");
		assert.equal(classifyCommand("tsc --noEmit"), "build");
	});

	test("classifies docker build as build", () => {
		assert.equal(classifyCommand("docker build -t img ."), "build");
		assert.equal(classifyCommand("docker compose up"), "build");
		assert.equal(classifyCommand("podman build ."), "build");
	});

	test("classifies npm test as test", () => {
		assert.equal(classifyCommand("npm test"), "test");
		assert.equal(classifyCommand("npm run test"), "test");
		assert.equal(classifyCommand("npm run test:e2e"), "test");
	});

	test("classifies cargo test as test", () => {
		assert.equal(classifyCommand("cargo test"), "test");
	});

	test("classifies pytest / vitest / jest as test", () => {
		assert.equal(classifyCommand("pytest"), "test");
		assert.equal(classifyCommand("vitest run"), "test");
		assert.equal(classifyCommand("jest"), "test");
		assert.equal(classifyCommand("npx jest"), "test");
		assert.equal(classifyCommand("go test ./..."), "test");
	});

	test("falls back to shell for unrecognized commands", () => {
		assert.equal(classifyCommand("echo hello"), "shell");
		assert.equal(classifyCommand("cat file.txt"), "shell");
		assert.equal(classifyCommand("ls -la"), "shell");
		assert.equal(classifyCommand("git status"), "shell");
	});

	test("package-install takes precedence over destructive for overlapping patterns", () => {
		// "npm install" matches the package-install pattern first,
		// even though one could argue it's also a build/network operation.
		assert.equal(classifyCommand("npm install"), "package-install");
	});
});

describe("isPackageInstallCommand", () => {
	test("true for known package install commands", () => {
		assert.equal(isPackageInstallCommand("npm install"), true);
		assert.equal(isPackageInstallCommand("pip install flask"), true);
		assert.equal(isPackageInstallCommand("cargo add serde"), true);
	});

	test("false for non-package-install commands", () => {
		assert.equal(isPackageInstallCommand("npm test"), false);
		assert.equal(isPackageInstallCommand("git status"), false);
		assert.equal(isPackageInstallCommand("rm file.txt"), false);
		assert.equal(isPackageInstallCommand(""), false);
	});
});

describe("isDestructiveCommand", () => {
	test("true for known destructive commands", () => {
		assert.equal(isDestructiveCommand("rm -rf /tmp"), true);
		assert.equal(isDestructiveCommand("git push --force"), true);
		assert.equal(isDestructiveCommand("docker rm container"), true);
	});

	test("false for non-destructive commands", () => {
		assert.equal(isDestructiveCommand("npm test"), false);
		assert.equal(isDestructiveCommand("curl example.com"), false);
		assert.equal(isDestructiveCommand("echo hello"), false);
		assert.equal(isDestructiveCommand(""), false);
	});
});

// ── Worktree lifecycle ─────────────────────────────────────────────────────

describe("computeWorktreePlan", () => {
	const enabledWorktree = { enabled: true, baseBranch: "main", path: "", autoCleanup: true };

	test("returns null when sandbox mode is not isolated", () => {
		assert.equal(
			computeWorktreePlan({
				questName: "test",
				worktree: enabledWorktree,
				sandboxMode: "restricted",
			}),
			null,
		);
		assert.equal(
			computeWorktreePlan({ questName: "test", worktree: enabledWorktree, sandboxMode: "none" }),
			null,
		);
		assert.equal(
			computeWorktreePlan({
				questName: "test",
				worktree: enabledWorktree,
				sandboxMode: undefined,
			}),
			null,
		);
	});

	test("returns null when worktree is null or not enabled", () => {
		assert.equal(
			computeWorktreePlan({ questName: "test", worktree: null, sandboxMode: "isolated" }),
			null,
		);
		assert.equal(
			computeWorktreePlan({ questName: "test", worktree: undefined, sandboxMode: "isolated" }),
			null,
		);
		assert.equal(
			computeWorktreePlan({
				questName: "test",
				worktree: { ...enabledWorktree, enabled: false },
				sandboxMode: "isolated",
			}),
			null,
		);
	});

	test("produces deterministic branch name and path for isolated mode", () => {
		const plan = computeWorktreePlan({
			questName: "My Quest",
			worktree: enabledWorktree,
			sandboxMode: "isolated",
		});
		assert.ok(plan !== null);
		assert.equal(plan!.branchName, "quest/my-quest");
		assert.equal(plan!.worktreePath, ".pi/worktrees/my-quest");
		assert.equal(plan!.baseBranch, "main");
		assert.equal(plan!.autoCleanup, true);
	});

	test("includes task index in branch name when provided", () => {
		const plan = computeWorktreePlan({
			questName: "auth",
			worktree: enabledWorktree,
			sandboxMode: "isolated",
			taskIndex: 3,
		});
		assert.ok(plan !== null);
		assert.equal(plan!.branchName, "quest/auth/task-3");
	});

	test("uses custom baseBranch from worktree config", () => {
		const plan = computeWorktreePlan({
			questName: "test",
			worktree: { ...enabledWorktree, baseBranch: "develop" },
			sandboxMode: "isolated",
		});
		assert.ok(plan !== null);
		assert.equal(plan!.baseBranch, "develop");
	});

	test("uses custom worktree path from config", () => {
		const plan = computeWorktreePlan({
			questName: "test",
			worktree: { ...enabledWorktree, path: ".pi/sandbox/my-sandbox" },
			sandboxMode: "isolated",
		});
		assert.ok(plan !== null);
		assert.equal(plan!.worktreePath, ".pi/sandbox/my-sandbox");
	});

	test("respects autoCleanup from config", () => {
		const plan = computeWorktreePlan({
			questName: "test",
			worktree: { ...enabledWorktree, autoCleanup: false },
			sandboxMode: "isolated",
		});
		assert.ok(plan !== null);
		assert.equal(plan!.autoCleanup, false);
	});

	test("baseBranch defaults to 'main' when empty or whitespace", () => {
		const plan = computeWorktreePlan({
			questName: "test",
			worktree: { ...enabledWorktree, baseBranch: "  " },
			sandboxMode: "isolated",
		});
		assert.ok(plan !== null);
		assert.equal(plan!.baseBranch, "main");
	});

	test("deterministic: same inputs always produce same plan", () => {
		const opts = {
			questName: "sandbox-test",
			worktree: { ...enabledWorktree, baseBranch: "master" },
			sandboxMode: "isolated" as const,
			taskIndex: 7,
		};
		const a = computeWorktreePlan(opts);
		const b = computeWorktreePlan(opts);
		assert.deepEqual(a, b);
	});
});

describe("buildWorktreeSnapshot", () => {
	test("produces a snapshot from a plan", () => {
		const plan = {
			branchName: "quest/auth/task-2",
			worktreePath: ".pi/worktrees/auth",
			baseBranch: "main",
			autoCleanup: true,
		};
		const snapshot = buildWorktreeSnapshot("Auth Quest", plan);
		assert.equal(snapshot.questName, "Auth Quest");
		assert.equal(snapshot.branchName, "quest/auth/task-2");
		assert.equal(snapshot.worktreePath, ".pi/worktrees/auth");
		assert.equal(snapshot.baseBranch, "main");
		assert.ok(typeof snapshot.createdAt === "number" && snapshot.createdAt > 0);
	});

	test("includes a timestamp", () => {
		const plan = {
			branchName: "quest/test",
			worktreePath: ".pi/worktrees/test",
			baseBranch: "main",
			autoCleanup: true,
		};
		const before = Date.now();
		const snapshot = buildWorktreeSnapshot("test", plan);
		const after = Date.now();
		assert.ok(snapshot.createdAt >= before && snapshot.createdAt <= after);
	});
});

describe("cleanupIntent", () => {
	const plan = {
		branchName: "quest/auth/task-2",
		worktreePath: ".pi/worktrees/auth",
		baseBranch: "main",
		autoCleanup: true,
	};
	const snapshot = buildWorktreeSnapshot("Auth", plan);

	test("returns shouldCleanup=false when no snapshot exists", () => {
		const intent = cleanupIntent(plan, null);
		assert.ok(intent !== null);
		assert.equal(intent!.shouldCleanup, false);
		assert.match(intent!.reason, /No rollback snapshot/);
		assert.equal(intent!.pruneCommand, "");
	});

	test("returns shouldCleanup=false when autoCleanup is disabled", () => {
		const noCleanup = { ...plan, autoCleanup: false };
		const intent = cleanupIntent(noCleanup, snapshot);
		assert.ok(intent !== null);
		assert.equal(intent!.shouldCleanup, false);
		assert.match(intent!.reason, /autoCleanup is disabled/);
		// Commands are still provided for manual use
		assert.ok(intent!.pruneCommand.startsWith("git worktree remove"));
	});

	test("returns shouldCleanup=true with commands when autoCleanup is on and snapshot exists", () => {
		const intent = cleanupIntent(plan, snapshot);
		assert.ok(intent !== null);
		assert.equal(intent!.shouldCleanup, true);
		assert.match(intent!.reason, /eligible for cleanup/);
		assert.equal(intent!.pruneCommand, 'git worktree remove ".pi/worktrees/auth"');
		assert.equal(intent!.deleteBranchCommand, 'git branch -D "quest/auth/task-2"');
	});

	test("commands quote paths containing special characters", () => {
		const planSpaces = {
			branchName: "quest/my-quest/task-1",
			worktreePath: ".pi/worktrees/my-quest",
			baseBranch: "main",
			autoCleanup: true,
		};
		const intent = cleanupIntent(planSpaces, buildWorktreeSnapshot("My Quest", planSpaces));
		assert.ok(intent !== null);
		assert.ok(intent!.pruneCommand.includes('"'));
		assert.ok(intent!.deleteBranchCommand.includes('"'));
	});

	test("cleanupIntent never mutates input plan or snapshot", () => {
		const planCopy = { ...plan };
		const snapshotCopy = { ...snapshot };
		cleanupIntent(plan, snapshot);
		assert.deepEqual(plan, planCopy);
		assert.deepEqual(snapshot, snapshotCopy);
	});
});

describe("validateTaskName", () => {
	test("returns sanitized name for valid input", () => {
		assert.equal(validateTaskName("Add auth"), "add-auth");
		assert.equal(validateTaskName("FixBug"), "fixbug");
		assert.equal(validateTaskName("my-task-3"), "my-task-3");
	});

	test("returns null for empty or whitespace-only input", () => {
		assert.equal(validateTaskName(""), null);
		assert.equal(validateTaskName("   "), null);
	});

	test("returns null for names that collapse to nothing", () => {
		assert.equal(validateTaskName("!!!"), null);
		assert.equal(validateTaskName("---"), null);
		assert.equal(validateTaskName("..."), null);
	});

	test("returns null for single-character names", () => {
		assert.equal(validateTaskName("a"), null);
		assert.equal(validateTaskName("x"), null);
		assert.equal(validateTaskName("1"), null);
	});

	test("returns null for names that reduce to 'task' only", () => {
		// sanitizeBranchName falls back to "task" for empty results,
		// validateTaskName rejects that as too generic.
		assert.equal(validateTaskName("!!!"), null);
	});

	test("trims whitespace before validation", () => {
		assert.equal(validateTaskName("  hello  "), "hello");
	});
});

// ── Branch & worktree naming ────────────────────────────────────────────────

describe("sanitizeBranchName", () => {
	test("lowercases input", () => {
		assert.equal(sanitizeBranchName("MyQuest"), "myquest");
	});

	test("replaces whitespace with hyphens", () => {
		assert.equal(sanitizeBranchName("my quest"), "my-quest");
		assert.equal(sanitizeBranchName("  multi   word  "), "multi-word");
	});

	test("replaces special characters with hyphens", () => {
		assert.equal(sanitizeBranchName("fix: bug!"), "fix-bug");
		assert.equal(sanitizeBranchName("hello@world#123"), "hello-world-123");
	});

	test("collapses repeated separators", () => {
		assert.equal(sanitizeBranchName("a---b"), "a-b");
		assert.equal(sanitizeBranchName("a..b"), "a-b");
		assert.equal(sanitizeBranchName("a___b"), "a-b");
	});

	test("strips leading and trailing separators", () => {
		assert.equal(sanitizeBranchName("-prefix"), "prefix");
		assert.equal(sanitizeBranchName("suffix-"), "suffix");
		assert.equal(sanitizeBranchName("-both-"), "both");
		assert.equal(sanitizeBranchName("/slashed/"), "slashed");
	});

	test("falls back to 'task' for empty result", () => {
		assert.equal(sanitizeBranchName(""), "task");
		assert.equal(sanitizeBranchName("!!!"), "task");
		assert.equal(sanitizeBranchName("---"), "task");
	});

	test("preserves allowed characters", () => {
		assert.equal(sanitizeBranchName("feat_123.v4/dev"), "feat_123.v4/dev");
	});

	test("truncates names exceeding git ref limit", () => {
		const long = "x".repeat(300);
		const result = sanitizeBranchName(long);
		assert.ok(result.length <= 240, `length ${result.length} > 240`);
	});
});

describe("questBranchName", () => {
	test("produces deterministic branch name for a quest", () => {
		const name = questBranchName("My Cool Quest");
		assert.equal(name, "quest/my-cool-quest");
	});

	test("produces the same name for the same input", () => {
		assert.equal(questBranchName("auth-refactor"), questBranchName("auth-refactor"));
	});

	test("includes task index when provided", () => {
		assert.equal(questBranchName("auth-refactor", 3), "quest/auth-refactor/task-3");
	});

	test("handles task index of 0", () => {
		assert.equal(questBranchName("init", 0), "quest/init/task-0");
	});

	test("sanitizes quest name in the branch", () => {
		const name = questBranchName("Fix: login bug! @urgent", 1);
		assert.equal(name, "quest/fix-login-bug-urgent/task-1");
	});
});

describe("worktreePath", () => {
	test("produces deterministic worktree path", () => {
		assert.equal(worktreePath("my quest"), ".pi/worktrees/my-quest");
		assert.equal(worktreePath("MyQuest"), ".pi/worktrees/myquest");
	});

	test("produces the same path for the same input", () => {
		assert.equal(worktreePath("sandbox-test"), worktreePath("sandbox-test"));
	});

	test("sanitizes quest name", () => {
		const path = worktreePath("Fix: race condition!");
		assert.equal(path, ".pi/worktrees/fix-race-condition");
	});
});
