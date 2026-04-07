import { describe, it, expect, vi } from "vitest"
import { createTools, type ToolsContext } from "../tools"

function mockToolsContext(): ToolsContext {
  // Mock SPACE_DO namespace — tools resolve spaces via env.SPACE_DO.idFromName()
  const mockStub = {
    readFile: vi.fn().mockResolvedValue("file content"),
    writeFile: vi.fn().mockResolvedValue({ path: "/test.ts", size: 12 }),
    editFile: vi.fn().mockResolvedValue({ path: "/test.ts", size: 12 }),
    glob: vi.fn().mockResolvedValue(["src/a.ts", "src/b.ts"]),
    grep: vi.fn().mockResolvedValue([
      { path: "src/a.ts", line: 10, content: "const x = 1" },
    ]),
    list: vi.fn().mockResolvedValue([
      { path: "src/a.ts", mtime: 1000 },
      { path: "src/b.ts", mtime: 2000 },
    ]),
    patch: vi.fn().mockResolvedValue({ applied: ["file.ts"], failed: [] }),
    gitCommit: vi.fn().mockResolvedValue({ sha: "abc123", message: "init" }),
    gitLog: vi.fn().mockResolvedValue([
      { oid: "abc12345", message: "init", author: { name: "Test", email: "t@t.com", timestamp: 0 }, parent: [] },
    ]),
    gitStatus: vi.fn().mockResolvedValue([
      { filepath: "src/a.ts", status: "modified", head: 1, workdir: 2, stage: 1 },
    ]),
    deploy: vi.fn().mockResolvedValue({ branch: "main" }),
    undeploy: vi.fn().mockResolvedValue({ ok: true, branch: "main" }),
    listDeployments: vi.fn().mockResolvedValue([]),
    getDeployment: vi.fn().mockResolvedValue({ branch: "main" }),
    getInfo: vi.fn().mockResolvedValue({ fileCount: 0, directoryCount: 0, totalBytes: 0 }),
  }

  const mockSpaceDO = {
    idFromName: vi.fn().mockReturnValue("mock-id"),
    get: vi.fn().mockReturnValue(mockStub),
  }

  return {
    env: {
      SPACE_DO: mockSpaceDO,
      SESSION_DO: {} as any,
      LOADER: {} as any,
    } as any,
    sessionId: "test-session",
    host: "https://test.workers.dev",
    spaceStore: {
      add: vi.fn(),
      remove: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      has: vi.fn().mockReturnValue(false),
    },
  }
}

describe("createTools", () => {
  it("returns all expected tool keys", () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)

    const expectedKeys = [
      "read", "write", "edit", "glob", "grep",
      "list", "patch", "git_commit", "git_log", "git_status",
      "deploy", "undeploy", "list_deployments", "get_deployment", "bash", "curl",
      "create_space", "delete_space",
      "attach_space", "detach_space", "list_session_spaces",
    ]
    for (const key of expectedKeys) {
      expect(tools).toHaveProperty(key)
    }
  })

  it("each tool has description and inputSchema", () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)

    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `${name} should have description`).toBeTruthy()
      expect(tool.inputSchema, `${name} should have inputSchema`).toBeTruthy()
    }
  })
})

// Helper to get the mock stub and execute tools without TS noise
function getStub(ctx: ToolsContext): any {
  return (ctx.env as any).SPACE_DO.get((ctx.env as any).SPACE_DO.idFromName("x"))
}

async function exec(tool: any, args: any): Promise<any> {
  return tool.execute!(args, { toolCallId: "t", messages: [] })
}

