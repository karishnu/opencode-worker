import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../env"
import { AgentSpaceManager } from "../adapters/space-manager-agent-space"

type SpaceApp = Hono<{ Bindings: Env }>

/**
 * Space management routes.
 *
 * Delegates to the Agent Space management API for
 * creating, listing, and deleting spaces.
 */
export function spaceRoutes(): SpaceApp {
  const app = new Hono<{ Bindings: Env }>()

  function getManager(env: Env): AgentSpaceManager {
    return new AgentSpaceManager(env.AGENT_SPACE_URL, env.AGENT_SPACE_API_KEY)
  }

  // ── Create space ──────────────────────────────────────────────
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ name: z.string() }).safeParse(body)
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400)
    }

    const manager = getManager(c.env)
    const result = await manager.createSpace(parsed.data.name)
    return c.json(result, 201)
  })

  // ── List spaces ───────────────────────────────────────────────
  app.get("/", async (c) => {
    const manager = getManager(c.env)
    const spaces = await manager.listSpaces()
    return c.json(spaces)
  })

  // ── Delete space ──────────────────────────────────────────────
  app.delete("/:nameOrId", async (c) => {
    const nameOrId = c.req.param("nameOrId")
    const manager = getManager(c.env)
    await manager.deleteSpace(nameOrId)
    return c.json({ ok: true })
  })

  return app
}
