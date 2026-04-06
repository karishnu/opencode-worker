import { Hono } from "hono"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import type { Env } from "./env"
import { globalRoutes } from "./routes/global"
import { sessionRoutes } from "./routes/session"
import { configRoutes } from "./routes/config"
import { providerRoutes } from "./routes/provider"
import { projectRoutes } from "./routes/project"
import { stubRoutes } from "./routes/stubs"
import { spaceRoutes } from "./routes/space"
import type { SessionDO as _SessionDO } from "./session/durable-object"
import type { SpaceDO as _SpaceDO } from "./space/durable-object"

export { SessionDO } from "./session/durable-object"
export { SpaceDO } from "./space/durable-object"

const app = new Hono<{ Bindings: Env }>()

// ── Middleware ─────────────────────────────────────────────────────

// CORS
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return undefined
      if (origin.startsWith("http://localhost:")) return origin
      if (origin.startsWith("http://127.0.0.1:")) return origin
      if (
        origin === "tauri://localhost" ||
        origin === "http://tauri.localhost" ||
        origin === "https://tauri.localhost"
      )
        return origin
      if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(origin)) return origin
      return undefined
    },
    maxAge: 86_400,
  }),
)

// Basic auth (skip if SERVER_PASSWORD not set)
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next()
  const password = c.env.SERVER_PASSWORD
  if (!password) return next()
  const username = c.env.SERVER_USERNAME ?? "opencode"
  return basicAuth({ username, password })(c, next)
})

// Request logging
app.use("*", async (c, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`)
})

// ── Routes ────────────────────────────────────────────────────────
// Mounted to match the upstream OpenCode server route tree so the
// stock TUI / web client can connect without modification.

app.route("/global", globalRoutes())
app.route("/project", projectRoutes())
app.route("/config", configRoutes())
app.route("/session", sessionRoutes())
app.route("/provider", providerRoutes())

// SSE event stream → forward to main DO
app.get("/event", async (c) => {
  const id = c.env.SESSION_DO.idFromName("main")
  const stub = c.env.SESSION_DO.get(id) as DurableObjectStub<_SessionDO>
  return stub.fetch(c.req.raw)
})

app.route("/", stubRoutes())        // mounts /agent, /skill, /path, /vcs, etc.
app.route("/space", spaceRoutes())  // non-upstream: Agent Space management

// Git Smart HTTP: forward to SpaceDO
app.all("/space/:name/repo.git/*", async (c) => {
  const spaceName = c.req.param("name")
  const id = c.env.SPACE_DO.idFromName(spaceName)
  const stub = c.env.SPACE_DO.get(id) as DurableObjectStub<_SpaceDO>
  return stub.fetch(c.req.raw)
})

// Deployment preview: forward to SpaceDO → Dynamic Worker
app.all("/space/:name/preview/:branch/*", async (c) => {
  const spaceName = c.req.param("name")
  const id = c.env.SPACE_DO.idFromName(spaceName)
  const stub = c.env.SPACE_DO.get(id) as DurableObjectStub<_SpaceDO>
  return stub.fetch(c.req.raw)
})
app.all("/space/:name/preview/:branch", async (c) => {
  const spaceName = c.req.param("name")
  const id = c.env.SPACE_DO.idFromName(spaceName)
  const stub = c.env.SPACE_DO.get(id) as DurableObjectStub<_SpaceDO>
  return stub.fetch(c.req.raw)
})

// ── Catch-all ─────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: "Not found" }, 404))

app.onError((err, c) => {
  console.error("Unhandled error:", err.message, err.stack)
  return c.json({ error: err.message }, 500)
})

// ── Export ─────────────────────────────────────────────────────────

export default app
