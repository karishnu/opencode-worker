import { Hono } from "hono"
import type { Env } from "../env"
import type { SessionDO } from "../session/durable-object"
import type { SpaceDO } from "../space/durable-object"

type DashboardApp = Hono<{ Bindings: Env }>

function getSessionDO(env: Env): DurableObjectStub<SessionDO> {
  const id = env.SESSION_DO.idFromName("main")
  return env.SESSION_DO.get(id) as DurableObjectStub<SessionDO>
}

function getSpaceDO(env: Env, name: string): DurableObjectStub<SpaceDO> {
  const id = env.SPACE_DO.idFromName(name)
  return env.SPACE_DO.get(id) as DurableObjectStub<SpaceDO>
}

// ── Dashboard API routes ─────────────────────────────────────────────────────

export function dashboardApiRoutes(): DashboardApp {
  const app = new Hono<{ Bindings: Env }>()

  // List all known spaces with stats
  app.get("/", async (c) => {
    const session = getSessionDO(c.env)
    const names = await session.listAllSpaces()
    const spaces = await Promise.all(
      names.map(async (name) => {
        const space = getSpaceDO(c.env, name)
        try {
          const info = await space.getInfo()
          return { name, ...info }
        } catch {
          return { name, fileCount: 0, directoryCount: 0, totalBytes: 0 }
        }
      }),
    )
    return c.json(spaces)
  })

  // Space detail info (also registers the space so it appears in listings)
  app.get("/:name", async (c) => {
    const name = c.req.param("name")
    const space = getSpaceDO(c.env, name)
    const info = await space.getInfo()
    // Register in known_spaces so it shows up on the dashboard
    const session = getSessionDO(c.env)
    await session.registerSpace(name)
    return c.json({ name, ...info })
  })

  // File list (read-only, .git filtered)
  app.get("/:name/files", async (c) => {
    const space = getSpaceDO(c.env, c.req.param("name"))
    const files = await space.list()
    const filtered = files.filter((f: { path: string }) => {
      const p = f.path.replace(/^\//, "")
      return !p.startsWith(".git/") && p !== ".git"
    })
    return c.json(filtered)
  })

  // Read file (read-only)
  app.get("/:name/file", async (c) => {
    const space = getSpaceDO(c.env, c.req.param("name"))
    const raw = c.req.query("path")
    if (!raw) return c.json({ error: "path required" }, 400)
    const path = raw.startsWith("/") ? raw : "/" + raw
    try {
      const content = await space.readFile(path)
      return c.json({ path, content })
    } catch (e: any) {
      return c.json({ error: e.message }, 404)
    }
  })

  // Git log
  app.get("/:name/git/log", async (c) => {
    const space = getSpaceDO(c.env, c.req.param("name"))
    const limit = parseInt(c.req.query("limit") ?? "20", 10)
    try {
      const log = await space.gitLog(limit)
      return c.json(log)
    } catch {
      return c.json([])
    }
  })

  // Git status
  app.get("/:name/git/status", async (c) => {
    const space = getSpaceDO(c.env, c.req.param("name"))
    try {
      const status = await space.gitStatus()
      return c.json(status)
    } catch {
      return c.json([])
    }
  })

  // Deployments
  app.get("/:name/deployments", async (c) => {
    const space = getSpaceDO(c.env, c.req.param("name"))
    try {
      const deployments = await space.listDeployments()
      return c.json(deployments)
    } catch {
      return c.json([])
    }
  })

  return app
}

// ── Dashboard HTML SPA ───────────────────────────────────────────────────────

export function dashboardHtml(host: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Worker</title>
<script>
(function() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
  }
})();
</script>
<style>
:root {
  --cf-orange: #FF4801;
  --cf-orange-hover: #FF7038;
  --cf-orange-light: rgba(255, 72, 1, 0.06);
  --cf-text: #521000;
  --cf-text-muted: rgba(82, 16, 0, 0.6);
  --cf-text-subtle: rgba(82, 16, 0, 0.38);
  --cf-bg-page: #F5F1EB;
  --cf-bg-100: #FFFBF5;
  --cf-bg-200: #FFFDFB;
  --cf-bg-300: #FEF7ED;
  --cf-border: #EBD5C1;
  --cf-border-light: rgba(235, 213, 193, 0.5);
  --cf-success: #16A34A;
  --cf-success-bg: #DCF7E3;
  --cf-error: #DC2626;
  --cf-info: #2563EB;
  --cf-compute: #0A95FF;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "Fira Code", "Consolas", monospace;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
  --shadow-card: 0 1px 3px rgba(82, 16, 0, 0.04), 0 4px 12px rgba(82, 16, 0, 0.02);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-button: cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
:root.dark {
  --cf-orange: #F14602;
  --cf-orange-hover: #FF6D33;
  --cf-orange-light: rgba(241, 70, 2, 0.1);
  --cf-text: #F0E3DE;
  --cf-text-muted: rgba(255, 253, 251, 0.56);
  --cf-text-subtle: rgba(255, 253, 251, 0.3);
  --cf-bg-page: #0D0D0D;
  --cf-bg-100: #121212;
  --cf-bg-200: #191817;
  --cf-bg-300: #2A2927;
  --cf-border: rgba(240, 227, 222, 0.13);
  --cf-border-light: rgba(240, 227, 222, 0.08);
  --cf-success-bg: rgba(63, 185, 80, 0.15);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body {
  font-family: var(--font-sans);
  background: var(--cf-bg-page);
  color: var(--cf-text);
  line-height: 1.5;
  min-height: 100vh;
}
::selection {
  background-color: rgba(255, 72, 1, 0.2);
  color: var(--cf-text);
}

/* Layout */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
}

/* Header */
.header {
  background: var(--cf-bg-100);
  border-bottom: 1px solid var(--cf-border);
  padding: 16px 0;
  position: sticky;
  top: 0;
  z-index: 50;
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--cf-text);
  cursor: pointer;
  text-decoration: none;
}
.logo:hover { text-decoration: none; }
.logo svg { flex-shrink: 0; }
.logo-badge {
  background: var(--cf-orange);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.header-nav {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: 14px;
  font-weight: 500;
  border: 1px solid var(--cf-border);
  background: transparent;
  color: var(--cf-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
  text-decoration: none;
}
.nav-btn:hover {
  border-color: var(--cf-orange);
  color: var(--cf-orange);
  border-style: dashed;
}
.nav-btn.active {
  background: var(--cf-orange-light);
  color: var(--cf-orange);
  border-color: var(--cf-orange);
}

/* Space List */
.page-title {
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.035em;
  margin: 48px 0 8px;
}
.page-subtitle {
  color: var(--cf-text-muted);
  font-size: 16px;
  margin-bottom: 32px;
}
.space-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin-bottom: 64px;
}

/* Card */
.card {
  position: relative;
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: 0;
  padding: 24px;
  cursor: pointer;
  transition: border-style 0.15s ease, box-shadow 0.2s ease;
}
.card:hover {
  border-style: dashed;
  box-shadow: var(--shadow-card);
}
/* Corner brackets */
.card::before, .card::after,
.card .cb-bl, .card .cb-br {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1px solid var(--cf-border);
  border-radius: 1.5px;
  background: var(--cf-bg-page);
  pointer-events: none;
}
.card::before { top: -4px; left: -4px; }
.card::after { top: -4px; right: -4px; }
.card .cb-bl { bottom: -4px; left: -4px; }
.card .cb-br { bottom: -4px; right: -4px; }

.card-title {
  font-size: 18px;
  font-weight: 500;
  letter-spacing: -0.02em;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-title svg { color: var(--cf-orange); flex-shrink: 0; }
.card-stats {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}
.stat {
  display: flex;
  flex-direction: column;
}
.stat-value {
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.stat-label {
  font-size: 12px;
  color: var(--cf-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--cf-border-light);
}
.card-link {
  font-size: 14px;
  color: var(--cf-orange);
  font-weight: 500;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.card-link:hover { text-decoration: underline; }

/* Empty state */
.empty {
  text-align: center;
  padding: 80px 24px;
  color: var(--cf-text-muted);
}
.empty svg { opacity: 0.25; margin-bottom: 16px; }
.empty h3 {
  font-size: 18px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--cf-text);
}
.empty p { font-size: 14px; }

/* ─── Space Detail View ───────────────────────────────────────── */
.detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 32px 0 24px;
  flex-wrap: wrap;
}
.detail-title {
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.035em;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: 14px;
  font-weight: 500;
  border: 1px solid var(--cf-border);
  background: transparent;
  color: var(--cf-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}
.back-btn:hover {
  border-color: var(--cf-orange);
  color: var(--cf-orange);
  border-style: dashed;
}

/* Info bar */
.info-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}
.info-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-family: var(--font-mono);
  color: var(--cf-text-muted);
  user-select: all;
}
.info-chip svg { flex-shrink: 0; color: var(--cf-text-subtle); }
.info-chip .label {
  font-family: var(--font-sans);
  font-weight: 500;
  color: var(--cf-text);
  margin-right: 4px;
}
.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--cf-text-subtle);
  padding: 2px;
  display: inline-flex;
  transition: color 0.15s;
}
.copy-btn:hover { color: var(--cf-orange); }

