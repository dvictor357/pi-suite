# Codebase Intelligence Integration Contract

How the bundled subagent extension and Quest share the codebase index through `core/`.

## Ownership Split

| Layer                       | Owner               | Role                                                                                                |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| Scanner (`indexer.ts`)      | extensions/subagent | Walk repo, parse imports/exports/symbols with regex, build dep/revDep maps. Node built-ins only.    |
| Cache (`cache.ts`)          | extensions/subagent | Read/write `.pi/codebase-index.json`, staleness detection via mtime + SHA-256. Node built-ins only. |
| Query engine (`query.ts`)   | extensions/subagent | `scanIndex`, `queryFiles`, `depMap`, `getImpact`. Pure functions on `IndexData`.                    |
| `codebase` tool             | extensions/subagent | Registers the tool in pi's tool registry. TypeBox params, concise results, and TUI renderers.       |
| Quest planning/verification | extensions/quest    | Reads `.pi/codebase-index.json` directly for pre-flight checks and post-task impact analysis.       |

The subagent extension writes the cache; Quest reads it tolerantly and retains its own
ranking. `core/codebase-contract.ts` owns the shared `IndexData` schema, version,
and cache path. No sibling package is required at runtime.

## Cache File

| Property            | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| **Location**        | `<repo-root>/.pi/codebase-index.json`                                     |
| **Format**          | JSON (pretty-printed, 2-space indent)                                     |
| **contractVersion** | `1`                                                                       |
| **Up to 50k files** | Cap is configurable via `maxFiles` option (`DEFAULT_MAX_FILES = 50_000`). |

## JSON Schema

```jsonc
{
  "contractVersion": 1, // bump on breaking schema changes
  "rootDir": "/absolute/path/to/repo",
  "scannedAt": 1719000000000, // epoch ms
  "fileCount": 156,
  "files": {
    // keyed by repo-relative posix path
    "src/foo.ts": {
      "path": "/abs/path/src/foo.ts",
      "name": "foo.ts",
      "relativePath": "src/foo.ts",
      "imports": [
        {
          "source": "./bar", // module specifier as written
          "names": ["barFn"], // imported names ([] for namespace)
          "isDefault": false,
          "isType": false,
          "resolved": "src/bar.ts", // "" if external or unresolved
        },
      ],
      "exports": [
        { "name": "fooFn", "kind": "named" }, // kind: named | default | type
      ],
      "symbols": [
        { "name": "fooFn", "kind": "function" },
        // kind: function | class | variable | type | interface | enum | other
      ],
      "mtime": 1719000000000, // file mtime at scan time (epoch ms)
      "hash": "abc123...", // SHA-256 of first 16 KiB
    },
  },
  "dependencies": {
    // forward: file → files it imports
    "src/foo.ts": ["src/bar.ts"],
  },
  "reverseDependencies": {
    // reverse: file → files that import it
    "src/bar.ts": ["src/foo.ts"],
  },
}
```

All paths are posix-style repo-relative. `dependencies` and `reverseDependencies` are complete (every indexed file has an entry, even if `[]`).

## Codebase Tool

Registered as `codebase` in the main session. Parameters (TypeBox):

| Parameter   | Type         | Description                                                                           |
| ----------- | ------------ | ------------------------------------------------------------------------------------- |
| `operation` | `StringEnum` | `"scan"` \| `"query"` \| `"map"` \| `"impact"` (default: `"query"`)                   |
| `pattern`   | `string`     | Search string for `query`. Matches paths, names, symbols, exports (case-insensitive). |
| `file`      | `string`     | Repo-relative path for `map` and `impact`.                                            |
| `force`     | `boolean`    | Skip staleness check and re-scan. Default: `false`.                                   |

### Operations

| Operation  | Requires  | Returns                                                                                                     |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| **scan**   | —         | Full file list with symbols and exports for each file. Always refreshes the index.                          |
| **query**  | `pattern` | Files matching pattern (path, name, symbol, or export). Empty array if none found.                          |
| **map**    | `file`    | Single file's dependencies (`deps[]`) and reverse dependencies (`revDeps[]`) with import/export details.    |
| **impact** | `file`    | Transitive closure of reverse dependencies — all files that depend on the target. BFS through revDep graph. |

