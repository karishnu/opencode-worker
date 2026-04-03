import { DurableObject } from "cloudflare:workers"
import type { Env } from "../env"
import type { SessionMessage, SessionEvent } from "../types"
import { getLanguageModel } from "../provider/registry"
import { AgentSpaceWorkspaceAdapter } from "../adapters/workspace-agent-space"
import { createTools } from "../tools"
import { runAgentLoop } from "./agent-loop"

// ── Sortable ID generation (compatible with OpenCode TUI) ─────────

let lastTimestamp = 0
let idCounter = 0

function generateId(prefix: "msg" | "prt" | "ses"): string {
  const currentTimestamp = Date.now()
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    idCounter = 0
  }
  idCounter++
  const now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter)
  const timeBytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }
  const timeHex = Array.from(timeBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let randomPart = ""
  for (let i = 0; i < 14; i++) {
    randomPart += chars[Math.floor(Math.random() * 62)]
  }
  return `${prefix}_${timeHex}${randomPart}`
}

// ── Stored message shape (matches TUI expectations) ───────────────

interface StoredMessage {
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
  }
  parts: Array<StoredPart>
}

type StoredPart = {
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
  // tool part fields (upstream shape)
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
}

interface Session {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  time: { created: number; updated: number }
}

interface PromptRequest {
  parts?: Array<{ type: string; text?: string }>
  content?: string
  model?: { providerID: string; modelID: string }
  providerID?: string
  modelID?: string
  agent?: string
  messageID?: string
}

/**
 * Session Durable Object — single "main" instance.
 *
 * Handles ALL sessions in one DO so SSE connections and message
 * broadcasting share the same isolate. Follows the architecture
 * from southpolesteve/opencode-do.
 */
