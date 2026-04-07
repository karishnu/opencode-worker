import { DurableObject } from "cloudflare:workers"
import type { Env } from "../env"
import type { SessionEvent, StoredMessage, StoredPart } from "../types"
import type { SpaceMapping } from "../tools"
import { getLanguageModel } from "../provider/registry"
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

// StoredMessage and StoredPart types imported from ../types

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
    // Migrate old session_spaces schema (had space_url, space_api_key columns)
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS session_spaces`)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_spaces (
        session_id TEXT NOT NULL,
        space_name TEXT NOT NULL,
        PRIMARY KEY (session_id, space_name)
      )
    `)
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_session_spaces_session ON session_spaces(session_id)`,
    )
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

  // ── Session ↔ Space Mappings ────────────────────────────────────

  addSessionSpace(sessionId: string, spaceName: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO session_spaces (session_id, space_name) VALUES (?, ?)`,
      sessionId,
      spaceName,
    )
  }

  removeSessionSpace(sessionId: string, spaceName: string): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM session_spaces WHERE session_id = ? AND space_name = ?`,
      sessionId,
      spaceName,
    )
  }

  hasSessionSpace(sessionId: string, spaceName: string): boolean {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT 1 FROM session_spaces WHERE session_id = ? AND space_name = ?`,
        sessionId,
        spaceName,
      )
      .toArray()
    return rows.length > 0
  }

  getSessionSpaces(sessionId: string): SpaceMapping[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT session_id, space_name FROM session_spaces WHERE session_id = ?`,
        sessionId,
      )
      .toArray()
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      spaceName: r.space_name as string,
    }))
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
    // Parts in stream order (text + tool interleaved, like upstream)
    const orderedParts: StoredPart[] = []
    // Current text part being streamed (null between segments)
    let currentTextPart: StoredPart | null = null
    // Map agent-loop toolCallId → our part ID
    const toolIdMap = new Map<string, string>()

    try {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      // getMessages callback for agent loop (re-reads from DB each call)
      const getMessages = () => this.getMessagesForSession(sessionId)

      const model = getLanguageModel(providerId, modelId, this.env)
      const spaceStore = {
        add: (name: string) => this.addSessionSpace(sessionId, name),
        remove: (name: string) => this.removeSessionSpace(sessionId, name),
        list: () => this.getSessionSpaces(sessionId),
        has: (name: string) => this.hasSessionSpace(sessionId, name),
      }
      const host = new URL(request.url).origin
      const tools = createTools({ env: this.env, sessionId, host, spaceStore })

      await runAgentLoop({
        model,
        tools,
        getMessages,
        sessionId,
        signal: this.abortController.signal,
        onEvent: async (event: SessionEvent) => {
          switch (event.type) {
            case "text.start": {
              // Create a new text part for this segment (upstream pattern)
              const partId = generateId("prt")
              currentTextPart = {
                id: partId,
                sessionID: sessionId,
                messageID: assistantMessageId,
                type: "text",
                text: "",
                time: { start: Date.now() },
              }
              orderedParts.push(currentTextPart)
              await this.broadcast({
                type: "message.part.updated",
                properties: { sessionID: sessionId, time: Date.now(), part: currentTextPart },
              })
              break
            }
            case "message.delta": {
              const delta = (event as any).delta as string
              fullText += delta
              if (currentTextPart) {
                currentTextPart.text = (currentTextPart.text || "") + delta
              }
              const partId = currentTextPart?.id || assistantTextPartId
              console.log(`[message.delta] +${delta.length} chars, total: ${fullText.length}`)
              await this.broadcast({
                type: "message.part.delta",
                properties: {
                  sessionID: sessionId,
                  messageID: assistantMessageId,
                  partID: partId,
                  field: "text",
                  delta,
                },
              })
              await this.broadcast({
                type: "message.part.updated",
                properties: {
                  sessionID: sessionId,
                  time: Date.now(),
                  part: currentTextPart || {
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
            case "text.end": {
              if (currentTextPart) {
                currentTextPart.text = (currentTextPart.text || "").trimEnd()
                currentTextPart.time = { start: currentTextPart.time?.start || Date.now(), end: Date.now() }
                await this.broadcast({
                  type: "message.part.updated",
                  properties: { sessionID: sessionId, time: Date.now(), part: currentTextPart },
                })
                currentTextPart = null
              }
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
              orderedParts.push(part)
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
                isError?: boolean
              }
              const partId = toolIdMap.get(tr.callId)
              if (partId) {
                const existing = orderedParts.find((p) => p.id === partId)
                const start = existing?.state?.time?.start || Date.now()
                if (existing) {
                  existing.state = tr.isError
                    ? {
                        status: "error",
                        input: existing.state?.input || {},
                        error: tr.result,
                        metadata: {},
                        time: { start, end: Date.now() },
                      }
                    : {
                        status: "completed",
                        input: existing.state?.input || {},
                        output: tr.result,
                        title: tr.name,
                        metadata: {},
                        time: { start, end: Date.now() },
                      }
                }
                console.log(
                  `[tool.result] ${tr.name}${tr.isError ? " ERROR" : ""} → ${(tr.result || "").slice(0, 80)}...`,
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
                      state: tr.isError
                        ? { status: "error", input: {}, error: tr.result, time: { start: Date.now(), end: Date.now() } }
                        : { status: "completed", input: {}, output: tr.result, title: tr.name, metadata: {}, time: { start: Date.now(), end: Date.now() } },
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

    const toolCount = orderedParts.filter((p) => p.type === "tool").length
    console.log(`[handleMessage] completed in ${endTime - now}ms, tools: ${toolCount}, text length: ${fullText.length}`)
    console.log(`[response] ${fullText.slice(0, 200)}${fullText.length > 200 ? '...' : ''}`)

    // ── Step 5: Finalize ─────────────────────────────────────────

    // Final text broadcast — only if no text parts were created via text.start
    // (fallback for edge case where text-start event was not emitted)
    if (!orderedParts.some((p) => p.type === "text")) {
      const fallback: StoredPart = {
        id: assistantTextPartId,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: fullText,
        time: { start: now, end: endTime },
      }
      orderedParts.push(fallback)
      await this.broadcast({
        type: "message.part.updated",
        properties: { sessionID: sessionId, time: endTime, part: fallback },
      })
    }

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

    // Build all parts in stream order: step-start + reasoning? + orderedParts + step-finish
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
      ...orderedParts,
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
