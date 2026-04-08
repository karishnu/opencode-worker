import { Hono } from "hono"
import type { Env } from "../env"
import { listProviders } from "../provider/registry"
import type { ProviderInfo } from "../upstream-types"
import { buildModels, getModels } from "../provider/models"

/**
 * Provider routes — upstream-compatible.
 *
 * GET /provider      → { all, default, connected }
 * GET /provider/auth → stub
 */
export function providerRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  app.get("/", async (c) => {
    const raw = listProviders(c.env)

    const all: ProviderInfo[] = await Promise.all(
      raw.map(async (p) => ({
        id: p.id,
        name: p.name,
        models: await getModels(p.id),
      })),
    )

    const defaultMap: Record<string, string> = {}
    for (const p of all) {
      const firstModel = Object.keys(p.models)[0]
      if (firstModel) defaultMap[p.id] = firstModel
    }

    const connected = raw.filter((p) => p.configured).map((p) => p.id)

    return c.json({ all, default: defaultMap, connected })
  })

  app.get("/auth", (c) => {
    return c.json({})
  })

  return app
}
