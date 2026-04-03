/**
 * Shared types for the OpenCode Worker.
 */

// ── Workspace Adapter Types ─────────────────────────────────────────

export interface FileEntry {
  path: string
  mtime: number
}

export interface GrepMatch {
  path: string
  line: number
  content: string
}

export interface CommitResult {
  sha: string
  message: string
}

export interface CommitLogEntry {
  sha: string
  message: string
  author: string
  date: string
}

export interface GitStatusEntry {
  path: string
  mtime: number
}

export interface PatchResult {
  applied: string[]
  failed: string[]
}

// ── Workspace Adapter Interface ─────────────────────────────────────

export interface WorkspaceAdapter {
  readFile(path: string, opts?: { offset?: number; limit?: number }): Promise<string>
  writeFile(path: string, content: string): Promise<{ path: string; size: number }>
  editFile(path: string, oldString: string, newString: string): Promise<{ path: string; size: number }>
  glob(pattern: string): Promise<string[]>
  grep(query: string, include?: string): Promise<GrepMatch[]>
  list(prefix?: string): Promise<FileEntry[]>
  patch(diff: string): Promise<PatchResult>
  gitCommit(message: string, author?: { name: string; email: string }): Promise<CommitResult>
  gitLog(limit?: number): Promise<CommitLogEntry[]>
  gitStatus(): Promise<GitStatusEntry[]>
  deploy(branch: string): Promise<DeployResult>
  undeploy(branch: string): Promise<UndeployResult>
  listDeployments(): Promise<DeploymentInfo[]>
  getDeployment(branch: string): Promise<DeploymentInfo>
}

// ── Deployment Types ────────────────────────────────────────────────

export interface DeployResult {
  branch: string
  url?: string
  [key: string]: unknown
}

export interface UndeployResult {
  branch: string
  [key: string]: unknown
}

export interface DeploymentInfo {
  branch: string
  [key: string]: unknown
}

// ── Space Manager Interface ─────────────────────────────────────────

export interface SpaceInfo {
  name: string
  scriptName?: string
  url: string
  apiKey?: string
  createdOn?: string
  modifiedOn?: string
}

export interface SpaceManager {
  createSpace(name: string, apiKey?: string): Promise<{ name: string; url: string; apiKey: string }>
  listSpaces(): Promise<SpaceInfo[]>
  deleteSpace(name: string): Promise<void>
}

// ── Session ↔ Space Mapping (many-to-many) ──────────────────────────

export interface SpaceMapping {
  sessionId: string
  spaceName: string
  spaceUrl: string
  spaceApiKey: string
}

// ── Session Types ───────────────────────────────────────────────────

/** @deprecated Use SessionInfo from upstream-types.ts for API responses */
export interface InternalSessionInfo {
  id: string
  title: string
  modelId: string
  providerId: string
  createdAt: number
  updatedAt: number
}

export interface SessionMessage {
  id: string
  sessionId: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  toolCalls?: ToolCallInfo[]
  toolResults?: ToolResultInfo[]
  createdAt: number
}

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResultInfo {
  callId: string
  name: string
  result: string
  isError?: boolean
}

// ── Stored Message Types (shared between DO and agent-loop) ─────────

export type StoredPart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  time?: { start: number; end?: number }
  reason?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  callID?: string
  tool?: string
  state?: {
    status: string
    input: Record<string, unknown>
    raw?: string
    title?: string
    output?: string
    metadata?: Record<string, unknown>
    time?: { start: number; end?: number }
    error?: string
  }
  metadata?: Record<string, unknown>
  snapshot?: string
}

export interface StoredMessage {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    agent: string
    model?: { providerID: string; modelID: string }
    parentID?: string
    modelID?: string
    providerID?: string
    mode?: string
    path?: { cwd: string; root: string }
    cost?: number
    tokens?: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
    finish?: string
    summary?: { diffs: unknown[] }
    error?: unknown
  }
  parts: StoredPart[]
}

// ── Event Types ─────────────────────────────────────────────────────

export type SessionEvent =
  | { type: "session.created"; session: InternalSessionInfo }
  | { type: "session.updated"; session: Partial<InternalSessionInfo> & { id: string } }
  | { type: "message.created"; message: SessionMessage }
  | { type: "text.start"; sessionId: string; messageId: string }
  | { type: "text.end"; sessionId: string; messageId: string }
  | { type: "message.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "message.completed"; sessionId: string; messageId: string }
  | { type: "tool.called"; sessionId: string; messageId: string; tool: ToolCallInfo }
  | { type: "tool.result"; sessionId: string; messageId: string; result: ToolResultInfo }
  | { type: "error"; sessionId?: string; error: string }
  | { type: "done"; sessionId: string }
