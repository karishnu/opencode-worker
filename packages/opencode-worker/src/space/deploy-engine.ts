import type { Git } from "@cloudflare/shell/git"
import type { Workspace } from "@cloudflare/shell"
import { createWorker } from "@cloudflare/worker-bundler"
import { jsonResponse } from "./git-pack"

// ─── Deploy Engine ──────────────────────────────────────────────────────────

export interface DeployContext {
  sql: SqlStorage
  git: Git
  workspace: Workspace
}

export async function handleDeployCommand(
  ctx: DeployContext,
  cmd: string,
  request: Request
): Promise<Response> {
  try {
    switch (cmd) {
      case "deploy":
        return await deployBranch(ctx, request)
      case "get_deployment":
        return await getDeployment(ctx, request)
      case "list_deployments":
        return await listDeployments(ctx)
      case "undeploy":
        return await undeployBranch(ctx, request)
      default:
        return jsonResponse({ error: `Unknown deploy command: ${cmd}` }, 400)
    }
  } catch (e: any) {
    return jsonResponse({ error: e.message ?? String(e) }, 500)
  }
}

// ─── Read files from a git branch using shell's git ─────────────────────────

async function readBranchFiles(
  ctx: DeployContext,
  branch: string
): Promise<{ commitHash: string; files: Record<string, string> }> {
  // Get commit log for the branch to find the commit hash
  const log = await ctx.git.log({ ref: branch, depth: 1 })
  if (log.length === 0) {
    throw new Error(`No commits found on branch "${branch}"`)
  }
  const commitHash = log[0].oid

  // Checkout the branch to populate working tree
  await ctx.git.checkout({ ref: branch })

  // Read all files recursively (readDir is non-recursive, glob is)
  const allFiles = await ctx.workspace.glob("**/*")
  const files: Record<string, string> = {}

  for (const fileInfo of allFiles) {
    if (fileInfo.type !== "file") continue
    if (fileInfo.path.startsWith("/.git/") || fileInfo.path === "/.git") continue

    const content = await ctx.workspace.readFile(fileInfo.path)
    if (content !== null) {
      const path = fileInfo.path.startsWith("/") ? fileInfo.path.slice(1) : fileInfo.path
      files[path] = content
    }
  }

  return { commitHash, files }
}

// ─── Deploy a branch ────────────────────────────────────────────────────────

async function deployBranch(
  ctx: DeployContext,
  request: Request
): Promise<Response> {
  const body = (await request.json()) as { branch: string }
  const branch = body.branch
  if (!branch) {
    return jsonResponse({ error: "branch is required" }, 400)
  }

  const { commitHash, files } = await readBranchFiles(ctx, branch)

  if (Object.keys(files).length === 0) {
    return jsonResponse({ error: `No files found in branch "${branch}"` }, 400)
  }

  let mainModule: string
  let serializedModules: Record<string, string | Record<string, unknown>>

  try {
    const result = await createWorker({ files })
    mainModule = result.mainModule
    serializedModules = {}
    for (const [name, value] of Object.entries(result.modules)) {
      serializedModules[name] = typeof value === "string" ? value : (value as Record<string, unknown>)
    }

    // Inject __STATIC_CONTENT_MANIFEST if the bundler left it as an external import.
    // Many frameworks (Hono, Workers Sites) import this Wrangler-injected module;
    // Dynamic Workers don't provide it automatically, so we supply an empty manifest.
    if (!serializedModules["__STATIC_CONTENT_MANIFEST"]) {
      serializedModules["__STATIC_CONTENT_MANIFEST"] = { text: "{}" }
    }
  } catch (e: any) {
    return jsonResponse({
      error: "Build failed",
      details: e.message ?? String(e),
    }, 400)
  }

  const now = Date.now()
  ctx.sql.exec(
    `INSERT OR REPLACE INTO deployments (branch, commit_hash, main_module, modules, deployed_at)
     VALUES (?, ?, ?, ?, ?)`,
    branch,
    commitHash,
    mainModule,
    JSON.stringify(serializedModules),
    now
  )

  return jsonResponse({
    branch,
    commit_hash: commitHash,
    main_module: mainModule,
    deployed_at: new Date(now).toISOString(),
  })
}

// ─── Get a deployment ───────────────────────────────────────────────────────

async function getDeployment(
  ctx: DeployContext,
  request: Request
): Promise<Response> {
  const url = new URL(request.url)
  const branch = url.searchParams.get("branch")
  if (!branch) {
    return jsonResponse({ error: "branch query param is required" }, 400)
  }

  const row = ctx.sql
    .exec(
      "SELECT branch, commit_hash, main_module, modules, deployed_at FROM deployments WHERE branch = ?",
      branch
    )
    .toArray()

  if (row.length === 0) {
    return jsonResponse({ error: `No deployment found for branch "${branch}"` }, 404)
  }

  const r = row[0]
  return jsonResponse({
    branch: r.branch as string,
    commit_hash: r.commit_hash as string,
    main_module: r.main_module as string,
    modules: JSON.parse(r.modules as string),
    deployed_at: new Date(r.deployed_at as number).toISOString(),
  })
}

// ─── List deployments ───────────────────────────────────────────────────────

async function listDeployments(ctx: DeployContext): Promise<Response> {
  const rows = ctx.sql
    .exec("SELECT branch, commit_hash, main_module, deployed_at FROM deployments ORDER BY deployed_at DESC")
    .toArray()

  const deployments = rows.map((r) => ({
    branch: r.branch as string,
    commit_hash: r.commit_hash as string,
    main_module: r.main_module as string,
    deployed_at: new Date(r.deployed_at as number).toISOString(),
  }))

  return jsonResponse(deployments)
}

// ─── Undeploy a branch ──────────────────────────────────────────────────────

async function undeployBranch(
  ctx: DeployContext,
  request: Request
): Promise<Response> {
  const body = (await request.json()) as { branch: string }
  const branch = body.branch
  if (!branch) {
    return jsonResponse({ error: "branch is required" }, 400)
  }

  const result = ctx.sql.exec(
    "DELETE FROM deployments WHERE branch = ?",
    branch
  )

  if (result.rowsWritten === 0) {
    return jsonResponse({ error: `No deployment found for branch "${branch}"` }, 404)
  }

  return jsonResponse({ ok: true, branch })
}