describe("read tool", () => {
  it("reads full file content", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const result = await exec(tools.read, { space: "my-space", filePath: "/src/index.ts" })
    expect(result).toBe("file content")
    const stub = getStub(ctx)
    expect(stub.readFile).toHaveBeenCalledWith("/src/index.ts", {
      offset: undefined,
      limit: undefined,
    })
  })

  it("passes offset and limit for partial reads", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)
    stub.readFile.mockResolvedValue("10\tconst x = 1\n11\tconst y = 2")

    const tools = createTools(ctx)
    const result = await exec(tools.read, { space: "my-space", filePath: "/big.ts", offset: 10, limit: 2 })
    expect(result).toBe("10\tconst x = 1\n11\tconst y = 2")
    expect(stub.readFile).toHaveBeenCalledWith("/big.ts", { offset: 10, limit: 2 })
  })

  it("resolves the correct space via SPACE_DO", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    await exec(tools.read, { space: "other-space", filePath: "/a.txt" })
    expect((ctx.env as any).SPACE_DO.idFromName).toHaveBeenCalledWith("other-space")
  })
})

describe("write tool", () => {
  it("writes file and returns JSON with path and size", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const result = await exec(tools.write, { space: "my-space", filePath: "/new.ts", content: "hello world!" })
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual({ path: "/test.ts", size: 12 })
    const stub = getStub(ctx)
    expect(stub.writeFile).toHaveBeenCalledWith("/new.ts", "hello world!")
  })

  it("writes empty file", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)
    stub.writeFile.mockResolvedValue({ path: "/empty.ts", size: 0 })

    const tools = createTools(ctx)
    const result = await exec(tools.write, { space: "my-space", filePath: "/empty.ts", content: "" })
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual({ path: "/empty.ts", size: 0 })
    expect(stub.writeFile).toHaveBeenCalledWith("/empty.ts", "")
  })
})

describe("patch tool", () => {
  it("formats applied patches", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new"
    const result = await exec(tools.patch, { space: "my-space", diff })
    expect(result).toBe("Patched: file.ts")
    const stub = getStub(ctx)
    expect(stub.patch).toHaveBeenCalledWith(diff)
  })

  it("formats failed patches", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)
    stub.patch.mockResolvedValue({ applied: [], failed: ["broken.ts"] })

    const tools = createTools(ctx)
    const result = await exec(tools.patch, { space: "my-space", diff: "bad diff" })
    expect(result).toBe("Failed: broken.ts")
  })

  it("formats mixed applied and failed patches", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)
    stub.patch.mockResolvedValue({
      applied: ["a.ts", "b.ts"],
      failed: ["c.ts"],
    })

    const tools = createTools(ctx)
    const result = await exec(tools.patch, { space: "my-space", diff: "multi diff" })
    expect(result).toBe("Patched: a.ts\nPatched: b.ts\nFailed: c.ts")
  })

  it("verifies file content written after patching", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)

    // Replace the canned mock with one that records writeFile calls
    const written = new Map<string, string>()
    const mockWriteFile = vi.fn().mockImplementation(async (path: string, content: string) => {
      written.set(path, content)
    })
    // Override patch to use real diff parsing + capture writes
    stub.patch.mockImplementation(async (diff: string) => {
      // Re-implement the same logic as SpaceDO.patch using parseUnifiedDiffToEdits
      const edits = parseDiff(diff)
      const applied: string[] = []
      for (const edit of edits) {
        await mockWriteFile(edit.path, edit.content)
        applied.push(edit.path)
      }
      return { applied, failed: [] }
    })

    const tools = createTools(ctx)
    const diff = [
      "--- a/hello.ts",
      "+++ b/hello.ts",
      "@@ -1,3 +1,3 @@",
      " const greeting = 'hi'",
      "-console.log(greeting)",
      "+console.log(greeting + '!')",
      " export {}",
    ].join("\n")

    const result = await exec(tools.patch, { space: "my-space", diff })
    expect(result).toBe("Patched: hello.ts")
    expect(written.get("hello.ts")).toBe(
      "const greeting = 'hi'\nconsole.log(greeting + '!')\nexport {}"
    )
  })

  it("verifies multi-file patch writes correct content per file", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)

    const written = new Map<string, string>()
    const mockWriteFile = vi.fn().mockImplementation(async (path: string, content: string) => {
      written.set(path, content)
    })
    stub.patch.mockImplementation(async (diff: string) => {
      const edits = parseDiff(diff)
      const applied: string[] = []
      for (const edit of edits) {
        await mockWriteFile(edit.path, edit.content)
        applied.push(edit.path)
      }
      return { applied, failed: [] }
    })

    const tools = createTools(ctx)
    const diff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const x = 1",
      "+const x = 2",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,2 +1,2 @@",
      " import { x } from './a'",
      "-console.log(x)",
      "+console.log(x * 2)",
    ].join("\n")

    const result = await exec(tools.patch, { space: "my-space", diff })
    expect(result).toBe("Patched: a.ts\nPatched: b.ts")
    expect(written.get("a.ts")).toBe("const x = 2")
    expect(written.get("b.ts")).toBe("import { x } from './a'\nconsole.log(x * 2)")
  })
})