/* Detail layout */
.detail-layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 16px;
  margin-bottom: 64px;
}
@media (max-width: 900px) {
  .detail-layout { grid-template-columns: 1fr; }
}

/* File browser */
.panel {
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: 0;
  overflow: hidden;
  position: relative;
}
.panel::before, .panel::after,
.panel .cb-bl, .panel .cb-br {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1px solid var(--cf-border);
  border-radius: 1.5px;
  background: var(--cf-bg-page);
  pointer-events: none;
  z-index: 2;
}
.panel::before { top: -4px; left: -4px; }
.panel::after { top: -4px; right: -4px; }
.panel .cb-bl { bottom: -4px; left: -4px; }
.panel .cb-br { bottom: -4px; right: -4px; }
.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--cf-border);
  background: var(--cf-bg-100);
  font-size: 14px;
  font-weight: 500;
}
.panel-header svg { color: var(--cf-text-subtle); flex-shrink: 0; }
.panel-body {
  max-height: 600px;
  overflow-y: auto;
}

/* File tree */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  font-size: 13px;
  border-bottom: 1px solid var(--cf-border-light);
  background: var(--cf-bg-100);
  flex-wrap: wrap;
}
.breadcrumb button {
  background: none;
  border: none;
  color: var(--cf-orange);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 3px;
  font-family: var(--font-mono);
}
.breadcrumb button:hover { background: var(--cf-orange-light); }
.breadcrumb .sep { color: var(--cf-text-subtle); }

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  cursor: pointer;
  font-size: 14px;
  border-bottom: 1px solid var(--cf-border-light);
  transition: background 0.1s;
}
.file-item:last-child { border-bottom: none; }
.file-item:hover { background: var(--cf-bg-300); }
.file-item.active { background: var(--cf-orange-light); }
.file-item .icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 13px; }
.file-item .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 13px;
}
.file-item .dir-icon { color: var(--cf-orange); }