export class SessionDO extends DurableObject<Env> {
  private sseWriters: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set()
  private encoder = new TextEncoder()
  private abortController: AbortController | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        data TEXT NOT NULL
      )
    `)
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)`,
    )
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `)
  }

  // ── fetch() — routes SSE + message requests ────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // SSE event stream
    if (path === "/event" && request.method === "GET") {
      return this.handleSSE()
    }

    // POST /session/:id/message — send prompt
    const msgMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (msgMatch) {
      if (request.method === "POST") {
        return this.handleMessage(request, msgMatch[1])
      }
      if (request.method === "GET") {
        return this.handleGetMessages(msgMatch[1], url.searchParams)
      }
    }

    return new Response("Not found", { status: 404 })
  }

  // ── SSE Management ─────────────────────────────────────────────

  private handleSSE(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()

    this.sseWriters.add(writer)
    console.log("SSE connection opened, total:", this.sseWriters.size)

    // Send initial connected event
    writer.write(
      this.encoder.encode(this.formatSSE({ type: "server.connected", properties: {} })),
    )

    // Keep-alive ping every 15s
    const pingInterval = setInterval(async () => {
      try {
        await writer.write(this.encoder.encode(": ping\n\n"))
      } catch {
        clearInterval(pingInterval)
        this.sseWriters.delete(writer)
        console.log("SSE ping failed, cleaning up. Remaining:", this.sseWriters.size)
      }
    }, 15_000)

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  private formatSSE(data: object): string {
    return `event: message\ndata: ${JSON.stringify(data)}\n\n`
  }

  async broadcast(data: object): Promise<void> {
    const encoded = this.encoder.encode(this.formatSSE(data))
    const dead: WritableStreamDefaultWriter<Uint8Array>[] = []

    for (const writer of this.sseWriters) {
      try {
        await writer.write(encoded)
      } catch {
        dead.push(writer)
      }
    }
    for (const w of dead) {
      this.sseWriters.delete(w)
    }
  }

  // ── Session CRUD ───────────────────────────────────────────────

  createSession(id?: string, title?: string): Session {
    const sessionId = id || generateId("ses")
    const now = Date.now()
    const session: Session = {
      id: sessionId,
      slug: sessionId.slice(0, 8),
      projectID: "opencode-worker",
      directory: "/",
      title: title || "New Session",
      version: "0.1.0",
      time: { created: now, updated: now },
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, data, created_at) VALUES (?, ?, ?)`,
      sessionId,
      JSON.stringify(session),
      now,
    )
    return session
  }

  getSessionById(id: string): Session | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT data FROM sessions WHERE id = ?`, id)
      .toArray()
    if (rows.length === 0) return null
    return JSON.parse(rows[0].data as string)
  }

  listSessions(): Session[] {
    const rows = this.ctx.storage.sql
      .exec(`SELECT data FROM sessions ORDER BY created_at DESC`)
      .toArray()
    return rows.map((r) => JSON.parse(r.data as string))
  }

  deleteSessionById(id: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, id)
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE session_id = ?`, id)
    this.ctx.storage.sql.exec(`DELETE FROM session_meta WHERE session_id = ?`, id)
  }

  updateSessionTitle(id: string, title: string): Session | null {
    const session = this.getSessionById(id)
    if (!session) return null
    session.title = title
    session.time.updated = Date.now()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, data, created_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(session),
      session.time.created,
    )
    return session
  }

  // ── Session Meta ───────────────────────────────────────────────

  getSessionMeta(sessionId: string): Record<string, string> {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, value FROM session_meta WHERE session_id = ?`,
        sessionId,
      )
      .toArray()
    return Object.fromEntries(
      rows.map((r) => [r.key as string, r.value as string]),
    )
  }

  setSessionMeta(sessionId: string, key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO session_meta (session_id, key, value) VALUES (?, ?, ?)`,
      sessionId,
      key,
      value,
    )
  }

  // ── Get Messages (V2 format for TUI) ──────────────────────────

  private handleGetMessages(sessionId: string, query: URLSearchParams): Response {
    const limit = parseInt(query.get("limit") || "100", 10)
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT data FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
        sessionId,
        limit,
      )
      .toArray()
    const messages: StoredMessage[] = rows.map(
      (r) => JSON.parse(r.data as string) as StoredMessage,
    )
    return new Response(JSON.stringify(messages), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  getMessagesForSession(sessionId: string): StoredMessage[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT data FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
        sessionId,
      )
      .toArray()
    return rows.map((r) => JSON.parse(r.data as string) as StoredMessage)
  }

  // ── Message Handling (full TUI SSE event protocol) ─────────────

  private async handleMessage(
    request: Request,
    sessionId: string,
  ): Promise<Response> {
    const body = (await request.json()) as PromptRequest

    // Extract text from parts or content
    const text =
      body.content ||
      (body.parts || [])
        .filter(
          (p): p is { type: string; text: string } =>
            (p.type === "text" || p.type === "input") && !!p.text,
        )
        .map((p) => p.text)
        .join("\n")
        .trim()

    if (!text) {
      return new Response(
        JSON.stringify({ error: "Message content is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Resolve model/provider
    const providerId =
      body.model?.providerID || body.providerID || "anthropic"
    const modelId =
      body.model?.modelID || body.modelID || "claude-sonnet-4-20250514"
    const agent = body.agent || "default"

    const userMessageId = body.messageID || generateId("msg")
    const userTextPartId = generateId("prt")
    const assistantMessageId = generateId("msg")
    const assistantTextPartId = generateId("prt")
    const stepStartPartId = generateId("prt")
    const stepFinishPartId = generateId("prt")
    const now = Date.now()

    console.log(
      `[handleMessage] session=${sessionId} provider=${providerId} model=${modelId}`,
    )
    console.log("SSE connections:", this.sseWriters.size)

    // ── Step 1: Store + broadcast user message ───────────────────

    const userMessage: StoredMessage = {
      info: {
        id: userMessageId,
        sessionID: sessionId,
        role: "user",
        time: { created: now },
        agent,
        model: { providerID: providerId, modelID: modelId },
      },
      parts: [
        {
          id: userTextPartId,
          sessionID: sessionId,
          messageID: userMessageId,
          type: "text",
          text,
          time: { start: now, end: now },
        },
      ],
    }
    this.storeMessage(userMessage)

    await this.broadcast({
      type: "message.updated",
      properties: { sessionID: sessionId, info: userMessage.info },
    })

    await this.broadcast({
      type: "message.part.updated",
      properties: { sessionID: sessionId, part: userMessage.parts[0], time: Date.now() },
    })

    // User message with summary signals "not queued"
    await this.broadcast({
      type: "message.updated",
      properties: {
        sessionID: sessionId,
        info: { ...userMessage.info, summary: { diffs: [] } },
      },
    })

    // ── Step 2: Assistant placeholder + busy ─────────────────────

    const assistantInfo: StoredMessage["info"] = {
      id: assistantMessageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: now },
      parentID: userMessageId,
      modelID: modelId,
      providerID: providerId,
      mode: "build",
      agent,
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }

    this.storeMessage({ info: assistantInfo, parts: [] })

    await this.broadcast({
      type: "message.updated",
      properties: { sessionID: sessionId, info: assistantInfo },
    })

    await this.broadcast({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "busy" } },
    })

    // ── Step 3: Broadcast step-start ─────────────────────────────

    await this.broadcast({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        time: Date.now(),
        part: {
          id: stepStartPartId,
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: "step-start",
        },
      },
    })

    // ── Step 4: Run AI ───────────────────────────────────────────

    let fullText = ""
    let reasoningText = ""
    const reasoningPartId = generateId("prt")
    // Track tool parts (upstream shape) for storage
    const toolParts: StoredPart[] = []
    // Map agent-loop toolCallId → our part ID
    const toolIdMap = new Map<string, string>()

    try {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      // Build history from stored messages
      const storedMsgs = this.getMessagesForSession(sessionId)
      const history: SessionMessage[] = storedMsgs.map((m) => ({
        id: m.info.id,
        sessionId,
        role: m.info.role,
        content:
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text || "")
            .join("\n") || "",
        toolCalls: m.parts
          .filter((p) => p.type === "tool" && p.tool)
          .map((p) => ({ id: p.callID || p.id, name: p.tool!, arguments: p.state?.input || {} })),
        toolResults: m.parts
          .filter((p) => p.type === "tool" && p.state?.status === "completed")
          .map((p) => ({ callId: p.callID || p.id, name: p.tool!, result: p.state?.output || "" })),
        createdAt: m.info.time.created,
      }))

      const model = getLanguageModel(providerId, modelId, this.env)
      const meta = this.getSessionMeta(sessionId)
      const workspace = new AgentSpaceWorkspaceAdapter(
        meta.spaceUrl || "",
        meta.spaceApiKey || "",
      )
      const tools = createTools(workspace)

      await runAgentLoop({
        model,
        tools,
        history,
        sessionId,
        signal: this.abortController.signal,
        onEvent: async (event: SessionEvent) => {
          switch (event.type) {
            case "message.delta": {
              const delta = (event as any).delta as string
              fullText += delta
              console.log(`[message.delta] +${delta.length} chars, total: ${fullText.length}`)
              // Broadcast delta (client accumulates via message.part.delta)
              await this.broadcast({
                type: "message.part.delta",
                properties: {
                  sessionID: sessionId,
                  messageID: assistantMessageId,
                  partID: assistantTextPartId,
                  field: "text",
                  delta,
                },
              })
              // Also broadcast full part so late-joining clients get current state
              await this.broadcast({
                type: "message.part.updated",
                properties: {
                  sessionID: sessionId,
                  time: Date.now(),
                  part: {
                    id: assistantTextPartId,
                    sessionID: sessionId,
                    messageID: assistantMessageId,
                    type: "text",
                    text: fullText,
                    time: { start: now, end: Date.now() },
                  },
                },
              })
              break
            }
            case "reasoning.delta" as string: {
              const delta = (event as any).delta as string
              if (!delta) break
              reasoningText += delta
              await this.broadcast({
                type: "message.part.delta",
                properties: {
                  sessionID: sessionId,
                  messageID: assistantMessageId,
                  partID: reasoningPartId,
                  field: "text",
                  delta,
                },
              })
              await this.broadcast({
                type: "message.part.updated",
                properties: {
                  sessionID: sessionId,
                  time: Date.now(),
                  part: {
                    id: reasoningPartId,
                    sessionID: sessionId,
                    messageID: assistantMessageId,
                    type: "reasoning",
                    text: reasoningText,
                    time: { start: now, end: Date.now() },
                  },
                },
              })
              break
            }
            case "tool.called": {
              const tc = (event as any).tool as {
                id: string
                name: string
                arguments: Record<string, unknown>
              }
              const partId = generateId("prt")
              toolIdMap.set(tc.id, partId)
              const raw = JSON.stringify(tc.arguments)
              const part: StoredPart = {
                id: partId,
                sessionID: sessionId,
                messageID: assistantMessageId,
                type: "tool",
                callID: tc.id,
                tool: tc.name,
                state: { status: "running", input: tc.arguments, raw, time: { start: Date.now() } },
              }
              toolParts.push(part)
              console.log(`[tool.called] ${tc.name} (${partId})`)
              await this.broadcast({
                type: "message.part.updated",
                properties: { sessionID: sessionId, time: Date.now(), part },
              })
              break
            }
            case "tool.result": {
              const tr = (event as any).result as {
                callId: string
                name: string
                result: string
              }
              const partId = toolIdMap.get(tr.callId)
              if (partId) {
                const existing = toolParts.find((p) => p.id === partId)
                if (existing) {
                  existing.state = {
                    status: "completed",
                    input: existing.state?.input || {},
                    output: tr.result,
                    title: tr.name,
                    metadata: {},
                    time: {
                      start: existing.state?.time?.start || Date.now(),
                      end: Date.now(),
                    },
                  }
                }
                console.log(
                  `[tool.result] ${tr.name} → ${(tr.result || "").slice(0, 80)}...`,
                )
                await this.broadcast({
                  type: "message.part.updated",
                  properties: {
                    sessionID: sessionId,
                    time: Date.now(),
                    part: existing || {
                      id: partId,
                      sessionID: sessionId,
                      messageID: assistantMessageId,
                      type: "tool",
                      callID: tr.callId,
                      tool: tr.name,
                      state: {
                        status: "completed",
                        input: {},
                        output: tr.result,
                        title: tr.name,
                        metadata: {},
                        time: { start: Date.now(), end: Date.now() },
                      },
                    },
                  },
                })
              }
              break
            }
            case "message.completed": {
              // Intermediate round completed; no broadcast needed yet
              break
            }
          }
        },
        appendMessage: async (msg) => {
          // Store intermediate messages (tool-round assistant messages)
          // so GET /session/:id/message returns complete history
          const storedMsg: StoredMessage = {
            info: {
              id: msg.id,
              sessionID: sessionId,
              role: msg.role as "user" | "assistant",
              time: { created: msg.createdAt },
              agent,
              model: { providerID: providerId, modelID: modelId },
              parentID: userMessageId,
            },
            parts: [],
          }
          if (msg.content) {
            storedMsg.parts.push({
              id: generateId("prt"),
              sessionID: sessionId,
              messageID: msg.id,
              type: "text",
              text: msg.content,
              time: { start: msg.createdAt, end: Date.now() },
            })
          }
          this.storeMessage(storedMsg)
          return { ...msg, sessionId }
        },
      })
    } catch (e) {
      console.error("AI error:", e)
      if (!fullText) {
        fullText = "I encountered an error generating a response."
      }
    } finally {
      this.abortController = null
    }

    const endTime = Date.now()
    if (!fullText) {
      fullText = "I encountered an error generating a response."
    }

    console.log(`[handleMessage] completed in ${endTime - now}ms, tools: ${toolParts.length}, text length: ${fullText.length}`)
    console.log(`[response] ${fullText.slice(0, 200)}${fullText.length > 200 ? '...' : ''}`)

    // ── Step 5: Finalize ─────────────────────────────────────────

    // Final text broadcast
    await this.broadcast({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        time: endTime,
        part: {
          id: assistantTextPartId,
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: "text",
          text: fullText,
          time: { start: now, end: endTime },
        },
      },
    })

    // step-finish
    await this.broadcast({
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        time: endTime,
        part: {
          id: stepFinishPartId,
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })

    // Build all parts: step-start + reasoning? + tool parts + text + step-finish
    const allParts: StoredPart[] = [
      {
        id: stepStartPartId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "step-start",
      },
      ...(reasoningText ? [{
        id: reasoningPartId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoningText,
        time: { start: now, end: endTime },
      }] : []),
      ...toolParts,
      {
        id: assistantTextPartId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: fullText,
        time: { start: now, end: endTime },
      },
      {
        id: stepFinishPartId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]

    // Update stored assistant message with completed response + all parts
    const completedAssistant: StoredMessage = {
      info: {
        ...assistantInfo,
        time: { created: now, completed: endTime },
        finish: "stop",
      },
      parts: allParts,
    }
    this.storeMessage(completedAssistant)

    // Broadcast completed assistant info
    await this.broadcast({
      type: "message.updated",
      properties: {
        sessionID: sessionId,
        info: {
          ...assistantInfo,
          time: { created: now, completed: endTime },
          finish: "stop",
        },
      },
    })

    // Idle status
    await this.broadcast({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    // Deprecated session.idle (TUI still expects it)
    await this.broadcast({
      type: "session.idle",
      properties: { sessionID: sessionId },
    })

    return new Response(JSON.stringify(completedAssistant), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  // ── Storage helper ─────────────────────────────────────────────

  private storeMessage(msg: StoredMessage): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO messages (id, session_id, role, created_at, completed_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
      msg.info.id,
      msg.info.sessionID,
      msg.info.role,
      msg.info.time.created,
      msg.info.time.completed || null,
      JSON.stringify(msg),
    )
  }
}