describe("deploy tool", () => {
  it("returns absolute preview URL with host", async () => {
    const ctx = mockToolsContext()
    const stub = getStub(ctx)
    stub.deploy.mockResolvedValue({
      branch: "main",
      commit_hash: "abc123",
      preview_url: "/space/my-space/preview/main/",
    })

    const tools = createTools(ctx)
    const result = await exec(tools.deploy, { space: "my-space", branch: "main" })
    const parsed = JSON.parse(result as string)
    expect(parsed.preview_url).toBe("https://test.workers.dev/space/my-space/preview/main/")
  })
})

describe("curl tool", () => {
  it("makes a GET request and returns status + body", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        statusText: "OK",
        headers: { "Content-Type": "application/json" },
      })
    )
    try {
      const result = await exec(tools.curl, { url: "https://example.com/api", method: "GET" })
      const parsed = JSON.parse(result as string)
      expect(parsed.status).toBe(200)
      expect(parsed.body).toBe('{"ok":true}')
      expect((globalThis.fetch as any)).toHaveBeenCalledWith(
        "https://example.com/api",
        { method: "GET", headers: undefined, body: undefined }
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("sends POST with headers and body", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("created", { status: 201, statusText: "Created" })
    )
    try {
      const result = await exec(tools.curl, {
        url: "https://example.com/api",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"test"}',
      })
      const parsed = JSON.parse(result as string)
      expect(parsed.status).toBe(201)
      expect(parsed.body).toBe("created")
      expect((globalThis.fetch as any)).toHaveBeenCalledWith(
        "https://example.com/api",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"name":"test"}',
        }
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns error status codes", async () => {
    const ctx = mockToolsContext()
    const tools = createTools(ctx)
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404, statusText: "Not Found" })
    )
    try {
      const result = await exec(tools.curl, { url: "https://example.com/missing", method: "GET" })
      const parsed = JSON.parse(result as string)
      expect(parsed.status).toBe(404)
      expect(parsed.statusText).toBe("Not Found")
      expect(parsed.body).toBe("not found")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// Minimal re-implementation of parseUnifiedDiffToEdits for test assertions.
// Mirrors the private function in space/durable-object.ts.
function parseDiff(diff: string): Array<{ path: string; content: string }> {
  const edits: Array<{ path: string; content: string }> = []
  const lines = diff.split("\n")
  let i = 0
  while (i < lines.length) {
    if (lines[i].startsWith("--- ")) {
      const oldPath = lines[i].slice(4).replace(/^[ab]\//, "")
      i++
      if (i < lines.length && lines[i].startsWith("+++ ")) {
        const newPath = lines[i].slice(4).replace(/^[ab]\//, "")
        i++
        const path = newPath === "/dev/null" ? oldPath : newPath
        const resultLines: string[] = []
        while (i < lines.length && !lines[i].startsWith("--- ")) {
          const l = lines[i]
          if (l.startsWith("@@")) { i++; continue }
          if (l.startsWith("+") && !l.startsWith("+++")) {
            resultLines.push(l.slice(1))
          } else if (l.startsWith("-") && !l.startsWith("---")) {
            // removed — skip
          } else if (l.startsWith(" ") || l === "") {
            resultLines.push(l.slice(1))
          } else { break }
          i++
        }
        edits.push({ path, content: resultLines.join("\n") })
        continue
      }
    }
    i++
  }
  return edits
}
