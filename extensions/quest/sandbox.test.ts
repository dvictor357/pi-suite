import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	resolveSandboxProfile,
	isSandboxActive,
	sandboxedTools,
	sandboxToolsForRole,
	sandboxToolPlan,
	SENSITIVE_DENIED_GLOBS,
	getSensitiveDeniedPaths,
	classifyCommand,
	isPackageInstallCommand,
	isDestructiveCommand,
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

describe("sandboxToolPlan", () => {
	const restricted = (allowCommands: string[] = []) =>
		resolveSandboxProfile({
			mode: "restricted",
			allowedPaths: [],
			deniedPaths: [],
			allowCommands,
			denyCommands: [],
			allowNetwork: true,
			allowPackageInstall: true,
			worktree: null,
		});

	test("read-only roles get only read-only tools", () => {
		for (const role of ["planner", "scout", "reviewer", "verifier"]) {
			assert.deepEqual(sandboxToolPlan(role, restricted()), ["read", "grep", "find", "ls"]);
		}
	});

	test("write-capable roles keep guarded edit + write (granular, not stripped)", () => {
		const plan = sandboxToolPlan("worker", restricted());
		assert.ok(plan.includes("edit"));
		assert.ok(plan.includes("write"));
	});

	test("bash is included only when the policy lists allowed commands", () => {
		assert.ok(!sandboxToolPlan("worker", restricted([])).includes("bash"));
		assert.ok(sandboxToolPlan("worker", restricted(["npm test"])).includes("bash"));
	});
});

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

	test("escapes mode: step can escalate but not de-escalate", () => {
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

	test("when quest has no allowed paths in restricted mode, step override paths are ignored (strict tightening)", () => {
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

	test("when quest has no allowed commands in restricted mode, step override commands are ignored (strict tightening)", () => {
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

	test("when quest has no allowed paths in none mode, step override paths are used (full access baseline)", () => {
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

	test("step escalation to restricted with allowedPaths is still empty when quest has no allow-list", () => {
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

	test("when quest has no allowed commands in none mode, step override commands are used", () => {
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