/* Code viewer */
.code-viewer {
  display: none;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.code-viewer.open { display: flex; }
.code-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--cf-border);
  background: var(--cf-bg-100);
  font-size: 13px;
}
.code-path {
  font-family: var(--font-mono);
  color: var(--cf-text-muted);
  flex: 1;
}
.code-size {
  color: var(--cf-text-subtle);
  font-size: 12px;
}
.code-body {
  display: flex;
  flex: 1;
  overflow: auto;
  max-height: 520px;
  min-width: 0;
}
.line-nums {
  padding: 12px 0;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--cf-text-subtle);
  background: var(--cf-bg-100);
  border-right: 1px solid var(--cf-border-light);
  user-select: none;
  min-width: 48px;
  padding-right: 10px;
  padding-left: 10px;
  white-space: pre;
  overflow: hidden;
}
.code-content {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  padding: 12px 16px;
  white-space: pre;
  overflow-x: auto;
  tab-size: 2;
  color: var(--cf-text);
  background: var(--cf-bg-200);
}

/* Sidebar panels */
.sidebar-panel {
  margin-bottom: 16px;
}
.sidebar-panel:last-child { margin-bottom: 0; }

/* Git log */
.commit-item {
  padding: 10px 16px;
  border-bottom: 1px solid var(--cf-border-light);
  font-size: 13px;
}
.commit-item:last-child { border-bottom: none; }
.commit-msg {
  font-weight: 500;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-meta {
  font-size: 11px;
  color: var(--cf-text-muted);
  font-family: var(--font-mono);
}
.commit-sha {
  color: var(--cf-orange);
}

/* Deployments */
.deploy-item {
  padding: 10px 16px;
  border-bottom: 1px solid var(--cf-border-light);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.deploy-item:last-child { border-bottom: none; }
.deploy-branch {
  font-family: var(--font-mono);
  font-weight: 500;
}
.deploy-link {
  margin-left: auto;
  color: var(--cf-orange);
  font-size: 12px;
  text-decoration: none;
}
.deploy-link:hover { text-decoration: underline; }

/* Badge */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 500;
}
.badge-green {
  background: var(--cf-success-bg);
  color: var(--cf-success);
}
.badge-orange {
  background: var(--cf-orange-light);
  color: var(--cf-orange);
}

/* Connect bar */
.connect-bar {
  background: var(--cf-bg-200);
  border: 1px solid var(--cf-border);
  border-radius: var(--radius-md);
  padding: 16px 20px;
  margin-bottom: 32px;
}
.connect-label {
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cf-text-muted);
  margin-bottom: 8px;
}
.connect-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
}
.connect-cmd code {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--cf-text);
  background: var(--cf-bg-100);
  border: 1px solid var(--cf-border-light);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  flex: 1;
  overflow-x: auto;
  white-space: nowrap;
}
.connect-cmd code span {
  color: var(--cf-orange);
}

