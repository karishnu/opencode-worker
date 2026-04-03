import { describe, it, expect, vi } from "vitest"
import { createTools, type ToolsContext } from "../tools"
import type { WorkspaceAdapter } from "../types"

function mockWorkspace(): WorkspaceAdapter {
  return {
    readFile: vi.fn().mockResolvedValue("file content"),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    editFile: vi.fn().mockResolvedValue({ ok: true }),
    glob: vi.fn().mockResolvedValue(["src/a.ts", "src/b.ts"]),
    grep: vi.fn().mockResolvedValue([
      { path: "src/a.ts", line: 10, content: "const x = 1" },
    ]),
    list: vi.fn().mockResolvedValue([
      { path: "src/a.ts", size: 100 },
      { path: "src/b.ts", size: 200 },
    ]),
    patch: vi.fn().mockResolvedValue({ applied: ["file.ts"], failed: [] }),
    gitCommit: vi.fn().mockResolvedValue({ sha: "abc123" }),
    gitLog: vi.fn().mockResolvedValue([
      { sha: "abc12345", date: "2025-01-01", author: "Test", message: "init" },
    ]),
    gitStatus: vi.fn().mockResolvedValue([
      { path: "src/a.ts", status: "modified" },
    ]),
    deploy: vi.fn().mockResolvedValue({ branch: "main" }),
    undeploy: vi.fn().mockResolvedValue({ branch: "main" }),
    listDeployments: vi.fn().mockResolvedValue([]),
    getDeployment: vi.fn().mockResolvedValue({ branch: "main" }),
  }
}

function mockToolsContext(): ToolsContext {
  const ws = mockWorkspace()
  return {
    resolveWorkspace: () => ws,
    orchestrator: {
      createSpace: vi.fn().mockResolvedValue({ name: "test", url: "https://test.workers.dev", apiKey: "key" }),
      listSpaces: vi.fn().mockResolvedValue([]),
      deleteSpace: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      initialize: vi.fn().mockResolvedValue(null),
    } as any,
    sessionId: "test-session",
    spaceStore: {
      add: vi.fn(),
      remove: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
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
      "deploy", "undeploy", "list_deployments", "get_deployment", "bash",
      "create_space", "list_spaces", "delete_space",
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
