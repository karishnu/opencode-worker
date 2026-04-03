import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../env"
import { OrchestratorMcpClient } from "../adapters/orchestrator-mcp-client"

type SpaceApp = Hono<{ Bindings: Env }>

/**
 * Space management routes.
 *
 * Delegates to the orchestrator MCP for
 * creating, listing, and deleting spaces.
 */
export function spaceRoutes(): SpaceApp {
  const app = new Hono<{ Bindings: Env }>()

  function getOrchestrator(env: Env): OrchestratorMcpClient {
    return new OrchestratorMcpClient(env.ORCHESTRATOR_URL, env.ORCHESTRATOR_API_KEY)
  }

  // ── Create space ──────────────────────────────────────────────
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ name: z.string() }).safeParse(body)
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400)
    }

    const orchestrator = getOrchestrator(c.env)
    const result = await orchestrator.createSpace(parsed.data.name)
    return c.json(result, 201)
  })

  // ── List spaces ───────────────────────────────────────────────
  app.get("/", async (c) => {
    const orchestrator = getOrchestrator(c.env)
    const spaces = await orchestrator.listSpaces()
    return c.json(spaces)
  })

  // ── Delete space ──────────────────────────────────────────────
  app.delete("/:nameOrId", async (c) => {
    const nameOrId = c.req.param("nameOrId")
    const orchestrator = getOrchestrator(c.env)
    await orchestrator.deleteSpace(nameOrId)
    return c.json({ ok: true })
  })

  return app
}
