/**
 * dsh-desktop server restart domain: the orphan reaper for a server child,
 * killing an externally-spawned (non-group-leader) server, and the in-place
 * `dsh web` restart driven by the archived panel's 「重启 dsh」 button.
 *
 * Split out of main.ts so the main module keeps only the boot/window wiring;
 * these functions form the standalone "server restart" surface and reach the
 * shared server/window state through {@link ServerRestartContext}.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { childExited, pidOnPort, processCmdline, processCwd, resolveWebLaunch, waitForHttpOk, waitForReadyLine } from './launcher.ts'
import { killProcessTree } from './process-tree.ts'

/** Tail of server stderr kept for failure diagnostics. */
export const STDERR_TAIL_LIMIT = 4_000

/**
 * References into the main module's live server/window state. The server
 * child and its URL are reassigned by a restart, so they are exposed as
 * get/set pairs while the state itself stays owned by main.ts.
 */
export interface ServerRestartContext {
  /** Current server URL (undefined before the first successful boot). */
  serverUrl: () => URL | undefined
  /** Current server child (undefined when reusing an external instance). */
  server: () => ChildProcess | undefined
  /** The hosted window (undefined while hidden/destroyed). */
  mainWindow: () => BrowserWindow | undefined
  /** Record a newly spawned server child. */
  setServer: (child: ChildProcess | undefined) => void
  /** Record the server's new URL. */
  setServerUrl: (url: URL) => void
}

/**
 * Directory holding this package's runnable payload. In dev that is the
 * package itself; packaged, the reaper is spawned under Electron-as-Node,
 * which cannot read inside `app.asar`, so it must live in the unpacked tree.
 */
function runDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
}

/**
 * Spawn the orphan reaper for a server child: no OS delivers a parent-death
 * notification, so the reaper polls this process and tree-kills the server if
 * the main is ever hard-killed (Task Manager, taskkill, a crash), so `dsh web`
 * cannot outlive its window on any platform. Windows kills via taskkill /T;
 * POSIX signals the server's process group (the server is detached, so a
 * negated PID reaches the whole tree). The reaper stays alive across a graceful
 * quit too: it detects the main's exit and finishes the cleanup even if the
 * quit path's own killTree races the exit. It is deliberately not killed on
 * quit. Like the server, it must live outside Electron's process group: a
 * terminal Ctrl+C signals the group, and taking the reaper with it would kill
 * the hard-kill cleanup exactly when it is needed (detached + unref below).
 * @param serverPid - the server child's process id (0 when it failed to spawn).
 */
export function spawnReaper(serverPid: number): void {
  spawn(process.execPath, [join(runDir(), 'lib', 'reaper.js'), String(process.pid), String(serverPid)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
    // Detached gives the reaper its own process group on POSIX (immune to the
    // group SIGINT that takes Electron) and a console-less independent process
    // on Windows; there taskkill /T is group-agnostic, so it still reaches the
    // reaper's targets. unref() drops the parent's handle so Electron can exit
    // without waiting — the reaper's job is to outlive it, not hold it open.
    detached: true,
  })
    // The reaper is best-effort: if it cannot start, the graceful quit path
    // still tree-kills the server; only hard-kill cleanup is lost.
    .on('error', () => {})
    // Unref after the error handler, which returns the child itself.
    .unref()
}

/**
 * Kill a non-group-leader process (an externally-spawned reused server) by its
 * positive pid: SIGTERM, escalated to SIGKILL after a grace period. The
 * external dsh web is spawned by a terminal session — not detached — so
 * `killProcessTree`'s negated process-group signal cannot reach it (its pid is
 * not a process-group id). Resolves once the pid no longer exists.
 * @param pid - the process to terminate.
 */
export function killProcessDirect(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
      resolve()
      return
    }
    const deadline = Date.now() + 8_000
    const poll = (): void => {
      try {
        process.kill(pid, 0)
      } catch {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
        resolve()
        return
      }
      setTimeout(poll, 100)
    }
    setTimeout(poll, 100)
  })
}