### Result shape (AgentToolResult details)

```typescript
interface CodebaseDetails {
  operation: string;
  rootDir: string;
  rescanned: boolean;
  indexSummary: {
    rootDir: string;
    scannedAt: number;
    fileCount: number;
    contractVersion: number;
  };
  results: Array<{
    relativePath: string;
    name: string;
    symbols: string[];
    exports: string[];
    imports?: string[]; // map only
    dependencies?: string[]; // map only
    reverseDependencies?: string[]; // map only
    impact?: string[]; // impact operation only
  }>;
  resultCount: number;
  error?: string;
}
```

## Staleness Rules

The cache auto-refreshes when any of these are true:

1. **No cache file** — `.pi/codebase-index.json` is missing.
2. **Schema mismatch** — `contractVersion` in cache > `CODEBASE_CONTRACT_VERSION` (future version from a newer pi-minions).
3. **Root mismatch** — cached `rootDir` differs from current cwd.
4. **File changes** — mtime differs AND the SHA-256 of the first 16 KiB doesn't match.
5. **New files** — source files on disk that aren't in the cache.
6. **Deleted files** — cache entries whose source files no longer exist.
7. **Force flag** — `force: true` is passed to the tool.

When staleness is detected, the entire index is rebuilt (no incremental update).

## Limitations

- **Regex-based parsing only.** Imports, exports, and symbols are extracted with regular expressions — not a full TypeScript AST. Complex syntax (template literal types, conditional types in exports, dynamic imports, `require()` calls) will be missed. Declaration merging and re-exports (`export * from`) are not tracked.
- **No type-level dependencies.** Only `import`/`export` statements create edges. A file that uses a type from another file without importing it (e.g., through global augmentation) won't show a dependency.
- **File-level granularity.** The dependency graph connects files, not individual symbols. Changing a single function in a utility file marks every consumer as impacted.
- **JS/TS only.** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` extensions only. No support for `.vue`, `.svelte`, `.css`, etc.
- **External dependencies are invisible.** `node_modules` imports are recorded in `imports[].source` but never resolved. The graph only covers repo-internal relationships.
- **No incremental cache updates.** The entire index is rebuilt when stale. For very large repos (50k+ files), scanning may be slow.
- **Hash is truncated.** Only the first 16 KiB of each file are hashed. Two files that differ only after 16 KiB won't be detected as changed by hash (mtime will catch them if it changed, but `touch`-only changes past 16 KiB may be missed).
- **No concurrency.** Scanning is synchronous and single-threaded (by design — no native dependencies).

## Bundled Agent

The `codebase-analyst` agent (`tier: reasoning`) ships in `extensions/subagent/agents/codebase-analyst.md`. It has no access to the `codebase` tool — instead it reads `.pi/codebase-index.json` directly with `read` and `grep`. Use it for:

- Architecture overviews
- Dependency questions ("who imports X?")
- Symbol search ("where is `foo` defined?")
- Refactoring impact analysis

## Example Quest Integration

A pi-suite quest uses the index for pre-flight checks before delegating work:

```yaml
# Quest planning step — assess change surface before worker dispatch
- tool: codebase
  params:
    operation: impact
    file: extensions/subagent/codebase/types.ts
  # → returns all files that import types.ts (transitive)
  # Quest can then warn: "Changing FileEntry will affect these 12 files"
```

```yaml
# Quest verification step — confirm no unexpected side effects
- tool: codebase
  params:
    operation: map
    file: extensions/subagent/index.ts
  # → returns dependencies + reverse deps
  # Quest can verify: "This file has 8 incoming deps — did you test all of them?"
```

```yaml
# Quest planning step — find relevant files for a task
- tool: codebase
  params:
    operation: query
    pattern: "codebase"
  # → returns all files with "codebase" in path/name/symbol/export
```

pi-suite can also read `.pi/codebase-index.json` directly to answer questions without invoking the tool — e.g., listing all entry points (files with no reverse dependencies), finding orphan files, or computing fan-in/fan-out stats for prioritization.
