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
      "deploy", "undeploy", "list_deployments", "get_deployment", "bash",
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
