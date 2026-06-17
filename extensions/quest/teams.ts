import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TeamConfig } from "./types";
import { TEAMS_DIR, BUILT_IN_TEAMS } from "./constants";

export function loadTeams(): Record<string, TeamConfig> {
	try {
		if (!existsSync(TEAMS_DIR)) return {};
		const teams: Record<string, TeamConfig> = {};
		for (const f of readdirSync(TEAMS_DIR)) {
			if (!f.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(readFileSync(join(TEAMS_DIR, f), "utf8"));
				if (raw && raw.name) {
					teams[raw.name] = raw as TeamConfig;
				}
			} catch (e) {
				console.error("[pi-quest] loadTeams/read:", e); /* skip corrupt files */
			}
		}
		return teams;
	} catch (e) {
		console.error("[pi-quest] loadTeams:", e);
		return {};
	}
}

const SAFE_TEAM_NAME = /^[a-z0-9_-]+$/i;

export function saveTeam(team: TeamConfig): void {
	try {
		if (!SAFE_TEAM_NAME.test(team.name)) {
			throw new Error(
				`Invalid team name: "${team.name}". Use only letters, numbers, hyphens, and underscores.`,
			);
		}
		mkdirSync(TEAMS_DIR, { recursive: true });
		writeFileSync(
			join(TEAMS_DIR, `${team.name}.json`),
			`${JSON.stringify(team, null, 2)}\n`,
			"utf8",
		);
	} catch (e) {
		console.error("[pi-quest] saveTeam:", e); /* best-effort */
	}
}

export function ensureBuiltInTeams(): void {
	try {
		const existing = loadTeams();
		for (const key of Object.keys(BUILT_IN_TEAMS)) {
			if (!existing[key]) {
				saveTeam(BUILT_IN_TEAMS[key]);
			}
		}
	} catch (e) {
		console.error("[pi-quest] ensureBuiltInTeams:", e); /* best-effort */
	}
}

export function teamInstallFromGit(url: string): {
	success: boolean;
	team?: TeamConfig;
	error?: string;
} {
	const tmpDir = join(homedir(), ".pi", "agent", "quests", "teams", ".tmp");
	try {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch (e) {
			console.error("[pi-quest] teamInstallFromGit/pre-cleanup:", e); /* ok */
		}

		execFileSync("git", ["clone", "--depth", "1", url, tmpDir], {
			encoding: "utf8",
			timeout: 30000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const candidates = ["team.json", "quest-team.json", "quest.team.json"];
		let raw: any = null;
		for (const c of candidates) {
			const p = join(tmpDir, c);
			if (existsSync(p)) {
				raw = JSON.parse(readFileSync(p, "utf8"));
				break;
			}
		}

		if (!raw) {
			return {
				success: false,
				error: "No team.json, quest-team.json, or quest.team.json found in repository root.",
			};
		}

		if (!raw.name || !raw.description || !Array.isArray(raw.members)) {
			return {
				success: false,
				error: "Team config must have name, description, and members array.",
			};
		}

		const team: TeamConfig = {
			name: raw.name,
			description: raw.description,
			lead: raw.lead || raw.members[0]?.agent || "worker",
			members: raw.members.map((m: any) => ({
				role: m.role || m.agent || "member",
				agent: m.agent || "worker",
			})),
			defaultAgent: raw.defaultAgent || raw.members[0]?.agent || "worker",
			verification: typeof raw.verification === "boolean" ? raw.verification : true,
		};

		if (Array.isArray(raw.agents)) {
			team.agents = raw.agents.map((a: any) => ({
				name: a.name || "",
				description: a.description || "",
				markdown:
					a.markdown || a.file
						? (() => {
								const safeFile = a.file ? basename(a.file) : `${a.name}.md`;
								const mdPath = join(tmpDir, safeFile);
								try {
									return readFileSync(mdPath, "utf8");
								} catch (e) {
									console.error("[pi-quest] teamInstallFromGit/agent-md:", e);
									return a.markdown || "";
								}
							})()
						: "",
			}));
		}

		if (team.agents && team.agents.length > 0) {
			const agentsDir = join(homedir(), ".pi", "agent", "agents");
			mkdirSync(agentsDir, { recursive: true });
			for (const agent of team.agents) {
				if (!agent.markdown) continue;
				if (!SAFE_TEAM_NAME.test(agent.name)) {
					console.error(
						`[pi-quest] teamInstallFromGit: skipping agent with unsafe name "${agent.name}"`,
					);
					continue;
				}
				writeFileSync(join(agentsDir, `${agent.name}.md`), agent.markdown, "utf8");
			}
		}

		saveTeam(team);

		return { success: true, team };
	} catch (e: any) {
		console.error("[pi-quest] teamInstallFromGit:", e);
		return { success: false, error: e?.message || String(e) };
	} finally {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch (e) {
			console.error("[pi-quest] teamInstallFromGit/cleanup:", e); /* cleanup */
		}
	}
}
