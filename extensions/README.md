# extensions

Each subdirectory here is one pi extension. `pi` auto-discovers any subdirectory that
contains an `index.ts` (see the root `package.json` `pi.extensions` field), so adding an
extension is just landing its folder here.

```
extensions/
├── quest/    → index.ts   (pi-quest)
├── todo/     → index.ts   (pi-todo)
└── memory/   → index.ts   (pi-memory)
```

## Conventions

- **Entry point** is `index.ts` in the extension's folder.
- **Shared state goes through `core`.** Import the contract via the relative path:
  ```ts
  import { cwdHash, readJSON, writeJSON, writeSessionMeta } from "../../core";
  import type { TodoList, ProjectMemory } from "../../core";
  ```
  Do not re-declare `cwdHash`, the JSON helpers, the session-meta logic, or any shared
  on-disk shape — that duplication is exactly what `core` exists to remove.
- **Private state stays local.** State only one extension touches (e.g. quest's
  `active.json`, an archive index) lives in that extension's own module, not in `core`.

Extensions are migrated in from their standalone repos under review — see
[../MIGRATION.md](../MIGRATION.md).
