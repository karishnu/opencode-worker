import type { SpaceManager, SpaceInfo } from "../types"

/**
 * SpaceManager implementation backed by Agent Space management API.
 *
 * The management URL is the top-level Agent Space worker that
 * handles space lifecycle (create, list, delete).
 */
export class AgentSpaceManager implements SpaceManager {
  constructor(
    private readonly managementUrl: string,
    private readonly apiKey: string,
  ) {}

  private url(path: string): string {
    const base = this.managementUrl.replace(/\/+$/, "")
    return `${base}/${path.replace(/^\/+/, "")}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      ...extra,
    }
  }

  async createSpace(name: string): Promise<{ url: string; apiKey: string }> {
    const res = await fetch(this.url("spaces"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Failed to create space '${name}': ${err}`)
    }
    return (await res.json()) as { url: string; apiKey: string }
  }

  async listSpaces(): Promise<SpaceInfo[]> {
    const res = await fetch(this.url("spaces"), {
      headers: this.headers(),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Failed to list spaces: ${err}`)
    }
    return (await res.json()) as SpaceInfo[]
  }

  async deleteSpace(nameOrId: string): Promise<void> {
    const res = await fetch(
      this.url(`spaces/${encodeURIComponent(nameOrId)}`),
      {
        method: "DELETE",
        headers: this.headers(),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Failed to delete space '${nameOrId}': ${err}`)
    }
  }
}
