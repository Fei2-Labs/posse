# Directory Structure

> Domain-driven directory layout for Electron main process.

---

## Main Process Structure

```
src/main/
├── index.ts              # Main process entry
├── db/                   # Database layer
│   ├── client.ts         # Drizzle client initialization
│   ├── schema.ts         # All table schemas
│   └── migrate.ts        # Migration logic
├── ipc/                  # IPC handlers (thin layer)
│   ├── index.ts          # Register all handlers
│   ├── project.handler.ts
│   └── user.handler.ts
└── services/             # Business logic (domain-driven)
    ├── {domain}/         # One folder per domain
    │   ├── types.ts      # Zod schemas + TypeScript types (REQUIRED)
    │   ├── procedures/   # Endpoint handlers (REQUIRED)
    │   │   ├── create.ts
    │   │   ├── list.ts
    │   │   ├── get.ts
    │   │   ├── update.ts
    │   │   └── delete.ts
    │   └── lib/          # Shared business logic (OPTIONAL)
    │       ├── helpers.ts
    │       └── cache.ts
    ├── project/          # Example: Project domain
    │   ├── types.ts
    │   ├── procedures/
    │   │   ├── create.ts
    │   │   ├── list.ts
    │   │   ├── get.ts
    │   │   ├── update.ts
    │   │   └── delete.ts
    │   └── lib/
    │       └── cache.ts
    ├── user/             # Example: User domain
    │   ├── types.ts
    │   ├── procedures/
    │   │   ├── get.ts
    │   │   └── update.ts
    │   └── lib/
    │       └── helpers.ts
    └── logger.ts         # Shared logger (not a domain)
```

---

## Domain Examples

| Domain     | Description        | Example Procedures                          |
| ---------- | ------------------ | ------------------------------------------- |
| `project`  | Project management | `create`, `list`, `get`, `update`, `delete` |
| `user`     | User management    | `get`, `update`, `updateSettings`           |
| `auth`     | Authentication     | `login`, `logout`, `checkSession`           |
| `settings` | App settings       | `get`, `save`, `reset`                      |
| `file`     | File operations    | `read`, `write`, `list`, `delete`           |

---

## Shared Types Directory

```
src/shared/
├── constants/
│   ├── channels.ts       # IPC channel names
│   └── config.ts         # App configuration
└── types/
    ├── common.ts         # Shared utilities (e.g., createOutputSchema)
    ├── project.ts        # Project-related types
    └── user.ts           # User-related types
```

---

## Test Directory Structure

```
tests/
├── setup/
│   ├── global-setup.ts        # Test database initialization
│   └── test-helpers.ts        # Test utilities
├── factories/                 # Test data factories
│   ├── index.ts               # Barrel export + resetAllCounters()
│   ├── user.factory.ts
│   └── project.factory.ts
├── mocks/
│   └── electron.ts            # Electron API mocks
├── unit/                      # Mock-based unit tests
│   └── services/{domain}/
│       ├── lib/*.test.ts      # Utility function tests
│       └── procedures/*.test.ts
└── integration/               # Real database tests
    └── database/*.test.ts
```

---

## Test File Naming Convention

| Type             | Location                        | Naming                |
| ---------------- | ------------------------------- | --------------------- |
| Unit test        | `tests/unit/services/{domain}/` | `{file}.test.ts`      |
| Integration test | `tests/integration/{category}/` | `{feature}.test.ts`   |
| Factory          | `tests/factories/`              | `{entity}.factory.ts` |

---

## Key Principles

1. **One folder per domain** - Each business domain has its own folder
2. **types.ts is required** - Every domain must have Zod schemas and types
3. **procedures/ is required** - One file per action (create, get, list, etc.)
4. **lib/ is optional** - Only add when you have reusable logic
5. **IPC handlers are thin** - They only call procedures, no business logic

## Scenario: Canonical Git Project Identity

### 1. Scope / Trigger

Use this contract whenever project/session UI groups cwd values that may belong
to linked Git worktrees. Checkout cwd is execution state; canonical project path
is grouping state. Never replace a PTY, resume, file, or Git operation cwd with
the grouping path.

### 2. Signatures

