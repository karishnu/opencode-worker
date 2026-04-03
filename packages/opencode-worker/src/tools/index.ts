import type { WorkspaceAdapter, SpaceMapping } from "../types"
import type { OrchestratorMcpClient } from "../adapters/orchestrator-mcp-client"
import { tool } from "ai"
import { z } from "zod"

export interface ToolsContext {
  resolveWorkspace: (spaceName: string) => WorkspaceAdapter
  orchestrator: OrchestratorMcpClient
  sessionId: string
  spaceStore: {
    add: (name: string, url: string, apiKey: string) => void
    remove: (name: string) => void
    list: () => SpaceMapping[]
    get: (name: string) => SpaceMapping | null
  }
}

/**
 * Build the full set of AI SDK tools.
 *
 * Workspace tools require a `space` parameter to target a specific agent space.
 * Space management tools interact with the orchestrator and session↔space mappings.
 */
export function createTools(ctx: ToolsContext) {
  return {
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
    list: createListTool(ctx),
    patch: createPatchTool(ctx),
    git_commit: createGitCommitTool(ctx),
    git_log: createGitLogTool(ctx),
    git_status: createGitStatusTool(ctx),
    deploy: createDeployTool(ctx),
    undeploy: createUndeployTool(ctx),
    list_deployments: createListDeploymentsTool(ctx),
    get_deployment: createGetDeploymentTool(ctx),
    bash: createBashStub(),
    create_space: createCreateSpaceTool(ctx),
    list_spaces: createListSpacesTool(ctx),
    delete_space: createDeleteSpaceTool(ctx),
    attach_space: createAttachSpaceTool(ctx),
    detach_space: createDetachSpaceTool(ctx),
    list_session_spaces: createListSessionSpacesTool(ctx),
  }
}

// ── Workspace Tool Factories (require `space` parameter) ─────────

const spaceParam = z.string().describe("Name of the agent space to target")

