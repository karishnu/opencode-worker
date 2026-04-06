import { describe, it, expect, vi } from "vitest"
import { handleDeployCommand, type DeployContext } from "../space/deploy-engine"

// Mock worker-bundler — esbuild doesn't work inside workerd test runtime
vi.mock("@cloudflare/worker-bundler", () => ({
  createWorker: vi.fn().mockResolvedValue({
    mainModule: "index.js",
    modules: { "index.js": "export default {}" },
  }),
}))

function makeMockCtx(files: Record<string, string>): DeployContext {
  // Simulate a workspace with files at various depths
  const store = new Map<string, string>()
  for (const [path, content] of Object.entries(files)) {
    const p = path.startsWith("/") ? path : `/${path}`
    store.set(p, content)
  }

  const fileInfos = [...store.entries()].map(([path]) => ({
    path,
    name: path.split("/").pop()!,
    type: "file" as const,
    size: store.get(path)!.length,
    updatedAt: Date.now(),
  }))

  const workspace = {
    readDir: vi.fn().mockImplementation((dir: string) => {
      // Non-recursive: only entries whose parent is `dir`
      const normalized = dir.endsWith("/") ? dir : `${dir}/`
      const seen = new Set<string>()
      const results: Array<{ path: string; name: string; type: string }> = []
      for (const info of fileInfos) {
        const rel = info.path.slice(normalized.length)
        if (!info.path.startsWith(normalized) || !rel) continue
        const parts = rel.split("/")
        if (parts.length === 1) {
          results.push(info)
        } else if (!seen.has(parts[0])) {
          seen.add(parts[0])
          results.push({ path: `${normalized}${parts[0]}`, name: parts[0], type: "directory" })
        }
      }
      return Promise.resolve(results)
    }),
    glob: vi.fn().mockImplementation(() => {
      // Recursive: returns all files
      return Promise.resolve(fileInfos)
    }),
    readFile: vi.fn().mockImplementation((path: string) => {
      return Promise.resolve(store.get(path) ?? null)
    }),
  }

  const git = {
    log: vi.fn().mockResolvedValue([{ oid: "abc123" }]),
    checkout: vi.fn().mockResolvedValue(undefined),
  }

  // In-memory SQL mock
  const rows: any[] = []
  const sql = {
    exec: vi.fn().mockImplementation((...args: any[]) => {
      const query = args[0] as string
      if (query.includes("INSERT")) {
        rows.push({
          branch: args[1],
          commit_hash: args[2],
          main_module: args[3],
          modules: args[4],
          deployed_at: args[5],
        })
      }
      return { toArray: () => rows, rowsWritten: 0 }
    }),
  }

  return { sql: sql as any, git: git as any, workspace: workspace as any }
}

describe("deploy-engine", () => {
  it("finds entry point in src/ subdirectory via glob", async () => {
    const ctx = makeMockCtx({
      "src/index.ts": 'export default { async fetch() { return new Response("ok"); } };',
    })

    const req = new Request("http://test/?cmd=deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    const res = await handleDeployCommand(ctx, "deploy", req)
    const data = await res.json() as any

    // Log actual response for debugging
    if (res.status !== 200) console.log("deploy response:", data)

    // Should NOT fail — glob finds src/index.ts
    expect(res.status).toBe(200)
    expect(data.branch).toBe("main")
    expect(data.commit_hash).toBe("abc123")

    // Verify glob was called (not just readDir)
    expect(ctx.workspace.glob).toHaveBeenCalledWith("**/*")
  })

  it("returns build error when createWorker throws", async () => {
    const { createWorker } = await import("@cloudflare/worker-bundler")
    ;(createWorker as any).mockRejectedValueOnce(new Error("Syntax error in src/index.ts"))

    const ctx = makeMockCtx({
      "src/index.ts": "this is not valid typescript export default {",
    })

    const req = new Request("http://test/?cmd=deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    })

    const res = await handleDeployCommand(ctx, "deploy", req)
    const data = await res.json() as any

    expect(res.status).toBe(400)
    expect(data.error).toBe("Build failed")
    expect(data.details).toContain("Syntax error")
  })

  it("fails with empty branch", async () => {
    const ctx = makeMockCtx({})

    const req = new Request("http://test/?cmd=deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "" }),
    })

    const res = await handleDeployCommand(ctx, "deploy", req)
    expect(res.status).toBe(400)
    const data = await res.json() as any
    expect(data.error).toContain("branch is required")
  })
})