```typescript
resolveGitProjectRoot(cwd: string): Promise<string>
resolveGitProjectRoots(cwds: string[]): Promise<Array<{
  cwd: string;
  canonicalPath: string;
}>>

POST /api/git/project-roots
body: { paths: string[] }
response: { roots: Array<{ cwd: string; canonicalPath: string }> }
```

Project-list records include `aliases: string[]`; each alias is a raw checkout
path grouped under the record's canonical `path`.

### 3. Contracts

- Resolve with `execFile('git', ['-C', cwd, 'rev-parse', ...])`, never a shell.
- Git common-dir is repository identity. For a non-bare, non-submodule common
  directory ending in `.git`, its parent is the canonical main checkout.
- Non-Git, missing, bare, submodule, timeout, and malformed-output cases keep
  the normalized input cwd.
- Resolution runs on the host owning the path. Remote desktop clients call the
  token-authenticated batch endpoint; they never run local Git on remote paths.
- Project aliases affect grouping/comparison only. Session cwd remains raw.
- Sanitize inherited `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, and
  `GIT_INDEX_FILE` before repository discovery.
- Apply one canonical pipeline to every path source, including persisted
  `extraFolders`; otherwise a stale saved checkout can recreate a second bucket
  after its history session was canonicalized.
- When a checkout was deleted, an explicit provider mapping may supply the
  canonical path only if the input is missing and Git returned it unchanged.
  Prefer durable checkout bindings; repository-name matching is allowed only
  when it uniquely identifies one registered project.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `paths` is not an array | HTTP 400 `paths-array-required` |
| More than 2000 paths | HTTP 413 `too-many-paths` |
| Empty, non-string, or >4096-char path | HTTP 400 `invalid-path` |
| Git unavailable/non-Git/timeout | Return input cwd as `canonicalPath` |
| Missing path + explicit unique provider mapping | Use mapped canonical path and retain missing path as alias |
| Existing path or Git resolved a different root | Ignore provider fallback; Git wins |
| Missing path with no/ambiguous provider mapping | Preserve input path; do not guess or delete |
| Old remote lacks endpoint | Client falls back one-to-one to input cwd |
| Separate clones share a remote | Keep separate; common dirs differ |

### 5. Good / Base / Bad Cases

- **Good**: linked worktree cwd aliases the main checkout project while PTY cwd
  remains the linked checkout.
- **Base**: normal checkout and ordinary non-Git folder map to themselves.
- **Bad**: grouping by folder name or remote URL merges unrelated clones and
  breaks when an agent changes its generated worktree naming.

### 6. Tests Required

- Temporary linked worktree resolves to its main checkout.
- Nested cwd inside that worktree resolves to the same checkout.
- Normal checkout and non-Git directory map to themselves.
- Separate clones of one source remain distinct.
- Inherited Git repository-selection environment variables do not reroot an
  unrelated cwd.
- Bucketing exposes raw worktree aliases under one canonical path.
- A deleted historical cwd supplied again through `extraFolders` produces one
  canonical bucket, not a stale duplicate.
- Unknown missing folders and ambiguous repository matches remain unchanged.

### 7. Wrong vs Correct

```typescript
// Wrong: path naming is product-specific and does not preserve clone identity.
const project = cwd.includes('copilot-worktrees') ? guessParent(cwd) : cwd;

// Correct: Git metadata supplies identity; cwd remains untouched for execution.
const canonicalPath = await resolveGitProjectRoot(cwd);
return { path: canonicalPath, aliases: [cwd, canonicalPath] };
```

---

## IPC Handler Example

```typescript
// src/main/ipc/project.handler.ts
import { ipcMain } from 'electron';
import { createProject } from '../services/project/procedures/create';
import { listProjects } from '../services/project/procedures/list';
import { IPC_CHANNELS } from '../../shared/constants/channels';

export function setupProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT.CREATE, (_, input) => createProject(input));
  ipcMain.handle(IPC_CHANNELS.PROJECT.LIST, (_, input) => listProjects(input));
}
```

---

## When to Create a New Domain

Create a new domain folder when:

- You have a new business concept (e.g., "tasks", "notes", "settings")
- You need multiple CRUD operations on an entity
- The logic is distinct from existing domains

Do NOT create a new domain for:

- Single utility functions (put in existing domain's `lib/`)
- Cross-cutting concerns (put in `services/` root, e.g., `logger.ts`)
