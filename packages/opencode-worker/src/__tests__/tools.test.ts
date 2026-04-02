import { describe, it, expect, vi } from "vitest"
import { createTools } from "../tools"
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
  }
}

describe("createTools", () => {
  it("returns all expected tool keys", () => {
    const ws = mockWorkspace()
    const tools = createTools(ws)

    const expectedKeys = [
      "read", "write", "edit", "glob", "grep",
      "list", "patch", "git_commit", "git_log", "git_status", "bash",
    ]
    for (const key of expectedKeys) {
      expect(tools).toHaveProperty(key)
    }
  })

  it("each tool has description and inputSchema", () => {
    const ws = mockWorkspace()
    const tools = createTools(ws)

    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `${name} should have description`).toBeTruthy()
      expect(tool.inputSchema, `${name} should have inputSchema`).toBeTruthy()
    }
  })
})