/**
 * Restart the dsh web server in place (driven by the archived panel's
 * 「重启 dsh」 button). The host keeps its workspace registry in memory and
 * re-reads workspace.json only at startup, so the shell's unarchive/restore
 * ledger edits take effect in the official sidebar only after such a restart.
 *
 * Handles both server ownership modes:
 *  - shell-owned child: kill it with `killProcessTree` (detached process
 *    group) and respawn via `resolveWebLaunch` (the same launch boot used);
 *  - externally-spawned reused server: locate it on the current URL's port,
 *    replicate its original argv (preserves `--trusted-host` etc.) and cwd
 *    from /proc, then kill it directly.
 * The hosted window reloads to the new URL so the injected scripts re-run.
 * @returns the new URL on success, or an error message.
 */
export async function restartWebServer(ctx: ServerRestartContext): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const target = ctx.serverUrl() ?? new URL('http://127.0.0.1:3080/')
  const port = Number(target.port) || 3080
  const owned = ctx.server() !== undefined && !childExited(ctx.server()!)
  const killPid = owned ? ctx.server()?.pid : await pidOnPort(port)
  // Replicate the current server's launch (its original argv + cwd from /proc)
  // so a restart preserves the listen port and custom flags (e.g.
  // --trusted-host). Applies to both ownership modes; falls back to the
  // shell's own launch resolution when /proc replication is unavailable.
  let replicated: { command: string; args: string[]; cwd?: string; env?: Record<string, string> } | undefined
  if (killPid !== undefined) {
    const argv = await processCmdline(killPid)
    const command = argv !== undefined ? argv[0] : undefined
    if (argv !== undefined && command !== undefined) {
      const cwd = await processCwd(killPid)
      replicated = cwd !== undefined
        ? { command, args: argv.slice(1), cwd }
        : { command, args: argv.slice(1) }
    }
  }
  if (killPid !== undefined) {
    if (owned) {
      await killProcessTree(killPid, { logger: (message) => { console.error(`[dsh-desktop] killTree ${message}`) } })
    } else {
      await killProcessDirect(killPid)
    }
  }
  const launch = replicated ?? resolveWebLaunch({ env: process.env })
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: detaching makes the child a process-group leader so both killTree
    // and the reaper can signal the whole tree with a negated PID; Windows
    // stays attached and tree-kills with taskkill /T instead.
    detached: process.platform !== 'win32',
  })
  ctx.setServer(child)
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', (error) => {
    console.error(`[dsh-desktop] restart failed to spawn dsh web: ${error.message}`)
  })
  spawnReaper(child.pid ?? 0)
  child.stdout.setEncoding('utf8')
  let url: URL | undefined
  try {
    url = await waitForReadyLine(child.stdout, {
      onChunk: (chunk) => { process.stdout.write(`[dsh web] ${chunk}`) },
    })
    await waitForHttpOk(url)
    if (childExited(child)) {
      throw new Error('restarted dsh web exited during verification')
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${stderrTail}` : String(error)
    console.error(`[dsh-desktop] restart failed: ${message}`)
    return { ok: false, message: `重启 dsh 失败: ${message}` }
  }
  if (url === undefined) return { ok: false, message: '重启后未获得服务地址' }
  ctx.setServerUrl(url)
  // Reload the hosted window so the official sidebar re-reads the ledger and
  // the injected scripts re-run (did-finish-load re-injects everything).
  const window = ctx.mainWindow()
  if (window !== undefined && !window.isDestroyed()) {
    void window.loadURL(url.href).catch((error: unknown) => {
      console.error(`[dsh-desktop] restart: failed to load ${url.href}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  console.log(`[dsh-desktop] dsh web restarted at ${url.href}`)
  return { ok: true, url: url.href }
}
