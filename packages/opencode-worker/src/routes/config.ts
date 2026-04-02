import { Hono } from "hono"
import type { Env } from "../env"
import type { ConfigInfo, ProviderInfo } from "../upstream-types"
import { listProviders } from "../provider/registry"
import { buildModels } from "../provider/models"

/**
 * Config routes — upstream-compatible.
 *
 * GET  /config            → current config
 * PATCH /config           → update config (stub)
 * GET  /config/providers  → configured providers with models
 */
export function configRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  app.get("/", (c) => {
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

  app.patch("/", async (c) => {
    // Stub — config is not persisted in the Worker
    const body = await c.req.json().catch(() => ({}))
    return c.json(body)
  })

  app.get("/providers", (c) => {
    const raw = listProviders(c.env)
    const providers: ProviderInfo[] = raw
      .filter((p) => p.configured)
      .map((p) => {
        const models = buildModels(p.id)
        return {
          id: p.id,
          name: p.name,
          models,
        }
      })

    const defaultMap: Record<string, string> = {}
    for (const p of providers) {
      const firstModel = Object.keys(p.models)[0]
      if (firstModel) defaultMap[p.id] = firstModel
    }

    return c.json({ providers, default: defaultMap })
  })

  return app
}
