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
}

// ── Space Manager Interface ─────────────────────────────────────────

export interface SpaceInfo {
  name: string
  url: string
  apiKey?: string
}

export interface SpaceManager {
  createSpace(name: string): Promise<{ url: string; apiKey: string }>
  listSpaces(): Promise<SpaceInfo[]>
  deleteSpace(nameOrId: string): Promise<void>
}

// ── Session Types ───────────────────────────────────────────────────

/** @deprecated Use SessionInfo from upstream-types.ts for API responses */
export interface InternalSessionInfo {
  id: string
  title: string
  spaceUrl: string
  // apiKey stored only in DO metadata, never leaked to responses
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

// ── Event Types ─────────────────────────────────────────────────────

export type SessionEvent =
  | { type: "session.created"; session: InternalSessionInfo }
  | { type: "session.updated"; session: Partial<InternalSessionInfo> & { id: string } }
  | { type: "message.created"; message: SessionMessage }
  | { type: "message.delta"; sessionId: string; messageId: string; delta: string }
  | { type: "message.completed"; sessionId: string; messageId: string }
  | { type: "tool.called"; sessionId: string; messageId: string; tool: ToolCallInfo }
  | { type: "tool.result"; sessionId: string; messageId: string; result: ToolResultInfo }
  | { type: "error"; sessionId?: string; error: string }
  | { type: "done"; sessionId: string }
