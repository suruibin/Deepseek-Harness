/**
 * dsh-desktop desktop IPC handlers: the settings-page glass controls, the
 * embedded terminal bridge, the folder browser / backup / git-status surface,
 * wallpaper picking, terminal-state persistence, and the system clipboard.
 *
 * Split out of main.ts so the main module keeps only the lifecycle wiring.
 * Every handler is pure IPC plumbing — inputs are size/type-validated here
 * because the renderer side is hostile surface. Live state stays owned by
 * main.ts and is reached through the {@link DesktopIpcContext} accessors.
 */

import { clipboard, dialog, ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { gitStatus } from './git-status.ts'
import { isHexColor } from './glass.ts'
import type { PtyRegistry } from './pty-registry.ts'
import { removeStoredWallpaper, storeWallpaper, wallpaperDataUrl } from './wallpaper.ts'

/**
 * Terminal-state persistence file under userData. Deliberately NOT
 * localStorage, whose origin is the dsh web URL and therefore changes with
 * every launch's random port.
 */
const TERM_STATE_FILE = 'terminal-state.json'

/**
 * References into the main module's live state. Primitives that the handlers
 * mutate (window alpha, wallpaper file) are exposed as get/set pairs so the
 * state itself stays owned by main.ts.
 */
export interface DesktopIpcContext {
  /** The app's userData directory (glass settings, wallpaper, term state). */
  userData: string
  /** Directory holding scripts/backup-project.sh. */
  packageDir: string
  /** Resolve the current window (undefined while hidden/destroyed). */
  mainWindow: () => BrowserWindow | undefined
  getWindowAlpha: () => number
  setWindowAlpha: (alpha: number) => void
  /** Send a payload to the hosted page (no-op without a live window). */
  pushToWindow: (channel: string, payload: unknown) => void
  ptyRegistry: PtyRegistry
  /** Tab ids whose push listeners are already attached to the registry. */
  attachedTermTabs: Set<string>
  getWallpaperFile: () => string | null
  /** Set the wallpaper file and persist glass settings. */
  setWallpaperFile: (file: string | null) => void
  /** The current solid-color background (lowercase #rrggbb), or null. */
  getWallpaperColor: () => string | null
  /** Set (or clear with null) the solid-color background and persist. */
  setWallpaperColor: (color: string | null) => void
  /** Folder the auto-rotate cycles image wallpapers from, or null. */
  getWallpaperFolder: () => string | null
  /** Auto-rotate state. */
  getWallpaperRotate: () => { enabled: boolean; minutes: number }
  /** Set auto-rotate (enabled + minutes, optional new folder) and persist. */
  setWallpaperRotate: (enabled: boolean, minutes: number, folder: string | null) => void
  /** Restart the dsh web server in place, reloading the hosted window. */
  restartWebServer: () => Promise<{ ok: true; url: string } | { ok: false; message: string }>
}

/**
 * Store a wallpaper file under userData and persist the new glass settings.
 * `srcPath` either comes from the main-owned file dialog or a path the main
 * process itself listed in the folder picker, so the renderer's path surface
 * stays bounded.
 */
function applyWallpaperFile(ctx: DesktopIpcContext, srcPath: string): { file: string; url: string; srcPath: string } | { error: string } {
  const stored = storeWallpaper(ctx.userData, srcPath)
  if ('error' in stored) return stored
  ctx.setWallpaperFile(stored.file)
  // An image wallpaper takes precedence over the solid-color background; the
  // persisted color is cleared so a later "移除" returns to the built-in tone.
  ctx.setWallpaperColor(null)
  return { file: stored.file, url: stored.url, srcPath }
}

/** Register every desktop IPC handler. Must run inside the single-instance
 * lock holder (mirrors main.ts's previous inline registration). */
export function registerDesktopIpc(ctx: DesktopIpcContext): void {
  // Glass IPC for the settings-page opacity slider (preload bridge). The
  // value is validated here because the renderer side is hostile surface.
  ipcMain.on('dsh:set-alpha', (_event, alpha: unknown) => {
    if (typeof alpha === 'number' && Number.isFinite(alpha)) ctx.setWindowAlpha(alpha)
  })
  ipcMain.handle('dsh:get-alpha', () => ctx.getWindowAlpha())
  // Embedded terminal IPC (preload bridge). The renderer side is hostile
  // surface, so inputs are size-validated and the registry bounds sessions.
  // The protocol mirrors DSH better-sidebar's terminal wire: open (attach)
  // returns the transcript for replay, input is raw text, resize is a
  // dimension pair, and close releases the pty immediately (the owning tab
  // was closed).
  ipcMain.handle('dsh:term-open', (_event, tabId: unknown, cwd: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') {
      return { error: 'invalid tab id' }
    }
    if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') {
      return { error: 'invalid cwd' }
    }
    try {
      const handle = ctx.ptyRegistry.open(
        tabId,
        typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(),
      )
      // Attach the push listeners exactly once per tab: a reused handle must
      // not double-deliver output. The listeners are registered before the
      // invoke resolves, so the transcript replay in the renderer always
      // lands before the first live chunk.
      if (!ctx.attachedTermTabs.has(tabId)) {
        ctx.attachedTermTabs.add(tabId)
        handle.pty.onData((data: string) => { ctx.pushToWindow('dsh:term-data', { tabId, data }) })
        handle.pty.onExit(({ exitCode }) => { ctx.pushToWindow('dsh:term-exit', { tabId, code: exitCode }) })
      }
      return { transcript: handle.transcript, exited: handle.exited, exitCode: handle.exitCode }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.on('dsh:term-input', (_event, tabId: unknown, data: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    if (typeof data !== 'string' || data.length > 16_384) return
    ctx.ptyRegistry.get(tabId)?.pty.write(data)
  })
  ipcMain.on('dsh:term-resize', (_event, tabId: unknown, cols: unknown, rows: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    ctx.ptyRegistry.get(tabId)?.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)))
  })
  ipcMain.on('dsh:term-close', (_event, tabId: unknown) => {
    if (typeof tabId !== 'string' || tabId === '') return
    ctx.ptyRegistry.close(tabId)
    ctx.attachedTermTabs.delete(tabId)
  })
  // Folder browser IPC (preload bridge). Lists a directory with the same
  // shape the injected file tree expects: { cwd, path, parent, entries }.
  ipcMain.handle('dsh:fs-list', async (_event, rawPath: unknown) => {
    try {
      const { readdir, stat } = await import('node:fs/promises')
      const { resolve, dirname } = await import('node:path')
      const { homedir } = await import('node:os')
      // "~" (the Home button) expands to the user's home directory.
      const target = rawPath === '~'
        ? homedir()
        : (typeof rawPath === 'string' && rawPath.length > 0 ? resolve(rawPath) : process.cwd())
      const entries = await readdir(target, { withFileTypes: true })
      const listed = await Promise.all(entries.map(async (entry) => {
        let size: number | null = null
        if (!entry.isDirectory()) {
          try { size = (await stat(resolve(target, entry.name))).size } catch { size = null }
        }
        return { kind: entry.isDirectory() ? 'directory' : 'file', name: entry.name, path: resolve(target, entry.name), size }
      }))
      listed.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const parent = target !== dirname(target) ? dirname(target) : null
      return { cwd: process.cwd(), path: target, parent, entries: listed.slice(0, 500) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Resolve a DSH workspace title to its directory. The file browser follows
  // the current session's workspace on project switches; the mapping lives in
  // the harness's own storage (~/.dsh/storages/workspace.json), not our
  // userData, so it stays in sync with whatever `dsh web` manages.
  ipcMain.handle('dsh:fs-workspace', async (_event, rawTitle: unknown) => {
    try {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(join(homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { title?: string; path?: string }> } }
      const title = typeof rawTitle === 'string' ? rawTitle : ''
      const workspaces = data.tables?.workspaces ?? {}
      for (const ws of Object.values(workspaces)) {
        if (ws.title === title && typeof ws.path === 'string' && ws.path !== '') {
          return { path: ws.path }
        }
      }
      return { path: null }
    } catch {
      return { path: null }
    }
  })
  // /backup command: run the project backup script (mirrors
  // ~/.claude/skills/backup/SKILL.md) for the given source directory.
  ipcMain.handle('dsh:backup-run', async (_event, srcDir: unknown, args: unknown) => {
    if (typeof srcDir !== 'string' || srcDir === '') return { error: 'no source directory' }
    const argList = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
    try {
      const { spawn } = await import('node:child_process')
      const script = join(ctx.packageDir, 'scripts', 'backup-project.sh')
      const child = spawn('bash', [script, srcDir, ...argList], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { out += String(d) })
      const code = await new Promise<number | null>((resolve) => { child.on('close', resolve) })
      const lines = out.trim().split('\n')
      const last = lines[lines.length - 1] ?? ''
      return {
        ok: code === 0 && last.startsWith('OK '),
        backupDir: last.startsWith('OK ') ? last.slice(3) : null,
        output: out.slice(0, 4000),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // File read IPC (preload bridge), mirroring better-sidebar's fs.read:
  // text reads carry content with a truncated flag, binary reads carry the
  // size plus a base64 head (first 4 KiB) for content sniffing. The read is
  // capped at 512 KiB like the plugin's readLimit.
  ipcMain.handle('dsh:fs-read', async (_event, rawPath: unknown) => {
    try {
      const { open, stat } = await import('node:fs/promises')
      const { resolve } = await import('node:path')
      const target = typeof rawPath === 'string' && rawPath.length > 0
        ? resolve(rawPath)
        : process.cwd()
      const readLimit = 512 * 1024
      const info = await stat(target)
      if (info.isDirectory()) return { error: `"${target}" is a directory` }
      const truncated = info.size > readLimit
      const handle = await open(target, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(info.size, readLimit))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        const slice = buffer.subarray(0, bytesRead)
        const binary = slice.includes(0)
        return {
          kind: binary ? 'binary' : 'text',
          size: info.size,
          truncated,
          ...(binary
            ? { head: slice.subarray(0, Math.min(slice.length, 4096)).toString('base64') }
            : { content: slice.toString('utf8') }),
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Git status IPC (preload bridge): the file tree's change badges. The
  // query never throws — outside a repository (or without git) it resolves
  // to { isRepo: false } and the tree renders without badges.
  ipcMain.handle('dsh:git-status', async () => {
    try {
      return await gitStatus(process.cwd())
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Wallpaper IPC (preload bridge): pick (system file dialog + store under
  // userData), clear, and get (current data URL). The renderer side is
  // hostile surface, so the file path never comes from it — the dialog is
  // owned by the main process. `dsh:wallpaper-apply` is the folder-browser
  // path: the renderer supplies an absolute path, but it is only honored for
  // files the main process itself listed (the folder pick dialog below).
  ipcMain.handle('dsh:wallpaper-pick', async () => {
    const options = {
      title: 'Select wallpaper',
      properties: ['openFile' as const],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'] }],
    }
    const window = ctx.mainWindow()
    const result = window !== undefined
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return applyWallpaperFile(ctx, result.filePaths[0]!)
  })
  // Folder picker for the wallpaper thumbnail grid: choose a directory and
  // list its images (png/jpg/jpeg/webp/gif/bmp — the formats nativeImage can
  // decode into thumbnails; svg is excluded because it cannot be rasterized
  // this way). The returned paths are the only ones `dsh:wallpaper-apply`
  // will accept later, keeping the renderer's path surface bounded.
  ipcMain.handle('dsh:wallpaper-folder-pick', async () => {
    const options = {
      title: 'Select wallpaper folder',
      properties: ['openDirectory' as const],
    }
    const window = ctx.mainWindow()
    const result = window !== undefined
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const dir = result.filePaths[0]!
    try {
      const { readdir } = await import('node:fs/promises')
      const { extname } = await import('node:path')
      const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
      const entries = (await readdir(dir))
        .filter((n) => IMG_EXTS.has(extname(n).toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 300)
        .map((n) => ({ name: n, path: join(dir, n) }))
      return { path: dir, entries }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Render a thumbnail data URL for one image (decode + downscale). Called
  // lazily by the renderer grid; SVG and undecodable files resolve `{ error }`
  // and the cell shows an empty tile.
  //
  // nativeImage.createFromPath decodes the FULL image synchronously — several
  // concurrent decodes of multi-MiB wallpapers block the main process and
  // freeze every other IPC (the renderer observed a 756ms latency spike while
  // the grid loaded). Two mitigations live here: (1) a per-path cache keyed
  // by mtime, so each image is decoded at most once per session; (2) the
  // renderer serializes its requests (one decode in flight). The cache is
  // capped so a huge folder cannot grow it unbounded.
  const thumbCache = new Map<string, { mtimeMs: number; url: string }>()
  ipcMain.handle('dsh:wallpaper-thumb', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath === '') return { error: 'invalid path' }
    try {
      const { stat } = await import('node:fs/promises')
      let mtimeMs = 0
      try { mtimeMs = (await stat(rawPath)).mtimeMs } catch { /* unreadable; decode anyway */ }
      const hit = thumbCache.get(rawPath)
      if (hit !== undefined && hit.mtimeMs === mtimeMs) return { url: hit.url }
      const image = nativeImage.createFromPath(rawPath)
      if (image.isEmpty()) return { error: 'cannot decode image' }
      const size = image.getSize()
      const resized = size.width > 360 ? image.resize({ width: 360 }) : image
      const url = resized.toDataURL()
      if (thumbCache.size >= 200) thumbCache.clear()
      thumbCache.set(rawPath, { mtimeMs, url })
      return { url }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('dsh:wallpaper-apply', async (_event, rawPath: unknown) => {
    if (typeof rawPath !== 'string' || rawPath === '') return { error: 'invalid path' }
    return applyWallpaperFile(ctx, rawPath)
  })
  ipcMain.handle('dsh:wallpaper-clear', () => {
    removeStoredWallpaper(ctx.userData, ctx.getWallpaperFile())
    ctx.setWallpaperFile(null)
    return { ok: true }
  })
  ipcMain.handle('dsh:wallpaper-get', () => {
    return {
      url: wallpaperDataUrl(ctx.userData, ctx.getWallpaperFile()),
      file: ctx.getWallpaperFile(),
      color: ctx.getWallpaperColor(),
      folder: ctx.getWallpaperFolder(),
      rotate: ctx.getWallpaperRotate(),
    }
  })
  // Solid-color background: set a flat #rrggbb (or null to clear it back to
  // the built-in tone). The renderer clears the image wallpaper first, so the
  // stored state is exactly one background choice at a time.
  ipcMain.handle('dsh:wallpaper-set-color', (_event, color: unknown) => {
    if (color === null || color === undefined) {
      ctx.setWallpaperColor(null)
      return { ok: true }
    }
    if (!isHexColor(color)) return { error: 'invalid color' }
    ctx.setWallpaperColor(color)
    return { ok: true }
  })
  // Auto-rotate: { enabled, minutes, folder }. `folder` is optional (kept as
  // the rotation source when supplied); minutes is clamped to 1..1440.
  ipcMain.handle('dsh:wallpaper-set-rotate', (_event, opts: unknown) => {
    const o = opts !== null && typeof opts === 'object' ? (opts as Record<string, unknown>) : {}
    const enabled = o.enabled === true
    const minutes = typeof o.minutes === 'number' && Number.isFinite(o.minutes)
      ? Math.min(1440, Math.max(1, Math.round(o.minutes)))
      : 30
    const folder = typeof o.folder === 'string' && o.folder !== '' ? o.folder : null
    ctx.setWallpaperRotate(enabled, minutes, folder)
    return { ok: true }
  })
  // Terminal state persistence IPC: the injected panel remembers each
  // project's terminal tabs (names + working directories) across launches.
  // Stored in the app's userData dir — NOT localStorage, whose origin is the
  // dsh web URL and therefore changes with every launch's random port.
  ipcMain.handle('dsh:term-state-get', async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      return JSON.parse(await readFile(join(ctx.userData, TERM_STATE_FILE), 'utf8'))
    } catch {
      return {}
    }
  })
  ipcMain.handle('dsh:term-state-set', async (_event, state: unknown) => {
    if (typeof state !== 'object' || state === null) {
      return { error: 'invalid terminal state' }
    }
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(ctx.userData, TERM_STATE_FILE), JSON.stringify(state), 'utf8')
      return { ok: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  // System clipboard for terminal copy/paste (Ctrl+Shift+C/V and Ctrl+C/V).
  // Routed through the main process because the hosted page's http origin has
  // no clipboard permission of its own.
  ipcMain.handle('dsh:clipboard-read', () => clipboard.readText())
  ipcMain.handle('dsh:clipboard-write', (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : '')
    return true
  })
  // 重启 dsh web（已归档面板「重启 dsh」按钮）：宿主内存 registry 权威，取消归档/
  // 恢复的账本改动需重启后官方侧栏才更新；该 handler 原地重启并重载窗口。
  ipcMain.handle('dsh:web-restart', () => ctx.restartWebServer())
}
