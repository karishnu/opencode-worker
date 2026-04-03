import { Hono } from "hono"
import type { Env } from "../env"
import type { SessionDO } from "../session/durable-object"

/**
 * Session routes — upstream-compatible.
 *
 * Uses a single "main" DO instance for all sessions so SSE
 * connections and message broadcasting share the same isolate.
 */
export function sessionRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  // ── List sessions ─────────────────────────────────────────────
  app.get("/", async (c) => {
    const stub = getMainDO(c.env)
    const sessions = await stub.listSessions()
    return c.json(sessions)
  })

  // ── Session status ────────────────────────────────────────────
  app.get("/status", async (_c) => {
    return _c.json({})
  })

  // ── Create session ────────────────────────────────────────────
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const stub = getMainDO(c.env)
    const session = await stub.createSession(undefined, body.title as string | undefined)

    // Broadcast session created
    await stub.broadcast({
      type: "session.updated",
      properties: { info: session },
    })

    return c.json(session)
  })

  // ── Get session ───────────────────────────────────────────────
  app.get("/:sessionID", async (c) => {
    const stub = getMainDO(c.env)
    const session = await stub.getSessionById(c.req.param("sessionID"))
    if (!session) {
      // Return a synthetic session (TUI expects this to work)
      const id = c.req.param("sessionID")
      const now = Date.now()
      return c.json({
        id,
        slug: id.slice(0, 8),
        projectID: "opencode-worker",
        directory: "/",
        title: "New Session",
        version: "0.1.0",
        time: { created: now, updated: now },
      })
    }
    return c.json(session)
  })

  // ── Delete session ────────────────────────────────────────────
  app.delete("/:sessionID", async (c) => {
    const stub = getMainDO(c.env)
    const sessionId = c.req.param("sessionID")
    await stub.deleteSessionById(sessionId)
    await stub.broadcast({
      type: "session.deleted",
      properties: {
        info: { id: sessionId, time: { created: Date.now(), updated: Date.now() } },
      },
    })
    return c.json({ success: true })
  })

  // ── Update session ────────────────────────────────────────────
  app.patch("/:sessionID", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const stub = getMainDO(c.env)
    const sessionId = c.req.param("sessionID")
    if (body.title && typeof body.title === "string") {
      const session = await stub.updateSessionTitle(sessionId, body.title)
      if (session) {
        await stub.broadcast({
          type: "session.updated",
          properties: { info: session },
        })
        return c.json(session)
      }
    }
    const session = await stub.getSessionById(sessionId)
    return c.json(session)
  })

  // ── Get messages → forward to DO ──────────────────────────────
  app.get("/:sessionID/message", async (c) => {
    const stub = getMainDO(c.env)
    return stub.fetch(c.req.raw)
  })

  // ── Get single message ────────────────────────────────────────
  app.get("/:sessionID/message/:messageID", async (c) => {
    const stub = getMainDO(c.env)
    const sessionId = c.req.param("sessionID")
    const messageId = c.req.param("messageID")
    const msgs: any[] = await stub.getMessagesForSession(sessionId)
    const msg = msgs.find((m: any) => m.info.id === messageId)
    if (!msg) return c.json({ error: "Message not found" }, 404)
    return c.json(msg)
  })

  // ── Send prompt → forward to DO ───────────────────────────────
  app.post("/:sessionID/message", async (c) => {
    const stub = getMainDO(c.env)
    return stub.fetch(c.req.raw)
  })

  // ── Send async prompt → rewrite to /message, forward to DO ────
  app.post("/:sessionID/prompt_async", async (c) => {
    const stub = getMainDO(c.env)
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace("/prompt_async", "/message")
    const newReq = new Request(url.toString(), c.req.raw)
    return stub.fetch(newReq)
  })

  // ── Abort ─────────────────────────────────────────────────────
  app.post("/:sessionID/abort", async (_c) => {
    // TODO: implement abort via DO
    return _c.json(true)
  })

  // ── Init (stub) ───────────────────────────────────────────────
  app.post("/:sessionID/init", async (_c) => {
    return _c.json(true)
  })

  // ── Fork ──────────────────────────────────────────────────────
  app.post("/:sessionID/fork", async (c) => {
    const stub = getMainDO(c.env)
    const session = await stub.createSession(undefined, "Forked Session")
    return c.json(session)
  })

  // ── Children (stub) ───────────────────────────────────────────
  app.get("/:sessionID/children", async (_c) => {
    return _c.json([])
  })

  // ── Todo (stub) ───────────────────────────────────────────────
  app.get("/:sessionID/todo", async (_c) => {
    return _c.json([])
  })

  // ── Share (stub) ──────────────────────────────────────────────
  app.post("/:sessionID/share", async (c) => {
    const stub = getMainDO(c.env)
    return c.json(await stub.getSessionById(c.req.param("sessionID")))
  })

  app.delete("/:sessionID/share", async (c) => {
    const stub = getMainDO(c.env)
    return c.json(await stub.getSessionById(c.req.param("sessionID")))
  })

  // ── Diff (stub) ───────────────────────────────────────────────
  app.get("/:sessionID/diff", async (_c) => {
    return _c.json([])
  })

  // ── Summarize (stub) ──────────────────────────────────────────
  app.post("/:sessionID/summarize", async (_c) => {
    return _c.json(true)
  })

  // ── Revert (stub) ─────────────────────────────────────────────
  app.post("/:sessionID/revert", async (c) => {
    const stub = getMainDO(c.env)
    return c.json(await stub.getSessionById(c.req.param("sessionID")))
  })

  app.post("/:sessionID/unrevert", async (c) => {
    const stub = getMainDO(c.env)
    return c.json(await stub.getSessionById(c.req.param("sessionID")))
  })

  // ── Permissions (stub) ────────────────────────────────────────
  app.post("/:sessionID/permissions/:permissionID", async (_c) => {
    return _c.json(true)
  })

  app.post("/:sessionID/permission/:requestId/reply", async (_c) => {
    return _c.json({ success: true })
  })

  // ── Question (stub) ───────────────────────────────────────────
  app.post("/:sessionID/question/:requestId/reply", async (_c) => {
    return _c.json({ success: true })
  })

  app.post("/:sessionID/question/:requestId/reject", async (_c) => {
    return _c.json({ success: true })
  })

  // ── Delete message (stub) ─────────────────────────────────────
  app.delete("/:sessionID/message/:messageID", async (_c) => {
    return _c.json(true)
  })

  // ── Command (stub) ────────────────────────────────────────────
  app.post("/:sessionID/command", async (c) => {
    // Rewrite as a message request and forward to DO
    const stub = getMainDO(c.env)
    return stub.fetch(c.req.raw)
  })

  // ── Shell (stub) ──────────────────────────────────────────────
  app.post("/:sessionID/shell", async (_c) => {
    return _c.json({
      id: crypto.randomUUID(),
      sessionID: _c.req.param("sessionID"),
      role: "assistant",
      time: { created: Date.now(), updated: Date.now() },
      error: { name: "UnsupportedError", message: "Shell is not supported in Worker mode" },
    })
  })

  return app
}

// ── Helpers ──────────────────────────────────────────────────────

function getMainDO(env: Env): DurableObjectStub<SessionDO> {
  const id = env.SESSION_DO.idFromName("main")
  return env.SESSION_DO.get(id) as DurableObjectStub<SessionDO>
}