function createReadTool(ctx: ToolsContext) {
  return tool({
    description:
      "Read the contents of a file or directory from an agent space. " +
      "Supports optional line range with 1-indexed offset and limit.",
    inputSchema: z.object({
      space: spaceParam,
      filePath: z.string().describe("Path to the file or directory to read"),
      offset: z.number().int().min(1).optional().describe("1-indexed start line"),
      limit: z.number().int().min(1).optional().describe("Number of lines to return"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      return ws.readFile(args.filePath, {
        offset: args.offset,
        limit: args.limit,
      })
    },
  })
}

function createWriteTool(ctx: ToolsContext) {
  return tool({
    description: "Create or overwrite a file in an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      filePath: z.string().describe("File path to write"),
      content: z.string().describe("File content"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const result = await ws.writeFile(args.filePath, args.content)
      return JSON.stringify(result)
    },
  })
}

function createEditTool(ctx: ToolsContext) {
  return tool({
    description:
      "Find and replace an exact string in a file within an agent space. " +
      "The old_string must be unique in the file.",
    inputSchema: z.object({
      space: spaceParam,
      filePath: z.string().describe("File path to edit"),
      old_string: z.string().describe("Exact text to find (must be unique)"),
      new_string: z.string().describe("Replacement text"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const result = await ws.editFile(args.filePath, args.old_string, args.new_string)
      return JSON.stringify(result)
    },
  })
}

function createGlobTool(ctx: ToolsContext) {
  return tool({
    description:
      "Find files matching a glob pattern in an agent space. " +
      "Returns matching file paths sorted by modification time.",
    inputSchema: z.object({
      space: spaceParam,
      pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/*.js')"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const files = await ws.glob(args.pattern)
      if (files.length === 0) return "No files matched."
      return files.join("\n")
    },
  })
}

function createGrepTool(ctx: ToolsContext) {
  return tool({
    description:
      "Search file contents in an agent space using a regular expression. " +
      "Returns matching lines with file paths and line numbers.",
    inputSchema: z.object({
      space: spaceParam,
      pattern: z.string().describe("Regex pattern to search for"),
      include: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const matches = await ws.grep(args.pattern, args.include)
      if (matches.length === 0) return "No matches found."
      return matches.map((m) => `${m.path}:${m.line}:${m.content}`).join("\n")
    },
  })
}

function createListTool(ctx: ToolsContext) {
  return tool({
    description: "List files and directories in an agent space, optionally filtered by a path prefix.",
    inputSchema: z.object({
      space: spaceParam,
      path: z.string().optional().describe("Directory path to list"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const files = await ws.list(args.path)
      if (files.length === 0) return "No files found."
      return JSON.stringify(files, null, 2)
    },
  })
}

function createPatchTool(ctx: ToolsContext) {
  return tool({
    description: "Apply a unified diff to one or more files in an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      diff: z.string().describe("Unified diff content"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const result = await ws.patch(args.diff)
      const lines: string[] = []
      for (const p of result.applied) lines.push(`Patched: ${p}`)
      for (const p of result.failed) lines.push(`Failed: ${p}`)
      return lines.join("\n")
    },
  })
}

function createGitCommitTool(ctx: ToolsContext) {
  return tool({
    description: "Commit all working tree files in an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      message: z.string().describe("Commit message"),
      author_name: z.string().optional().describe("Author name"),
      author_email: z.string().optional().describe("Author email"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
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

function createGitLogTool(ctx: ToolsContext) {
  return tool({
    description: "View commit history of an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      depth: z.number().int().min(1).optional().describe("Max number of commits to return"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const entries = await ws.gitLog(args.depth)
      if (entries.length === 0) return "No commits found."
      return JSON.stringify(entries, null, 2)
    },
  })
}

function createGitStatusTool(ctx: ToolsContext) {
  return tool({
    description: "List files in an agent space's working tree with their modification times.",
    inputSchema: z.object({
      space: spaceParam,
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
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

function createDeployTool(ctx: ToolsContext) {
  return tool({
    description:
      "Deploy code from a git branch in an agent space as a dynamic worker. " +
      "Returns the deployment metadata including the release URL.",
    inputSchema: z.object({
      space: spaceParam,
      branch: z.string().describe("Git branch name to deploy (e.g. 'release', 'main', 'feature/ui')"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const data = await ws.deploy(args.branch)
      const mapping = ctx.spaceStore.get(args.space)
      const url = mapping?.spaceUrl?.replace(/\/+$/, "")
      return JSON.stringify(
        { ...data, ...(url ? { release_url: `${url}/release/${args.branch}` } : {}) },
        null,
        2,
      )
    },
  })
}

function createUndeployTool(ctx: ToolsContext) {
  return tool({
    description: "Remove a deployed branch from an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      branch: z.string().describe("Branch name to undeploy"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const data = await ws.undeploy(args.branch)
      return JSON.stringify(data, null, 2)
    },
  })
}

function createListDeploymentsTool(ctx: ToolsContext) {
  return tool({
    description: "List all branch deployments in an agent space.",
    inputSchema: z.object({
      space: spaceParam,
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const data = await ws.listDeployments()
      if (data.length === 0) return "No deployments found."
      return JSON.stringify(data, null, 2)
    },
  })
}

function createGetDeploymentTool(ctx: ToolsContext) {
  return tool({
    description: "Get deployment metadata for a branch in an agent space.",
    inputSchema: z.object({
      space: spaceParam,
      branch: z.string().describe("Branch name to inspect"),
    }),
    execute: async (args) => {
      const ws = ctx.resolveWorkspace(args.space)
      const data = await ws.getDeployment(args.branch)
      return JSON.stringify(data, null, 2)
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

// ── Space Management Tool Factories ──────────────────────────────

function createCreateSpaceTool(ctx: ToolsContext) {
  return tool({
    description:
      "Create a new agent space via the orchestrator and attach it to the current session. " +
      "Returns the space URL and API key. The space is automatically attached to this session.",
    inputSchema: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Space name (lowercase alphanumeric + hyphens)"),
    }),
    execute: async (args) => {
      const result = await ctx.orchestrator.createSpace(args.name)
      ctx.spaceStore.add(args.name, result.url, result.apiKey)
      return JSON.stringify({
        name: args.name,
        url: result.url,
        apiKey: result.apiKey,
        attached: true,
      }, null, 2)
    },
  })
}

function createListSpacesTool(ctx: ToolsContext) {
  return tool({
    description: "List all agent spaces available on the orchestrator.",
    inputSchema: z.object({}),
    execute: async () => {
      const spaces = await ctx.orchestrator.listSpaces()
      if (spaces.length === 0) return "No spaces found."
      return JSON.stringify(spaces, null, 2)
    },
  })
}

function createDeleteSpaceTool(ctx: ToolsContext) {
  return tool({
    description: "Delete an agent space from the orchestrator. Also detaches it from the current session.",
    inputSchema: z.object({
      name: z.string().describe("Name of the space to delete"),
    }),
    execute: async (args) => {
      await ctx.orchestrator.deleteSpace(args.name)
      ctx.spaceStore.remove(args.name)
      return `Space "${args.name}" deleted and detached.`
    },
  })
}

function createAttachSpaceTool(ctx: ToolsContext) {
  return tool({
    description:
      "Attach an existing agent space to the current session. " +
      "Provide the space name, URL, and API key (from create_space or list_spaces).",
    inputSchema: z.object({
      name: z.string().describe("Space name"),
      url: z.string().describe("Space URL"),
      api_key: z.string().describe("Space API key"),
    }),
    execute: async (args) => {
      ctx.spaceStore.add(args.name, args.url, args.api_key)
      return `Space "${args.name}" attached to session.`
    },
  })
}

function createDetachSpaceTool(ctx: ToolsContext) {
  return tool({
    description: "Detach an agent space from the current session (does not delete the space).",
    inputSchema: z.object({
      name: z.string().describe("Name of the space to detach"),
    }),
    execute: async (args) => {
      ctx.spaceStore.remove(args.name)
      return `Space "${args.name}" detached from session.`
    },
  })
}

function createListSessionSpacesTool(ctx: ToolsContext) {
  return tool({
    description: "List all agent spaces attached to the current session.",
    inputSchema: z.object({}),
    execute: async () => {
      const mappings = ctx.spaceStore.list()
      if (mappings.length === 0) return "No spaces attached to this session."
      return JSON.stringify(
        mappings.map((m) => ({ name: m.spaceName, url: m.spaceUrl })),
        null,
        2,
      )
    },
  })
}
