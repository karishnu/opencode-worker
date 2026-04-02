import type { WorkspaceAdapter } from "../types"
import { tool } from "ai"
import { z } from "zod"

/**
 * Build the full set of AI SDK tools backed by a WorkspaceAdapter.
 * Uses AI SDK v6's tool() with inputSchema (FlexibleSchema accepts Zod).
 * execute receives (input, options) — input IS the parsed args directly.
 */
export function createTools(workspace: WorkspaceAdapter) {
  return {
    read: createReadTool(workspace),
    write: createWriteTool(workspace),
    edit: createEditTool(workspace),
    glob: createGlobTool(workspace),
    grep: createGrepTool(workspace),
    list: createListTool(workspace),
    patch: createPatchTool(workspace),
    git_commit: createGitCommitTool(workspace),
    git_log: createGitLogTool(workspace),
    git_status: createGitStatusTool(workspace),
    bash: createBashStub(),
  }
}

// ── Individual Tool Factories ─────────────────────────────────────

function createReadTool(ws: WorkspaceAdapter) {
  return tool({
    description:
      "Read the contents of a file or directory from the workspace. " +
      "Supports optional line range with 1-indexed offset and limit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the file or directory to read"),
      offset: z.number().int().min(1).optional().describe("1-indexed start line"),
      limit: z.number().int().min(1).optional().describe("Number of lines to return"),
    }),
    execute: async (args) => {
      return ws.readFile(args.path, {
        offset: args.offset,
        limit: args.limit,
      })
    },
  })
}

function createWriteTool(ws: WorkspaceAdapter) {
  return tool({
    description: "Create or overwrite a file in the workspace.",
    inputSchema: z.object({
      path: z.string().describe("File path to write"),
      content: z.string().describe("File content"),
    }),
    execute: async (args) => {
      const result = await ws.writeFile(args.path, args.content)
      return JSON.stringify(result)
    },
  })
}

function createEditTool(ws: WorkspaceAdapter) {
  return tool({
    description:
      "Find and replace an exact string in a file. " +
      "The old_string must be unique in the file.",
    inputSchema: z.object({
      path: z.string().describe("File path to edit"),
      old_string: z.string().describe("Exact text to find (must be unique)"),
      new_string: z.string().describe("Replacement text"),
    }),
    execute: async (args) => {
      const result = await ws.editFile(args.path, args.old_string, args.new_string)
      return JSON.stringify(result)
    },
  })
}

function createGlobTool(ws: WorkspaceAdapter) {
  return tool({
    description:
      "Find files matching a glob pattern in the workspace. " +
      "Returns matching file paths sorted by modification time.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/*.js')"),
    }),
    execute: async (args) => {
      const files = await ws.glob(args.pattern)
      if (files.length === 0) return "No files matched."
      return files.join("\n")
    },
  })
}

function createGrepTool(ws: WorkspaceAdapter) {
  return tool({
    description:
      "Search file contents in the workspace using a regular expression. " +
      "Returns matching lines with file paths and line numbers.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      include: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
    }),
    execute: async (args) => {
      const matches = await ws.grep(args.pattern, args.include)
      if (matches.length === 0) return "No matches found."
      return matches.map((m) => `${m.path}:${m.line}:${m.content}`).join("\n")
    },
  })
}

function createListTool(ws: WorkspaceAdapter) {
  return tool({
    description: "List files and directories in the workspace, optionally filtered by a path prefix.",
    inputSchema: z.object({
      prefix: z.string().optional().describe("Path prefix to filter by"),
    }),
    execute: async (args) => {
      const files = await ws.list(args.prefix)
      if (files.length === 0) return "No files found."
      return JSON.stringify(files, null, 2)
    },
  })
}

function createPatchTool(ws: WorkspaceAdapter) {
  return tool({
    description: "Apply a unified diff to one or more files in the workspace.",
    inputSchema: z.object({
      diff: z.string().describe("Unified diff content"),
    }),
    execute: async (args) => {
      const result = await ws.patch(args.diff)
      const lines: string[] = []
      for (const p of result.applied) lines.push(`Patched: ${p}`)
      for (const p of result.failed) lines.push(`Failed: ${p}`)
      return lines.join("\n")
    },
  })
}

function createGitCommitTool(ws: WorkspaceAdapter) {
  return tool({
    description: "Commit all working tree files in the workspace.",
    inputSchema: z.object({
      message: z.string().describe("Commit message"),
      author_name: z.string().optional().describe("Author name"),
      author_email: z.string().optional().describe("Author email"),
    }),
    execute: async (args) => {
      const author =
        args.author_name || args.author_email
          ? {
              name: args.author_name ?? "AgentSpace",
              email: args.author_email ?? "agent@agent-space.workers.dev",
            }
          : undefined
      const result = await ws.gitCommit(args.message, author)
      return JSON.stringify(result)
    },
  })
}

function createGitLogTool(ws: WorkspaceAdapter) {
  return tool({
    description: "View commit history of the workspace.",
    inputSchema: z.object({
      depth: z.number().int().min(1).optional().describe("Max number of commits to return"),
    }),
    execute: async (args) => {
      const entries = await ws.gitLog(args.depth)
      if (entries.length === 0) return "No commits found."
      return JSON.stringify(entries, null, 2)
    },
  })
}

function createGitStatusTool(ws: WorkspaceAdapter) {
  return tool({
    description: "List files in the workspace's working tree with their modification times.",
    inputSchema: z.object({}),
    execute: async () => {
      const entries = await ws.gitStatus()
      if (entries.length === 0) return "Working tree is empty."
      return entries
        .map((e) => {
          const date = new Date(e.mtime || Date.now()).toISOString()
          return `${date}  ${e.path}`
        })
        .join("\n")
    },
  })
}

function createBashStub() {
  return tool({
    description:
      "Execute a shell command. NOTE: Shell execution is not available " +
      "in the Workers environment. Use the other workspace tools instead.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to run"),
    }),
    execute: async () => {
      return "Error: Shell execution is not available in the Cloudflare Workers environment. Use the workspace tools (read, write, edit, grep, glob, git_commit, etc.) instead."
    },
  })
}
