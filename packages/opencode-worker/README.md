# OpenCode Worker

A Cloudflare Workers-native port of the [OpenCode](https://github.com/anomalyco/opencode) server that uses [Agent Space](https://github.com/karishnu/cloudflare-git) as the remote workspace and execution environment.

## Architecture

```
Client ──HTTP/SSE──▶ Worker (Hono) ──RPC──▶ SessionDO (per session)
                                                │
                                         ┌──────┴──────┐
                                         │  Agent Loop  │
                                         │  (AI SDK v6) │
                                         └──────┬──────┘
                                                │
                              ┌─────────────────┼─────────────────┐
                              ▼                 ▼                 ▼
                        LLM Provider     WorkspaceAdapter    SSE Fanout
                     (Anthropic/OpenAI/   (Agent Space       (to clients)
                      Google)              REST API)
```

- **Session Durable Object** — One per session. Owns SQLite-backed metadata, message history, abort controller, and SSE event fanout.
- **Agent Loop** — Streams LLM responses via AI SDK `streamText`, executes tool calls against the workspace, and loops until the model produces a final text response (up to 25 tool rounds).
- **WorkspaceAdapter** — Translates tool calls (read, write, edit, glob, grep, list, patch, git\_commit, git\_log, git\_status) into Agent Space REST API calls.
- **SpaceManager** — Creates, lists, and deletes Agent Space instances via the management API.

## Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+
- A Cloudflare account with Workers & Durable Objects enabled
- An Agent Space instance (or the management API to create one)

## Setup

```bash
# From the repo root
npm install

# Set secrets (one-time)
cd packages/opencode-worker
npx wrangler secret put SERVER_PASSWORD
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY        # optional
npx wrangler secret put GOOGLE_API_KEY        # optional
npx wrangler secret put AGENT_SPACE_URL
npx wrangler secret put AGENT_SPACE_API_KEY
```

## Development

```bash
# Start local dev server
npm run dev

# Run tests
npm test

# Type check
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

## API Reference

All endpoints require Basic Auth when `SERVER_PASSWORD` is set (username defaults to `opencode`).

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/session` | Create a new session |
| `GET` | `/session/:id` | Get session info |
| `PATCH` | `/session/:id` | Update session (title) |
| `GET` | `/session/:id/messages` | Get message history |
| `POST` | `/session/:id/prompt` | Send a prompt (returns SSE stream) |
| `POST` | `/session/:id/abort` | Abort the current turn |
| `GET` | `/session/:id/events` | Subscribe to session events (SSE) |

#### Create Session

```bash
curl -X POST https://your-worker.workers.dev/session \
  -u opencode:$PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "spaceUrl": "https://your-space.workers.dev",
    "spaceApiKey": "your-space-key",
    "title": "My Session",
    "providerId": "anthropic",
    "modelId": "claude-sonnet-4-20250514"
  }'
```

#### Send Prompt (Streaming)

```bash
curl -N -X POST https://your-worker.workers.dev/session/$SESSION_ID/prompt \
  -u opencode:$PASSWORD \
  -H "Content-Type: application/json" \
  -d '{"content": "List all TypeScript files in the project"}'
```

### Spaces

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/space` | Create a new Agent Space |
| `GET` | `/space` | List spaces |
| `DELETE` | `/space/:id` | Delete a space |

### Misc

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/providers` | List configured LLM providers |

## SSE Event Types

Events are streamed as `data: {json}\n\n`:

| Event Type | Description |
|------------|-------------|
| `message.delta` | Partial text from the assistant |
| `message.completed` | Assistant message is complete |
| `tool.called` | A tool call was made |
| `tool.result` | A tool call returned a result |
| `session.created` | Session was initialized |
| `session.updated` | Session metadata changed |
| `done` | Turn completed successfully |
| `error` | An error occurred |

## Project Structure

```
packages/opencode-worker/
├── src/
│   ├── index.ts                 # Worker entrypoint (Hono app)
│   ├── env.ts                   # Env bindings interface
│   ├── types.ts                 # Shared types
│   ├── adapters/
│   │   ├── workspace-agent-space.ts   # WorkspaceAdapter → Agent Space
│   │   └── space-manager-agent-space.ts  # SpaceManager → Agent Space
│   ├── tools/
│   │   └── index.ts             # AI SDK tool definitions
│   ├── session/
│   │   ├── durable-object.ts    # SessionDO (Durable Object)
│   │   └── agent-loop.ts        # LLM agent loop
│   ├── provider/
│   │   └── registry.ts          # LLM provider registry
│   ├── routes/
│   │   ├── session.ts           # Session HTTP routes
│   │   ├── space.ts             # Space management routes
│   │   └── event.ts             # Health + provider routes
│   └── __tests__/               # Vitest tests
├── wrangler.toml
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

## Supported Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional line range |
| `write` | Create or overwrite a file |
| `edit` | Find-and-replace (unique match required) |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents by regex |
| `list` | List files, optionally by prefix |
| `patch` | Apply unified diffs |
| `git_commit` | Commit working tree changes |
| `git_log` | Show commit history |
| `git_status` | Show modified files |
| `bash` | Stub — returns an error (not available in Workers) |

## License

See the root repository for license information.
