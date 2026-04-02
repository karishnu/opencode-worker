import { Hono } from "hono"
import type { Env } from "../env"
import type { ConfigInfo } from "../upstream-types"
import type { SessionDO } from "../session/durable-object"

/**
 * Global routes — upstream-compatible.
 *
 * GET /global/health
 * GET /global/event  (SSE) → forwarded to main DO
 * GET /global/config
 * PATCH /global/config
 */
export function globalRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  app.get("/health", (c) => {
    return c.json({ healthy: true, version: "0.1.0-worker" })
  })

  // Forward SSE event streams to the main DO
  app.get("/event", async (c) => {
    const stub = getMainDO(c.env)
    return stub.fetch(c.req.raw)
  })

  app.get("/sync-event", async (c) => {
    const stub = getMainDO(c.env)
    return stub.fetch(c.req.raw)
  })

  app.get("/config", (c) => {
    const config: ConfigInfo = {
      theme: "dark",
      disabled_providers: [],
      instructions: [],
      agents: {},
      commands: {},
      mcp: {},
      experimental: {},
    }
    return c.json(config)
  })

  app.patch("/config", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    return c.json(body)
  })

  app.post("/dispose", (c) => {
    return c.json(true)
  })

  return app
}

function getMainDO(env: Env): DurableObjectStub<SessionDO> {
  const id = env.SESSION_DO.idFromName("main")
  return env.SESSION_DO.get(id) as DurableObjectStub<SessionDO>
}
