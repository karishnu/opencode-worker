import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../env"
import type { SpaceDO } from "../space/durable-object"

type SpaceApp = Hono<{ Bindings: Env }>

/**
 * Space management routes.
 *
 * Spaces are named SpaceDO instances — they auto-initialize on first use.
 * These routes provide a REST API for managing spaces outside the agent loop.
 */
export function spaceRoutes(): SpaceApp {
  const app = new Hono<{ Bindings: Env }>()

  function resolveSpace(env: Env, name: string): DurableObjectStub<SpaceDO> {
    const id = env.SPACE_DO.idFromName(name)
    return env.SPACE_DO.get(id) as DurableObjectStub<SpaceDO>
  }

  // ── Get space info ────────────────────────────────────────────
  app.get("/:name", async (c) => {
    const name = c.req.param("name")
    const space = resolveSpace(c.env, name)
    const info = await space.getInfo()
    return c.json({ name, ...info })
  })

  // ── Initialize a space (trigger creation) ─────────────────────
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).safeParse(body)
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400)
    }

    const space = resolveSpace(c.env, parsed.data.name)
    const info = await space.getInfo()
    return c.json({ name: parsed.data.name, ...info }, 201)
  })

  return app
}
