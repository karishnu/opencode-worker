import { Hono } from "hono"
import type { Env } from "../env"
import type { ProjectInfo } from "../upstream-types"

/**
 * Project routes — upstream-compatible stubs.
 */
export function projectRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  const defaultProject: ProjectInfo = {
    id: "worker-project",
    name: "opencode-worker",
    worktree: "/workspace",
    vcs: "git",
    directory: "/workspace",
  }

  app.get("/", (c) => {
    return c.json([defaultProject])
  })

  app.get("/current", (c) => {
    return c.json(defaultProject)
  })

  app.post("/git/init", (c) => {
    return c.json(defaultProject)
  })

  app.patch("/:projectID", (c) => {
    return c.json(defaultProject)
  })

  return app
}
