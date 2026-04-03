import type {
  WorkspaceAdapter,
  FileEntry,
  GrepMatch,
  CommitResult,
  CommitLogEntry,
  GitStatusEntry,
  PatchResult,
  DeployResult,
  UndeployResult,
  DeploymentInfo,
} from "../types"

/**
 * WorkspaceAdapter implementation backed by Agent Space REST API.
 *
 * Every method delegates to the space's HTTP endpoints using
 * `X-API-Key` header authentication.
 */
export class AgentSpaceWorkspaceAdapter implements WorkspaceAdapter {
  constructor(
    private readonly spaceUrl: string,
    private readonly apiKey: string,
  ) {}

  private url(path: string): string {
    const base = this.spaceUrl.replace(/\/+$/, "")
    return `${base}/${path.replace(/^\/+/, "")}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { "X-API-Key": this.apiKey, ...extra }
  }

  // ── Filesystem ──────────────────────────────────────────────────

  async readFile(
    path: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string> {
    const url = this.url(path)
    console.log(`[space:readFile] GET ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:readFile] ${res.status} ${path}: ${err}`)
      throw new Error(`Failed to read ${path}: ${err}`)
    }
    console.log(`[space:readFile] ${res.status} ${path}`)
    let text = await res.text()

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const lines = text.split("\n")
      const start = (opts.offset ?? 1) - 1
      const end = opts.limit !== undefined ? start + opts.limit : lines.length
      text = lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n")
    }

    return text
  }

  async writeFile(
    path: string,
    content: string,
  ): Promise<{ path: string; size: number }> {
    const url = this.url(path)
    console.log(`[space:writeFile] PUT ${url} (${content.length} bytes)`)
    const res = await fetch(url, {
      method: "PUT",
      headers: this.headers(),
      body: content,
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:writeFile] ${res.status} ${path}: ${err}`)
      throw new Error(`Failed to write ${path}: ${err}`)
    }
    const data = (await res.json()) as { path: string; size: number }
    console.log(`[space:writeFile] ${res.status} ${path} → ${data.size} bytes`)
    return data
  }

  async editFile(
    path: string,
    oldString: string,
    newString: string,
  ): Promise<{ path: string; size: number }> {
    const text = await this.readFile(path)
    const count = text.split(oldString).length - 1
    if (count === 0) {
      throw new Error(`old_string not found in ${path}`)
    }
    if (count > 1) {
      throw new Error(
        `old_string found ${count} times in ${path} (must be unique)`,
      )
    }
    const newText = text.replace(oldString, newString)
    return this.writeFile(path, newText)
  }

  async glob(pattern: string): Promise<string[]> {
    const files = await this.list()
    const re = globToRegex(pattern)
    return files
      .filter((f) => re.test(f.path))
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => f.path)
  }

  async grep(query: string, include?: string): Promise<GrepMatch[]> {
    const files = await this.list()
    const includeRe = include ? globToRegex(include) : null
    const searchRe = new RegExp(query, "gi")
    const results: GrepMatch[] = []

    for (const file of files) {
      if (includeRe && !includeRe.test(file.path)) continue
      let text: string
      try {
        text = await this.readFile(file.path)
      } catch {
        continue
      }
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (searchRe.test(lines[i])) {
          results.push({ path: file.path, line: i + 1, content: lines[i] })
        }
        searchRe.lastIndex = 0
      }
    }

    return results
  }

  async list(prefix?: string): Promise<FileEntry[]> {
    const queryPath = prefix ? `${prefix}?list` : "?list"
    const url = this.url(queryPath)
    console.log(`[space:list] GET ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:list] ${res.status}: ${err}`)
      throw new Error(`Failed to list files: ${err}`)
    }
    const data = (await res.json()) as FileEntry[]
    console.log(`[space:list] ${res.status} → ${data.length} entries`)
    return data
  }

  async patch(diff: string): Promise<PatchResult> {
    const filePatches = parseUnifiedDiff(diff)
    const applied: string[] = []
    const failed: string[] = []

    for (const fp of filePatches) {
      try {
        let lines: string[] = []
        try {
          const text = await this.readFile(fp.path)
          lines = text.split("\n")
        } catch {
          // file doesn't exist yet, start empty
        }

        const sortedHunks = [...fp.hunks].sort(
          (a, b) => b.oldStart - a.oldStart,
        )
        for (const hunk of sortedHunks) {
          const newLines: string[] = []
          for (const hl of hunk.lines) {
            if (hl.type === "add" || hl.type === "context") {
              newLines.push(hl.content)
            }
          }
          const removeCount = hunk.lines.filter(
            (l) => l.type === "remove" || l.type === "context",
          ).length
          lines.splice(hunk.oldStart - 1, removeCount, ...newLines)
        }

        await this.writeFile(fp.path, lines.join("\n"))
        applied.push(fp.path)
      } catch {
        failed.push(fp.path)
      }
    }

    return { applied, failed }
  }

  // ── Git ─────────────────────────────────────────────────────────

  async gitCommit(
    message: string,
    author?: { name: string; email: string },
  ): Promise<CommitResult> {
    const body: Record<string, unknown> = { message }
    if (author) {
      body.author = author
    }
    const url = this.url("?cmd=commit")
    console.log(`[space:gitCommit] POST ${url}`, JSON.stringify(body))
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:gitCommit] ${res.status}: ${err}`)
      throw new Error(`Git commit failed: ${err}`)
    }
    const data = (await res.json()) as CommitResult
    console.log(`[space:gitCommit] ${res.status} → ${JSON.stringify(data)}`)
    return data
  }

  async gitLog(limit?: number): Promise<CommitLogEntry[]> {
    const url = limit
      ? this.url(`?cmd=log&limit=${limit}`)
      : this.url("?cmd=log")
    console.log(`[space:gitLog] GET ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:gitLog] ${res.status}: ${err}`)
      throw new Error(`Git log failed: ${err}`)
    }
    const data = (await res.json()) as CommitLogEntry[]
    console.log(`[space:gitLog] ${res.status} → ${data.length} entries`)
    return data
  }

  async gitStatus(): Promise<GitStatusEntry[]> {
    // Use ?list endpoint like DO-Git does (returns files with mtime)
    const files = await this.list()
    return files.map((f) => ({ path: f.path, mtime: f.mtime }))
  }

  // ── Deploy ──────────────────────────────────────────────────────

  async deploy(branch: string): Promise<DeployResult> {
    const url = this.url("?cmd=deploy")
    console.log(`[space:deploy] POST ${url} branch=${branch}`)
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ branch }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:deploy] ${res.status}: ${err}`)
      throw new Error(`Deploy failed: ${err}`)
    }
    const data = (await res.json()) as DeployResult
    console.log(`[space:deploy] ${res.status} → ${JSON.stringify(data)}`)
    return data
  }

  async undeploy(branch: string): Promise<UndeployResult> {
    const url = this.url("?cmd=undeploy")
    console.log(`[space:undeploy] POST ${url} branch=${branch}`)
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ branch }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:undeploy] ${res.status}: ${err}`)
      throw new Error(`Undeploy failed: ${err}`)
    }
    const data = (await res.json()) as UndeployResult
    console.log(`[space:undeploy] ${res.status} → ${JSON.stringify(data)}`)
    return data
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const url = this.url("?cmd=list_deployments")
    console.log(`[space:listDeployments] GET ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:listDeployments] ${res.status}: ${err}`)
      throw new Error(`List deployments failed: ${err}`)
    }
    const data = (await res.json()) as DeploymentInfo[]
    console.log(`[space:listDeployments] ${res.status} → ${data.length} deployments`)
    return data
  }

  async getDeployment(branch: string): Promise<DeploymentInfo> {
    const url = this.url(`?cmd=get_deployment&branch=${encodeURIComponent(branch)}`)
    console.log(`[space:getDeployment] GET ${url}`)
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) {
      const err = await res.text()
      console.error(`[space:getDeployment] ${res.status}: ${err}`)
      throw new Error(`Get deployment failed: ${err}`)
    }
    const data = (await res.json()) as DeploymentInfo
    console.log(`[space:getDeployment] ${res.status} → ${JSON.stringify(data)}`)
    return data
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  let re = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"
        i++
        if (pattern[i + 1] === "/") i++
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (c === ".") {
      re += "\\."
    } else {
      re += c
    }
  }
  re += "$"
  return new RegExp(re)
}

interface HunkLine {
  type: "add" | "remove" | "context"
  content: string
}

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

interface FilePatch {
  path: string
  hunks: Hunk[]
}

function parseUnifiedDiff(diff: string): FilePatch[] {
  const patches: FilePatch[] = []
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
        const hunks: Hunk[] = []

        while (i < lines.length && lines[i].startsWith("@@ ")) {
          const match = lines[i].match(
            /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
          )
          if (!match) {
            i++
            continue
          }
          const hunk: Hunk = {
            oldStart: parseInt(match[1]),
            oldCount: parseInt(match[2] ?? "1"),
            newStart: parseInt(match[3]),
            newCount: parseInt(match[4] ?? "1"),
            lines: [],
          }
          i++

          while (i < lines.length) {
            const l = lines[i]
            if (l.startsWith("+") && !l.startsWith("+++")) {
              hunk.lines.push({ type: "add", content: l.slice(1) })
            } else if (l.startsWith("-") && !l.startsWith("---")) {
              hunk.lines.push({ type: "remove", content: l.slice(1) })
            } else if (l.startsWith(" ") || l === "") {
              hunk.lines.push({ type: "context", content: l.slice(1) })
            } else {
              break
            }
            i++
          }
          hunks.push(hunk)
        }

        patches.push({ path, hunks })
        continue
      }
    }
    i++
  }

  return patches
}
