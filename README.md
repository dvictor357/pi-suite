# pi-suite

A loop-engineering toolkit for [pi](https://pi.dev) — three extensions, previously
maintained as separate repos, now consolidated here behind one cross-extension contract:

| Extension     | Role                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| **pi-quest**  | Proactive AI project manager — plans, delegates to sub-agents, verifies, and pushes forward autonomously. |
| **pi-todo**   | Persistent task ledger with sub-agent delegation.                                                         |
| **pi-memory** | Persistent project & user memory — tech-stack detection, conventions, structured facts.                   |

They were built to work together (quest syncs tasks into todo and conventions/research
into memory). Consolidating them into one repo makes that relationship explicit: a single
shared [`core/`](core/README.md) module owns the storage contract, so the three can no
longer drift apart silently. The standalone `pi-quest`, `pi-todo`, and `pi-memory` repos
are now deprecated in favor of this suite.

## Layout

```
pi-suite/
├── core/                  # shared cross-extension contract + *.test.ts
│   ├── contract.ts        #   JSON types, CONTRACT_VERSION
│   ├── paths.ts / hash.ts #   ~/.pi/agent path helpers, cwdHash
│   ├── fs.ts              #   readJSON / writeJSON / updateJSON / appendLine
│   ├── session-meta.ts    #   shared status handoff between extensions
│   ├── retry-policy.ts    #   retry/burst/depth constants (one source of truth)
│   ├── run-ledger.ts      #   append-only JSONL execution log per quest
│   └── eval-logging.ts    #   per-task eval audit trail (JSONL)
├── extensions/
│   ├── quest/             # pi-quest   → extensions/quest/index.ts
│   │   ├── context-broker.ts  #   composable sub-agent prompt builder
│   │   └── verifier.ts       #   structured verification loop
│   ├── todo/              # pi-todo    → extensions/todo/index.ts
│   └── memory/            # pi-memory  → extensions/memory/index.ts
├── docs/                  # architecture & design notes
├── tsconfig.json          # one typecheck gate over core + all extensions
└── .prettierrc.json       # one formatting convention for the whole suite
```

Each extension imports the shared contract from `core/` via a relative path
(`../../core`) — there is nothing to publish. The pi host packages
(`@earendil-works/pi-*`, `typebox`) are declared as `peerDependencies` (provided
by the pi runtime at load) and pinned as `devDependencies` so `tsc` checks real
API usage rather than `any` stand-ins.

## Why one repo

`pi`'s installer reads the **root** `package.json` of a git source and loads every
entry in its `pi.extensions` array. So one repo can ship all three extensions, and a
single `pi install` pulls them together — while `pi config` still lets a user disable any
one of them. A monorepo is therefore a first-class, `git:`-installable unit. The
alternative (three repos sharing a published `core` package) is only needed for
independent npm installation, which `pi`'s `git:` route cannot do for a subdirectory.

See [docs/architecture.md](docs/architecture.md) for the full rationale and the
evidence from `pi`'s package manager.

## Install

Install all three extensions together with a single command:

```bash
pi install git:github.com/dvictor357/pi-suite
```

To run just one extension, install the suite and disable the others with `pi config`.

## Develop

```bash
npm install        # dev tooling: typescript, prettier, tsx, pi host types
npm run typecheck  # tsc --noEmit over core + all extensions (against real pi types)
npm test           # node:test via tsx — core contract + retry-policy + run-ledger + eval-logging
npm run format     # prettier --write (tabs; see .editorconfig / .prettierrc.json)
```

CI runs `typecheck`, `test`, and `format:check` on every push and PR.

## Status

All three extensions have been migrated in from their standalone repos onto the shared
`core/` contract; those repos are now deprecated and archived. See
[MIGRATION.md](MIGRATION.md) for the migration record.

## License

MIT