/* Loading */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--cf-text-muted);
  font-size: 14px;
  gap: 8px;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--cf-border);
  border-top-color: var(--cf-orange);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Animate in */
.fade-in {
  animation: fadeSlideUp 0.4s var(--ease-out) forwards;
}
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--cf-border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--cf-text-subtle); }

/* Dark mode theme toggle */
.theme-toggle {
  background: none;
  border: 1px solid var(--cf-border);
  border-radius: var(--radius-full);
  cursor: pointer;
  padding: 6px 8px;
  color: var(--cf-text-muted);
  display: inline-flex;
  align-items: center;
  transition: all 0.15s;
}
.theme-toggle:hover {
  border-color: var(--cf-orange);
  color: var(--cf-orange);
}
</style>
</head>
<body>

<header class="header">
  <div class="container header-inner">
    <a class="logo" onclick="showSpaceList()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      OpenCode
      <span class="logo-badge">Worker</span>
    </a>
    <nav class="header-nav">
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>
      </button>
    </nav>
  </div>
</header>

<main class="container">
  <!-- Space List View -->
  <div id="listView">
    <h1 class="page-title">Agent Spaces</h1>
    <p class="page-subtitle">Select a space to browse its files, git history, and deployments.</p>
    <div class="connect-bar">
      <div class="connect-label">Connect your client</div>
      <div class="connect-cmd" id="connectCmd">
        <code>opencode attach <span id="workerUrl"></span></code>
        <button class="copy-btn" onclick="copyText('opencode attach ' + document.getElementById('workerUrl').textContent)" title="Copy command">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
    </div>
    <div id="spaceGrid" class="space-grid">
      <div class="loading"><div class="spinner"></div> Loading spaces&hellip;</div>
    </div>
  </div>

  <!-- Space Detail View -->
  <div id="detailView" style="display:none">
    <div class="detail-header">
      <button class="back-btn" onclick="showSpaceList()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        Back
      </button>
      <h1 class="detail-title" id="detailTitle"></h1>
    </div>
    <div class="info-bar" id="infoBar"></div>
    <div class="detail-layout">
      <div style="min-width:0;overflow:hidden">
        <!-- File browser panel -->
        <div class="panel" style="min-height:400px;display:flex;flex-direction:column;overflow:hidden">
          <div class="cb-bl"></div><div class="cb-br"></div>
          <div class="panel-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            Files
          </div>
          <div class="breadcrumb" id="breadcrumb"></div>
          <div style="display:flex;flex:1;overflow:hidden;min-width:0">
            <div class="panel-body" id="fileList" style="width:260px;min-width:260px;max-width:260px;flex-shrink:0;border-right:1px solid var(--cf-border)"></div>
            <div class="code-viewer" id="codeViewer">
              <div class="code-header">
                <span class="code-path" id="codePath"></span>
                <span class="code-size" id="codeSize"></span>
              </div>
              <div class="code-body">
                <div class="line-nums" id="lineNums"></div>
                <div class="code-content" id="codeContent"></div>
              </div>
            </div>
            <div id="codeEmpty" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--cf-text-subtle);font-size:14px;padding:24px;text-align:center">
              Select a file to view its contents
            </div>
          </div>
        </div>
      </div>
      <div>
        <!-- Git log -->
        <div class="sidebar-panel panel">
          <div class="cb-bl"></div><div class="cb-br"></div>
          <div class="panel-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>
            Git Log
          </div>
          <div class="panel-body" id="gitLog" style="max-height:280px">
            <div class="loading"><div class="spinner"></div></div>
          </div>
        </div>
        <!-- Deployments -->
        <div class="sidebar-panel panel">
          <div class="cb-bl"></div><div class="cb-br"></div>
          <div class="panel-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Deployments
          </div>
          <div class="panel-body" id="deployList" style="max-height:200px">
            <div class="loading"><div class="spinner"></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>

