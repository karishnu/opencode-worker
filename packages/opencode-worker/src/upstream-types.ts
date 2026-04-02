/**
 * Upstream-compatible type definitions.
 *
 * These mirror the shapes the stock OpenCode TUI / web client expects
 * from the server API.  Only the fields the client actually reads are
 * included — many optional upstream fields are omitted.
 */

// ── Session ───────────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  parentID?: string
  title: string
  version: string
  summary?: {
    additions: number
    deletions: number
    files: number
  }
  share?: { url: string }
  time: {
    created: number
    updated: number
    compacting?: number
    archived?: number
  }
  permission?: Record<string, unknown>
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}

// ── MessageV2 ─────────────────────────────────────────────────────

export interface MessageV2Info {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: {
    created: number
    updated: number
    completed?: number
  }
  // assistant-specific
  model?: {
    providerID: string
    modelID: string
  }
  system?: string
  agent?: string
  error?: {
    name: string
    message: string
  }
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost?: number
}

export interface MessageV2Part {
  id: string
  sessionID: string
  messageID: string
  type: string
  time: {
    created: number
    updated: number
  }
  // For text parts
  text?: string
  // For tool-call parts
  tool?: string
  input?: Record<string, unknown>
  state?: "pending" | "running" | "completed" | "error"
  output?: string
  error?: { name: string; message: string }
}

export interface MessageV2WithParts {
  info: MessageV2Info
  parts: MessageV2Part[]
}

// ── Config ────────────────────────────────────────────────────────

export interface ConfigInfo {
  theme?: string
  disabled_providers?: string[]
  enabled_providers?: string[]
  instructions?: string[]
  agents?: Record<string, AgentConfig>
  commands?: Record<string, unknown>
  mcp?: Record<string, unknown>
  experimental?: Record<string, unknown>
}

export interface AgentConfig {
  name?: string
  model?: string
  prompt?: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  color?: string
  steps?: number
  permission?: Record<string, unknown>
  options?: Record<string, unknown>
}

// ── Agent (runtime info, returned by GET /agent) ──────────────────

export interface AgentInfo {
  name: string
  config: AgentConfig
}

// ── Provider ──────────────────────────────────────────────────────

export interface ProviderModel {
  id: string
  name: string
  provider: string
  capabilities?: {
    input?: string[]
    output?: string[]
  }
  context_length?: number
  attachment?: boolean
  reasoning?: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

export interface ProviderInfo {
  id: string
  name: string
  models: Record<string, ProviderModel>
}

// ── Project ───────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string
  name: string
  worktree: string
  vcs?: string
  directory?: string
  icon?: string
  commands?: string[]
}

// ── Bus Events ────────────────────────────────────────────────────

export type BusEventPayload =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  | { type: "session.created"; properties: { sessionID: string; info: SessionInfo } }
  | { type: "session.updated"; properties: { sessionID: string; info: Partial<SessionInfo> } }
  | { type: "session.deleted"; properties: { sessionID: string; info: SessionInfo } }
  | {
      type: "message_v2.created"
      properties: { sessionID: string; info: MessageV2Info }
    }
  | {
      type: "message_v2.updated"
      properties: { sessionID: string; info: Partial<MessageV2Info> & { id: string; sessionID: string } }
    }
  | {
      type: "message_v2.part.updated"
      properties: { sessionID: string; part: MessageV2Part }
    }
  | {
      type: "session.status"
      properties: { sessionID: string; status: SessionStatus }
    }
  | { type: string; properties: Record<string, unknown> }

export interface SessionStatus {
  status: "idle" | "busy" | "error"
  providerID?: string
  modelID?: string
  agent?: string
}

// ── Helpers ───────────────────────────────────────────────────────

let _counter = 0
export function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  return `${base}-${(++_counter).toString(36)}`
}
