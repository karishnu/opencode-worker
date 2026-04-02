import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentSpaceWorkspaceAdapter } from "../adapters/workspace-agent-space"

const SPACE_URL = "https://test-space.example.com"
const API_KEY = "test-api-key"

describe("AgentSpaceWorkspaceAdapter", () => {
  let adapter: AgentSpaceWorkspaceAdapter
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    adapter = new AgentSpaceWorkspaceAdapter(SPACE_URL, API_KEY)
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  describe("readFile", () => {
    it("reads a file and returns content", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("line1\nline2\nline3", { status: 200 }),
      )

      const result = await adapter.readFile("src/index.ts")
      expect(result).toBe("line1\nline2\nline3")
      expect(fetchMock).toHaveBeenCalledOnce()

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://test-space.example.com/src/index.ts")
      expect(init.headers["X-API-Key"]).toBe(API_KEY)
    })

    it("applies offset and limit", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("line1\nline2\nline3\nline4\nline5", { status: 200 }),
      )

      const result = await adapter.readFile("file.txt", { offset: 2, limit: 2 })
      // Should return lines 2-3 with line numbers
      expect(result).toContain("2\t")
      expect(result).toContain("line2")
      expect(result).toContain("line3")
      expect(result).not.toContain("line1")
      expect(result).not.toContain("line4")
    })

    it("throws on 404", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("Not found", { status: 404 }),
      )

      await expect(adapter.readFile("missing.ts")).rejects.toThrow()
    })
  })

  describe("writeFile", () => {
    it("sends PUT request with content", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )

      const result = await adapter.writeFile("out.txt", "hello world")
      expect(result).toEqual({ ok: true })

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("https://test-space.example.com/out.txt")
      expect(init.method).toBe("PUT")
      expect(init.body).toBe("hello world")
    })
  })

  describe("editFile", () => {
    it("reads, replaces, and writes back", async () => {
      // First call: read the file
      fetchMock.mockResolvedValueOnce(
        new Response("hello world", { status: 200 }),
      )
      // Second call: write the modified file
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )

      const result = await adapter.editFile("file.txt", "world", "universe")
      expect(result).toEqual({ ok: true })

      // Verify the write call
      const [, writeInit] = fetchMock.mock.calls[1]
      expect(writeInit.body).toBe("hello universe")
    })

    it("throws if old_string not found", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("hello world", { status: 200 }),
      )

      await expect(
        adapter.editFile("file.txt", "nonexistent", "replacement"),
      ).rejects.toThrow("not found")
    })

    it("throws if old_string is not unique", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("foo foo foo", { status: 200 }),
      )

      await expect(
        adapter.editFile("file.txt", "foo", "bar"),
      ).rejects.toThrow()
    })
  })

  describe("glob", () => {
    it("returns matching file paths", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { path: "src/a.ts", size: 100, mtime: 1000 },
            { path: "src/b.ts", size: 200, mtime: 2000 },
            { path: "readme.md", size: 50, mtime: 500 },
          ]),
          { status: 200 },
        ),
      )

      const files = await adapter.glob("**/*.ts")
      expect(files).toHaveLength(2)
      expect(files).toContain("src/a.ts")
      expect(files).toContain("src/b.ts")
    })
  })

  describe("list", () => {
    it("returns file listing", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { path: "src/a.ts", size: 100 },
            { path: "src/b.ts", size: 200 },
          ]),
          { status: 200 },
        ),
      )

      const files = await adapter.list()
      expect(files).toHaveLength(2)
      expect(files[0].path).toBe("src/a.ts")
    })
  })
})
