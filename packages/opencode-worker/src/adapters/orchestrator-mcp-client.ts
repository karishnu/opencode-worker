import type { SpaceInfo } from "../types"

/**
 * MCP JSON-RPC client for the orchestrator (DO-Git management instance).
 *
 * Talks to the orchestrator's `/mcp` endpoint via stateless POST
 * requests using the MCP Streamable HTTP transport (JSON-RPC over HTTP).
 * Auth is Bearer token.
 */
export class OrchestratorMcpClient {
  private idCounter = 0

  constructor(
    private readonly orchestratorUrl: string,
    private readonly apiKey: string,
  ) {}

  private url(): string {
    return `${this.orchestratorUrl.replace(/\/+$/, "")}/mcp`
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
  }

  private nextId(): number {
    return ++this.idCounter
  }

  /**
   * Low-level: send a JSON-RPC request to the orchestrator MCP endpoint.
   * Handles both direct JSON responses and SSE-wrapped responses.
   */
  private async jsonRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
      id: this.nextId(),
    }

    const res = await fetch(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Orchestrator MCP error (${res.status}): ${err}`)
    }

    const contentType = res.headers.get("content-type") || ""

    // SSE response — parse event stream for JSON-RPC result
    if (contentType.includes("text/event-stream")) {
      return this.parseSSEResponse(res)
    }

    // Direct JSON response
    const json = (await res.json()) as {
      result?: unknown
      error?: { code: number; message: string }
    }
    if (json.error) {
      throw new Error(`MCP RPC error ${json.error.code}: ${json.error.message}`)
    }
    return json.result
  }

  /**
   * Parse an SSE response stream to extract the JSON-RPC result.
   */
  private async parseSSEResponse(res: Response): Promise<unknown> {
    const text = await res.text()
    console.log("[MCP:SSE] raw response:", text)
    const lines = text.split("\n")
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim()
        if (!data) continue
        try {
          const json = JSON.parse(data) as {
            result?: unknown
            error?: { code: number; message: string }
          }
          console.log("[MCP:SSE] parsed json-rpc:", JSON.stringify(json))
          if (json.error) {
            throw new Error(`MCP RPC error ${json.error.code}: ${json.error.message}`)
          }
          if (json.result !== undefined) {
            return json.result
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue
          throw e
        }
      }
    }
    throw new Error("No JSON-RPC result found in SSE response")
  }

  /**
   * Initialize the MCP session (required before tool calls).
   * Returns the session ID from the Mcp-Session header if present.
   */
  async initialize(): Promise<string | null> {
    const body = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "opencode-worker", version: "0.1.0" },
      },
      id: this.nextId(),
    }

    const res = await fetch(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`MCP initialize failed (${res.status}): ${err}`)
    }

    const sessionId = res.headers.get("mcp-session-id")

    // Send initialized notification
    await fetch(this.url(), {
      method: "POST",
      headers: {
        ...this.headers(),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    })

    return sessionId
  }

  /**
   * Call an MCP tool on the orchestrator.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    const result = await this.jsonRpc("tools/call", { name, arguments: args })
    return result as { content: Array<{ type: string; text: string }> }
  }

  // ── High-level methods ──────────────────────────────────────────

  async createSpace(
    name: string,
    apiKey?: string,
  ): Promise<{ name: string; url: string; apiKey: string }> {
    const args: Record<string, unknown> = { name }
    if (apiKey) args.api_key = apiKey
    const result = await this.callTool("create_space", args)
    console.log("[MCP:createSpace] callTool result:", JSON.stringify(result))
    const text = result.content.find((c) => c.type === "text")?.text
    console.log("[MCP:createSpace] text content:", text)
    if (!text) throw new Error("No text content in create_space response")
    const parsed = JSON.parse(text) as { name: string; url: string; api_key?: string; apiKey?: string }
    return { name: parsed.name, url: parsed.url, apiKey: parsed.apiKey || parsed.api_key || "" }
  }

  async listSpaces(): Promise<SpaceInfo[]> {
    const result = await this.callTool("list_spaces")
    const text = result.content.find((c) => c.type === "text")?.text
    if (!text) throw new Error("No text content in list_spaces response")
    if (text === "No spaces found.") return []
    return JSON.parse(text) as SpaceInfo[]
  }

  async deleteSpace(name: string): Promise<void> {
    await this.callTool("delete_space", { name })
  }
}