<script>
const HOST = '${host}';
const API = '/api/spaces';

let currentSpace = null;
let allFiles = [];
let currentDir = '';
let currentFile = null;

// ── Theme ────────────────────────────────────────────────────────
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
}
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', e => document.documentElement.classList.toggle('dark', e.matches));

// ── Space List ───────────────────────────────────────────────────
async function loadSpaces() {
  const grid = document.getElementById('spaceGrid');
  try {
    const res = await fetch(API);
    const spaces = await res.json();
    if (!spaces.length) {
      grid.innerHTML = '<div class="empty fade-in">' +
        '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
        '<h3>No spaces yet</h3>' +
        '<p>Spaces are created when the agent uses the <code>create_space</code> tool during a session.</p>' +
        '</div>';
      return;
    }
    grid.innerHTML = spaces.map((s, i) =>
      '<div class="card fade-in" style="animation-delay:' + (i * 0.06) + 's" onclick="openSpace(\\'' + esc(s.name) + '\\')">' +
        '<div class="cb-bl"></div><div class="cb-br"></div>' +
        '<div class="card-title">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' +
          esc(s.name) +
        '</div>' +
        '<div class="card-stats">' +
          '<div class="stat"><span class="stat-value">' + s.fileCount + '</span><span class="stat-label">Files</span></div>' +
          '<div class="stat"><span class="stat-value">' + fmtBytes(s.totalBytes) + '</span><span class="stat-label">Size</span></div>' +
        '</div>' +
        '<div class="card-footer">' +
          '<span class="card-link">Browse files <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg></span>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch (e) {
    grid.innerHTML = '<div class="empty"><h3>Failed to load spaces</h3><p>' + esc(e.message) + '</p></div>';
  }
}

function showSpaceList() {
  currentSpace = null;
  currentFile = null;
  currentDir = '';
  document.getElementById('listView').style.display = '';
  document.getElementById('detailView').style.display = 'none';
  loadSpaces();
}

// ── Space Detail ─────────────────────────────────────────────────
async function openSpace(name) {
  currentSpace = name;
  currentFile = null;
  currentDir = '';
  document.getElementById('listView').style.display = 'none';
  document.getElementById('detailView').style.display = '';
  document.getElementById('detailTitle').textContent = name;
  document.getElementById('codeViewer').classList.remove('open');
  document.getElementById('codeEmpty').style.display = 'flex';

  // Info bar
  const cloneUrl = location.origin + '/space/' + encodeURIComponent(name) + '/repo.git';
  document.getElementById('infoBar').innerHTML =
    '<div class="info-chip">' +
      '<span class="label">Git Clone</span>' +
      '<span>' + esc(cloneUrl) + '</span>' +
      '<button class="copy-btn" onclick="copyText(\\'' + esc(cloneUrl) + '\\')" title="Copy">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
      '</button>' +
    '</div>';

  await Promise.all([loadFiles(), loadGitLog(), loadDeployments()]);
  renderBreadcrumb();
  renderFileList();
}

// ── Files ────────────────────────────────────────────────────────
async function loadFiles() {
  const res = await fetch(API + '/' + encodeURIComponent(currentSpace) + '/files');
  const raw = await res.json();
  allFiles = raw.map(f => ({ ...f, path: f.path.replace(/^\\//, '') }));
}

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  const parts = currentDir ? currentDir.split('/').filter(Boolean) : [];
  let html = '<button onclick="navTo(\\'\\')">~</button>';
  let path = '';
  for (const p of parts) {
    path += (path ? '/' : '') + p;
    html += '<span class="sep">/</span><button onclick="navTo(\\'' + esc(path) + '\\')">' + esc(p) + '</button>';
  }
  bc.innerHTML = html;
}

function renderFileList() {
  const el = document.getElementById('fileList');
  const prefix = currentDir ? currentDir + '/' : '';
  const dirs = new Set();
  const files = [];

  for (const f of allFiles) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rel = prefix ? f.path.slice(prefix.length) : f.path;
    if (!rel) continue;
    const slash = rel.indexOf('/');
    if (slash !== -1) dirs.add(rel.slice(0, slash));
    else files.push({ path: f.path, name: rel });
  }

  let html = '';
  if (currentDir) {
    html += '<div class="file-item" onclick="navUp()"><span class="icon dir-icon">&#128193;</span><span class="name">..</span></div>';
  }
  for (const d of [...dirs].sort()) {
    const full = prefix + d;
    html += '<div class="file-item" onclick="navTo(\\'' + esc(full) + '\\')">' +
      '<span class="icon dir-icon">&#128193;</span><span class="name">' + esc(d) + '</span></div>';
  }
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const active = currentFile === f.path ? ' active' : '';
    html += '<div class="file-item' + active + '" onclick="viewFile(\\'' + esc(f.path) + '\\')">' +
      '<span class="icon">' + fileIcon(f.name) + '</span><span class="name">' + esc(f.name) + '</span></div>';
  }
  if (!html) html = '<div style="padding:24px;text-align:center;color:var(--cf-text-subtle);font-size:13px">Empty directory</div>';
  el.innerHTML = html;
}

function navTo(dir) { currentDir = dir; currentFile = null; renderBreadcrumb(); renderFileList(); }
function navUp() {
  const parts = currentDir.split('/').filter(Boolean);
  parts.pop();
  currentDir = parts.join('/');
  renderBreadcrumb();
  renderFileList();
}

async function viewFile(path) {
  currentFile = path;
  renderFileList();
  document.getElementById('codeEmpty').style.display = 'none';
  const viewer = document.getElementById('codeViewer');
  viewer.classList.add('open');
  document.getElementById('codePath').textContent = path;
  document.getElementById('codeContent').textContent = 'Loading...';
  document.getElementById('lineNums').textContent = '';
  document.getElementById('codeSize').textContent = '';

  try {
    const res = await fetch(API + '/' + encodeURIComponent(currentSpace) + '/file?path=' + encodeURIComponent(path));
    const data = await res.json();
    if (data.error) { document.getElementById('codeContent').textContent = data.error; return; }
    document.getElementById('codeContent').textContent = data.content;
    document.getElementById('codeSize').textContent = fmtBytes(data.content.length);
    const lines = data.content.split('\\n').length;
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    document.getElementById('lineNums').textContent = nums.join('\\n');
  } catch (e) {
    document.getElementById('codeContent').textContent = 'Error: ' + e.message;
  }
}

// ── Git Log ──────────────────────────────────────────────────────
async function loadGitLog() {
  const el = document.getElementById('gitLog');
  try {
    const res = await fetch(API + '/' + encodeURIComponent(currentSpace) + '/git/log?limit=15');
    const log = await res.json();
    if (!log.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--cf-text-subtle);font-size:13px;text-align:center">No commits yet</div>';
      return;
    }
    el.innerHTML = log.map(c => {
      const sha = (c.oid || c.sha || '').slice(0, 7);
      const msg = esc(c.message || c.commit?.message || '');
      const author = esc(c.commit?.author?.name || c.author?.name || 'Unknown');
      const ts = c.commit?.author?.timestamp || c.author?.timestamp;
      const date = ts ? new Date(ts * 1000).toLocaleDateString() : '';
      return '<div class="commit-item">' +
        '<div class="commit-msg">' + msg + '</div>' +
        '<div class="commit-meta"><span class="commit-sha">' + sha + '</span> &middot; ' + author + (date ? ' &middot; ' + date : '') + '</div>' +
      '</div>';
    }).join('');
  } catch {
    el.innerHTML = '<div style="padding:16px;color:var(--cf-text-subtle);font-size:13px">Failed to load git log</div>';
  }
}

// ── Deployments ──────────────────────────────────────────────────
async function loadDeployments() {
  const el = document.getElementById('deployList');
  try {
    const res = await fetch(API + '/' + encodeURIComponent(currentSpace) + '/deployments');
    const data = await res.json();
    const deployments = Array.isArray(data) ? data : (data.deployments || []);
    if (!deployments.length) {
      el.innerHTML = '<div style="padding:16px;color:var(--cf-text-subtle);font-size:13px;text-align:center">No deployments</div>';
      return;
    }
    el.innerHTML = deployments.map(d => {
      const branch = esc(d.branch);
      const previewUrl = '/space/' + encodeURIComponent(currentSpace) + '/preview/' + encodeURIComponent(d.branch) + '/';
      return '<div class="deploy-item">' +
        '<span class="badge badge-green">Live</span>' +
        '<span class="deploy-branch">' + branch + '</span>' +
        '<a class="deploy-link" href="' + previewUrl + '" target="_blank">Preview &rarr;</a>' +
      '</div>';
    }).join('');
  } catch {
    el.innerHTML = '<div style="padding:16px;color:var(--cf-text-subtle);font-size:13px">Failed to load deployments</div>';
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const m = { ts:'&#9679;', tsx:'&#9679;', js:'&#9679;', jsx:'&#9679;', json:'&#9670;', md:'&#9998;', html:'&#9673;', css:'&#9673;', toml:'&#9881;', yml:'&#9881;', yaml:'&#9881;', lock:'&#128274;' };
  return '<span style="color:var(--cf-orange)">' + (m[ext] || '&#9702;') + '</span>';
}
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    // brief flash feedback on the button
  });
}

// ── Init ─────────────────────────────────────────────────────────
document.getElementById('workerUrl').textContent = location.origin;
loadSpaces();
</script>
</body>
</html>`;
}
