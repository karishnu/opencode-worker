# AGENTS.md — OpenCode Worker

## Project Overview

This is **opencode-worker**, a Cloudflare Workers-native port of [OpenCode](https://github.com/anomalyco/opencode) that runs entirely on Cloudflare's edge infrastructure. The upstream OpenCode server (Bun/Node) is replaced by a single Cloudflare Worker with two Durable Object classes — one for sessions, one for agent spaces (isolated filesystem + git workspaces).

- **Monorepo root**: `/` (npm workspaces)
- **Worker package**: `packages/opencode-worker/`
- **Upstream submodule**: `upstream/opencode/` (branch: `dev`)
- **TypeScript path alias**: `@upstream/*` → `upstream/opencode/packages/opencode/src/*`

## Architecture

```
Client (TUI / Web) ──HTTP/SSE──▶ Worker (Hono)
                                    │
                       ┌────────────┴────────────┐
                       ▼                         ▼
                  SessionDO                   SpaceDO
               (single "main")          (one per named space)
                    │                         │
              ┌─────┴──────┐           ┌──────┴──────┐
              │ Agent Loop  │           │ @cloudflare │
              │ (AI SDK v6) │           │   /shell    │
              └─────┬──────┘           └──────┬──────┘
                    │                         │
         ┌──────────┼──────────┐       ┌──────┴──────┐
         ▼          ▼          ▼       ▼             ▼
    LLM Provider  Tools    SSE Fan  Filesystem    Git Repo
   (Anthropic/   (DO RPC   -out    (SQLite)    (isomorphic
    OpenAI/       to                             -git)
    Google)      SpaceDO)
```

### Key Components

- **SessionDO** (`src/session/durable-object.ts`) — Single "main" Durable Object instance. Owns all sessions, SQLite-backed metadata, message history, session↔space mappings, abort controller, and SSE event fanout to connected clients.
- **SpaceDO** (`src/space/durable-object.ts`) — One per named space. Provides isolated filesystem + git repo via `@cloudflare/shell`. Exposes RPC methods for file I/O, git operations, and deployments. Also handles Git Smart HTTP protocol and Dynamic Worker preview serving.
- **Agent Loop** (`src/session/agent-loop.ts`) — Streams LLM responses via AI SDK `streamText`, uses `convertToModelMessages` + `toUIMessages()` for history, executes tool calls against SpaceDO via DO RPC, loops up to 25 tool rounds.
- **Tools** (`src/tools/index.ts`) — AI SDK tool definitions. Workspace tools require a `space` parameter. Space management tools (`create_space`, `attach_space`, etc.) manage session↔space mappings. Spaces auto-initialize on first use.
- **Provider Registry** (`src/provider/registry.ts`) — Resolves LLM provider + model ID to a `LanguageModelV3` instance. Supports Cloudflare AI Gateway passthrough when configured.
- **Deploy Engine** (`src/space/deploy-engine.ts`) — Builds code from a git branch using `@cloudflare/worker-bundler`, stores compiled modules in SQLite, serves previews via Dynamic Workers (`WorkerLoader`).
- **Git Smart HTTP** (`src/space/git-smart-http.ts`) — Full git clone/push support over HTTP. External git clients can interact with spaces via `/space/:name/repo.git/*`.

### Durable Object Communication

SessionDO → SpaceDO communication uses **DO RPC** (same worker, no HTTP). The `resolveSpace()` helper in `tools/index.ts` gets a typed stub via `env.SPACE_DO.idFromName(spaceName)`. This means all tool calls are zero-latency co-located RPC.

### SSE Event Protocol

The worker implements the upstream OpenCode SSE protocol so the stock TUI and web client can connect without modification. Events are broadcast from a single SessionDO instance to all connected SSE writers. Key event types:

- `message.updated` — Message info created/updated
- `message.part.updated` — Part created/updated (text, tool, reasoning, step-start, step-finish)
- `message.part.delta` — Incremental text/reasoning delta
- `session.status` — Busy/idle state transitions
- `session.updated` / `session.deleted` — Session lifecycle

### Route Structure

Routes are mounted to match the upstream OpenCode server so the stock client connects without changes:

- `/session/*` — Session CRUD, messages, prompts
- `/event` — SSE event stream (forwarded to SessionDO)
- `/provider/*` — LLM provider listing
- `/global/*`, `/project/*`, `/config/*` — Upstream-compatible stubs
- `/agent`, `/skill`, `/path`, `/vcs`, `/lsp`, etc. — Stub routes returning valid defaults
- `/space/*` — Space management (non-upstream extension)
- `/space/:name/repo.git/*` — Git Smart HTTP (forwarded to SpaceDO)
- `/space/:name/preview/:branch/*` — Dynamic Worker preview (forwarded to SpaceDO)

## Development

```bash
# From repo root
npm install

# Dev server (from packages/opencode-worker/)
npm run dev        # or: npx wrangler dev

# Type check
npm run typecheck  # or: npx tsc --noEmit

# Tests
npm test           # or: npx vitest run
```

Tests use `@cloudflare/vitest-pool-workers` and run inside the Workers runtime. Run from `packages/opencode-worker/`, not the repo root.

## Style Guide

### General

- Prefer `const` over `let`; use ternaries or early returns instead of reassignment
- Avoid `else` — use early returns
- Avoid `try`/`catch` where possible
- Prefer single-word variable names (`cfg`, `err`, `opts`, `dir`, `state`)
- Prefer functional array methods (`flatMap`, `filter`, `map`) over `for` loops
- Rely on type inference; avoid explicit annotations unless necessary for exports
- Avoid unnecessary destructuring; use dot notation to preserve context

### Workers-Specific

- No `Bun` APIs — this runs on Cloudflare Workers
- Use `crypto.randomUUID()` for UUIDs
- Use `ctx.storage.sql` for SQLite in Durable Objects
- Use DO RPC (typed stubs) for cross-DO communication, not HTTP fetch
- Environment bindings are typed in `src/env.ts`
- Secrets are set via `wrangler secret put`, never hardcoded

### Upstream Compatibility

- Route paths must match upstream OpenCode server exactly
- SSE event shapes must match upstream `BusEventPayload` types
- StoredMessage/StoredPart shapes must be compatible with upstream TUI parsing
- When upstream client expects an endpoint, return a valid stub (see `routes/stubs.ts`)

## File Map

```
packages/opencode-worker/
├── src/
│   ├── index.ts                    # Worker entrypoint (Hono app, middleware, route mounting)
│   ├── env.ts                      # Env bindings interface (DO, secrets, vars)
│   ├── types.ts                    # StoredMessage, StoredPart, SessionEvent, ToolCallInfo
│   ├── upstream-types.ts           # Types mirroring upstream client expectations
│   ├── bus.ts                      # In-memory event bus (BusEventPayload pub/sub)
│   ├── session/
│   │   ├── durable-object.ts       # SessionDO — sessions, messages, SSE, agent orchestration
│   │   └── agent-loop.ts           # LLM agent loop (streamText, toUIMessages, tool rounds)
│   ├── space/
│   │   ├── durable-object.ts       # SpaceDO — @cloudflare/shell filesystem + git + deploy
│   │   ├── deploy-engine.ts        # Build + deploy branches as Dynamic Workers
│   │   ├── git-smart-http.ts       # Git Smart HTTP protocol (clone, push, info/refs)
│   │   └── git-pack.ts             # Git packfile encoding/decoding helpers
│   ├── tools/
│   │   └── index.ts                # AI SDK tool definitions (workspace + space management)
│   ├── provider/
│   │   └── registry.ts             # LLM provider registry (direct + AI Gateway)
│   ├── routes/
│   │   ├── session.ts              # /session/* — CRUD, messages, prompt
│   │   ├── space.ts                # /space/* — space info, creation
│   │   ├── provider.ts             # /provider/* — list providers + models
│   │   ├── global.ts               # /global/* — upstream-compatible globals
│   │   ├── project.ts              # /project/* — project info stub
│   │   ├── config.ts               # /config/* — config stub
│   │   └── stubs.ts                # Stub routes for unsupported upstream endpoints
│   └── __tests__/                  # Vitest tests (Workers pool)
├── wrangler.toml                   # Worker config, DO bindings, migrations
├── tsconfig.json                   # TypeScript config with @upstream/* alias
├── vitest.config.ts                # Vitest config for Workers pool
└── package.json                    # Dependencies and scripts
```

## Key Dependencies

- **`hono`** — HTTP framework (routing, middleware, CORS, basic auth)
- **`ai`** (Vercel AI SDK v6) — `streamText`, `convertToModelMessages`, `tool`, `UIMessage`
- **`@ai-sdk/anthropic`**, **`@ai-sdk/openai`**, **`@ai-sdk/google`** — LLM providers
- **`ai-gateway-provider`** — Cloudflare AI Gateway integration
- **`@cloudflare/shell`** — In-DO filesystem + git (Workspace, WorkspaceFileSystem, createGit)
- **`@cloudflare/worker-bundler`** — Bundle TypeScript → Worker modules for Dynamic Workers
- **`zod`** — Input validation for tool schemas
- **`ulid`** — Sortable unique IDs

## Secrets

Set via `wrangler secret put <NAME>`:

| Secret | Required | Description |
|--------|----------|-------------|
| `SERVER_PASSWORD` | No | Basic auth password (username defaults to `opencode`) |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `GOOGLE_API_KEY` | No | Google AI API key |
| `CLOUDFLARE_ACCOUNT_ID` | No | For AI Gateway routing |
| `CLOUDFLARE_GATEWAY_ID` | No | AI Gateway slug |
| `CLOUDFLARE_API_TOKEN` | No | AI Gateway auth token |

\* At least one LLM provider key is required. When AI Gateway is configured, provider keys become optional (gateway handles auth).
