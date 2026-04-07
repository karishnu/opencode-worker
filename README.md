# OpenCode Worker

A Cloudflare Workers-native port of the [OpenCode **server**](https://github.com/anomalyco/opencode) that runs **entirely on Cloudflare's edge** — no servers, no containers, no VMs. Sessions, filesystems, git repos, LLM orchestration, and live deployment previews all live inside Durable Objects on the same Worker.

The stock [OpenCode TUI](https://github.com/anomalyco/opencode) and web client connect to this worker **unmodified** — all route paths and SSE event shapes match upstream exactly.

---

## Usage

### 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/karishnu/opencode-worker)

### 2. Connect

```bash
opencode attach https://your-worker.workers.dev
```

If you set a `SERVER_PASSWORD` secret, include credentials:

```bash
opencode attach https://opencode:yourpassword@your-worker.workers.dev
```

---

## Why

The upstream OpenCode server assumes a local machine with Bun, a real filesystem, and shell access. **opencode-worker** replaces all of that with Cloudflare primitives:

| Upstream Server (Bun/Node) | This Worker |
|---|---|
| Local filesystem | `@cloudflare/shell` Workspace (SQLite-backed, in Durable Object) |
| Git CLI | `isomorphic-git` via `@cloudflare/shell/git` |
| Shell/Bash execution | Not available (tools return error stubs) |
| Single-user process | Multi-session, multi-space, SSE fanout to many clients |
| Deploy via CLI | `@cloudflare/worker-bundler` → Dynamic Workers (live preview URLs) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (Hono)                      │
│                                                                  │
│  ┌─ Middleware ──────────────────────────────────────────────┐   │
│  │  CORS → Basic Auth → Request Logging                      │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Routes ────────────────────────────────────────────────-─┐   │
│  │  /session/*    → Session CRUD, messages, prompts          │   │
│  │  /event        → SSE stream (→ SessionDO)                 │   │
│  │  /provider/*   → LLM provider listing                     │   │
│  │  /space/*      → Space management REST API                │   │
│  │  /space/:n/repo.git/* → Git Smart HTTP (→ SpaceDO)        │   │
│  │  /space/:n/preview/:b/* → Dynamic Worker preview (→ SpaceDO)  │
│  │  /global, /project, /config, /agent, /vcs, ...  → Stubs   │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ Durable Objects ───────────────────────────────────────-─┐   │
│  │                                                           │   │
│  │  SessionDO (single "main" instance)                       │   │
│  │  ├── SQLite: sessions, messages, session_meta,            │   │
│  │  │           session_spaces                               │   │
│  │  ├── SSE fanout to connected clients                      │   │
│  │  ├── Agent loop (AI SDK v6 streamText)                    │   │
│  │  └── Abort controller for cancellation                    │   │
│  │                                                           │   │
│  │  SpaceDO (one per named space)                            │   │
│  │  ├── @cloudflare/shell Workspace (SQLite filesystem)      │   │
│  │  ├── isomorphic-git repo (init, commit, log, status, etc) │   │
│  │  ├── Deploy engine (worker-bundler → Dynamic Workers)     │   │
│  │  ├── Git Smart HTTP (clone, push, fetch)                  │   │
│  │  └── SQLite: deployments, refs, git_internal              │   │
│  │                                                           │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Component Details

#### SessionDO — The Brain

A **single** Durable Object instance (named `"main"`) manages all sessions. This keeps SSE connections, message broadcasting, and session state in one isolate.

- **SQLite tables**: `sessions`, `messages`, `session_meta`, `session_spaces`
- **SSE fanout**: Maintains a `Set<WritableStreamDefaultWriter>` for all connected clients; broadcasts events on every state change
- **Agent loop**: Spawns `runAgentLoop()` which streams LLM responses, executes tools via DO RPC to SpaceDO, and loops until the model produces a final text response
- **Session ↔ Space mappings**: Many-to-many — a session can have multiple spaces attached, and the LLM agent manages this dynamically via `create_space`, `attach_space`, `detach_space` tools

#### SpaceDO — Isolated Workspaces

Each named space is a separate Durable Object with its own:

- **Filesystem**: `@cloudflare/shell` `Workspace` backed by DO SQLite — full POSIX-like file I/O
- **Git repo**: `isomorphic-git` via `@cloudflare/shell/git` — init, add, commit, log, status, checkout, branch, diff
- **Deploy engine**: `@cloudflare/worker-bundler` compiles TypeScript into Worker modules, stores them in SQLite, and serves them via `WorkerLoader` (Dynamic Workers) at `/space/:name/preview/:branch/`
- **Git Smart HTTP**: Full `git clone` / `git push` support over HTTP at `/space/:name/repo.git/*`

#### DO RPC — Zero-Latency Communication

SessionDO calls SpaceDO methods via **Durable Object RPC** (typed stubs, same worker), not HTTP fetch. This means tool calls like `read`, `write`, `grep`, `git_commit` are co-located same-isolate function calls with no network overhead:

```ts
const id = env.SPACE_DO.idFromName(spaceName)
const stub = env.SPACE_DO.get(id) as DurableObjectStub<SpaceDO>
const content = await stub.readFile("src/index.ts")
```

#### Provider Registry — Multi-LLM Support

Supports three providers with two modes:

- **Direct**: Each provider requires its own API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
- **AI Gateway**: When `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` + `CLOUDFLARE_API_TOKEN` are set, all requests route through Cloudflare AI Gateway for observability, caching, and rate limiting. Provider keys become optional (gateway handles auth via stored keys).

---

## Prerequisites

- **Node.js** 20+
- **Wrangler CLI** v4+ (`npm install -g wrangler`)
- A **Cloudflare account** with Workers & Durable Objects enabled
- At least one **LLM provider API key** (Anthropic, OpenAI, or Google)

---

## Manual Setup

If you prefer to deploy manually instead of the one-click button:

### 1. Clone & Install

```bash
git clone --recurse-submodules https://github.com/karishnu/opencode-worker.git
cd opencode-worker
npm install
```

### 2. Configure Secrets

```bash
cd packages/opencode-worker

# Required: at least one LLM provider
npx wrangler secret put ANTHROPIC_API_KEY

# Optional: additional providers
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_API_KEY

# Optional: API authentication
npx wrangler secret put SERVER_PASSWORD

# Optional: Cloudflare AI Gateway
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_GATEWAY_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

### 3. Deploy

```bash
npm run deploy
```

---

## Development

```bash
# Start local dev server (from packages/opencode-worker/)
npm run dev

# Run tests (Workers runtime via @cloudflare/vitest-pool-workers)
npm test

# Type check
npm run typecheck
```

From the repo root, workspace scripts forward to the worker package:

```bash
npm run dev      # → packages/opencode-worker
npm run deploy   # → packages/opencode-worker
npm test         # → packages/opencode-worker
```

---

## Tools

The LLM agent has access to the following tools. All workspace tools require a `space` parameter to target a specific named space.

### Workspace Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional line range (1-indexed offset + limit) |
| `write` | Create or overwrite a file |
| `edit` | Find-and-replace exact string in a file (must be unique match) |
| `glob` | Find files matching a glob pattern |
| `grep` | Search file contents by regex with optional file filter |
| `list` | List files and directories, optionally by path prefix |
| `patch` | Apply unified diffs to one or more files |

### Git Tools

| Tool | Description |
|------|-------------|
| `git_commit` | Stage all files and commit with message |
| `git_log` | View commit history (configurable depth) |
| `git_status` | Show modified/staged/untracked files |

### Deploy Tools

| Tool | Description |
|------|-------------|
| `deploy` | Build and deploy a git branch as a Dynamic Worker preview |
| `undeploy` | Remove a branch deployment |
| `list_deployments` | List all active branch deployments |
| `get_deployment` | Get deployment metadata for a branch |

### Space Management Tools

| Tool | Description |
|------|-------------|
| `create_space` | Create a new space and attach to session |
| `delete_space` | Detach and delete a space |
| `attach_space` | Attach an existing space to session |
| `detach_space` | Detach a space from session (doesn't delete) |
| `list_session_spaces` | List all spaces attached to current session |

### HTTP Tools

| Tool | Description |
|------|-------------|
| `curl` | Make HTTP requests (GET, POST, etc.) to APIs or preview URLs |

### Stubs

| Tool | Description |
|------|-------------|
| `bash` | Returns error (shell not available in Workers) |

---

## Project Structure

```
opencode-worker/
├── packages/
│   └── opencode-worker/
│       ├── src/
│       │   ├── index.ts                    # Worker entrypoint (Hono app, middleware, routes)
│       │   ├── env.ts                      # Env bindings interface (DOs, secrets, vars)
│       │   ├── types.ts                    # StoredMessage, StoredPart, SessionEvent, ToolCallInfo
│       │   ├── upstream-types.ts           # Types mirroring upstream client expectations
│       │   ├── bus.ts                      # In-memory event bus (BusEventPayload pub/sub)
│       │   ├── session/
│       │   │   ├── durable-object.ts       # SessionDO — sessions, messages, SSE, agent loop
│       │   │   └── agent-loop.ts           # LLM agent loop (streamText, toUIMessages, tool rounds)
│       │   ├── space/
│       │   │   ├── durable-object.ts       # SpaceDO — filesystem + git + deploy + preview
│       │   │   ├── deploy-engine.ts        # Build branches → Dynamic Workers via worker-bundler
│       │   │   ├── git-smart-http.ts       # Git Smart HTTP protocol (clone, push, info/refs)
│       │   │   └── git-pack.ts             # Git packfile encoding/decoding helpers
│       │   ├── tools/
│       │   │   └── index.ts                # AI SDK tool definitions (workspace + space mgmt)
│       │   ├── provider/
│       │   │   └── registry.ts             # LLM provider registry (direct + AI Gateway)
│       │   ├── routes/
│       │   │   ├── session.ts              # /session/* — CRUD, messages, prompt
│       │   │   ├── space.ts                # /space/* — space info, creation
│       │   │   ├── provider.ts             # /provider/* — list providers + models
│       │   │   ├── global.ts               # /global/* — upstream-compatible globals
│       │   │   ├── project.ts              # /project/* — project info stub
│       │   │   ├── config.ts               # /config/* — config stub
│       │   │   └── stubs.ts                # Stub routes (/agent, /vcs, /lsp, /mcp, etc.)
│       │   └── __tests__/                  # Vitest tests (Workers runtime pool)
│       ├── wrangler.toml                   # Worker config, DO bindings, migrations
│       ├── tsconfig.json                   # TypeScript config with @upstream/* alias
│       ├── vitest.config.ts                # Vitest config for Workers pool
│       └── package.json                    # Dependencies and scripts
├── upstream/
│   └── opencode/                           # Git submodule → github.com/anomalyco/opencode (dev)
├── package.json                            # Monorepo root (npm workspaces)
└── AGENTS.md                               # AI agent coding guidelines
```

---

## Secrets Reference

Set via `wrangler secret put <NAME>`:

| Secret | Required | Description |
|--------|----------|-------------|
| `SERVER_PASSWORD` | No | Basic auth password (username defaults to `opencode`) |
| `SERVER_USERNAME` | No | Basic auth username (defaults to `opencode`) |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `GOOGLE_API_KEY` | No | Google AI API key |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account ID (for AI Gateway) |
| `CLOUDFLARE_GATEWAY_ID` | No | AI Gateway slug |
| `CLOUDFLARE_API_TOKEN` | No | Cloudflare API token (for AI Gateway) |

\* At least one LLM provider key is required. When AI Gateway is configured, provider keys become optional.

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| [`hono`](https://hono.dev) | HTTP framework (routing, CORS, basic auth) |
| [`ai`](https://sdk.vercel.ai) (v6) | `streamText`, `convertToModelMessages`, `tool`, `UIMessage` |
| [`@ai-sdk/anthropic`](https://www.npmjs.com/package/@ai-sdk/anthropic) | Anthropic provider |
| [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) | OpenAI provider |
| [`@ai-sdk/google`](https://www.npmjs.com/package/@ai-sdk/google) | Google AI provider |
| [`ai-gateway-provider`](https://www.npmjs.com/package/ai-gateway-provider) | Cloudflare AI Gateway integration |
| [`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell) | In-DO filesystem + git |
| [`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler) | Bundle TS → Worker modules for Dynamic Workers |
| [`zod`](https://zod.dev) | Tool input validation |
| [`ulid`](https://www.npmjs.com/package/ulid) | Sortable unique IDs |

---

## License

See the root repository for license information.
