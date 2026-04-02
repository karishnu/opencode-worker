import { Hono } from "hono"
import type { Env } from "../env"
import type { AgentInfo } from "../upstream-types"

/**
 * Stub routes for upstream endpoints that don't apply in Worker mode
 * but need to return valid responses so the client doesn't break.
 */
export function stubRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  // ── Agent ─────────────────────────────────────────────────────
  app.get("/agent", (c) => {
    const agents: AgentInfo[] = [
      {
        name: "code",
        config: {
          name: "code",
          description: "General-purpose coding agent",
          mode: "primary",
        },
      },
    ]
    return c.json(agents)
  })

  // ── Skill ─────────────────────────────────────────────────────
  app.get("/skill", (c) => c.json([]))

  // ── Command ───────────────────────────────────────────────────
  app.get("/command", (c) => c.json([]))

  // ── Path ──────────────────────────────────────────────────────
  app.get("/path", (c) => {
    return c.json({
      home: "/workspace",
      state: "/workspace/.opencode",
      config: "/workspace/.opencode",
      worktree: "/workspace",
      directory: "/workspace",
    })
  })

  // ── VCS ───────────────────────────────────────────────────────
  app.get("/vcs", (c) => {
    return c.json({ branch: "main" })
  })

  // ── LSP ───────────────────────────────────────────────────────
  app.get("/lsp", (c) => c.json([]))

  // ── Formatter ─────────────────────────────────────────────────
  app.get("/formatter", (c) => c.json([]))

  // ── Instance dispose ──────────────────────────────────────────
  app.post("/instance/dispose", (c) => c.json(true))

  // ── Permission ────────────────────────────────────────────────
  app.get("/permission", (c) => c.json([]))
  app.post("/permission/:id", (c) => c.json(true))

  // ── Question ──────────────────────────────────────────────────
  app.get("/question", (c) => c.json([]))
  app.post("/question/:id", (c) => c.json(true))

  // ── MCP ───────────────────────────────────────────────────────
  app.get("/mcp", (c) => c.json([]))
  app.get("/mcp/tools", (c) => c.json([]))

  // ── PTY (not available in Workers) ────────────────────────────
  app.get("/pty", (c) => c.json([]))

  // ── TUI ───────────────────────────────────────────────────────
  app.get("/tui/theme", (c) => c.json({ name: "dark" }))
  app.get("/tui/theme/list", (c) => c.json(["dark", "light"]))

  // ── Log ───────────────────────────────────────────────────────
  app.post("/log", (c) => c.json(true))

  // ── Auth ──────────────────────────────────────────────────────
  app.put("/auth/:providerID", (c) => c.json(true))
  app.delete("/auth/:providerID", (c) => c.json(true))

  // ── Doc (OpenAPI stub) ────────────────────────────────────────
  app.get("/doc", (c) => c.json({ openapi: "3.1.1", info: { title: "opencode-worker", version: "0.1.0" }, paths: {} }))

  return app
}
