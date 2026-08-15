/**
 * dsh-desktop PTY registry: multi-tab terminal sessions for the injected
 * terminal panel. Mirrors DSH better-sidebar's PtyManager semantics so the
 * desktop shell and the plugin share one mental model:
 *
 * - One node-pty process per tab key. A tab that already has a live process
 *   reuses it (attach), so switching tabs or re-opening the panel never
 *   spawns a second shell.
 * - Output is mirrored into a bounded transcript ring (capped bytes), and an
 *   attach replays the transcript before live output — a re-open shows the
 *   full history instead of a blank terminal.
 * - Closing a tab releases the process immediately (`close`); a bare detach
 *   (panel hidden, page navigated) schedules a delayed release so a quick
 *   re-attach keeps the same shell, and the pending release is cancelled by
 *   the next open.
 * - An exited process is respawned on the next open (re-attaching a dead
 *   terminal must yield a live shell, not an input sink).
 * - Per-registry tab cap, mirroring better-sidebar's per-session limit.
 *
 * node-pty is a native module and loaded lazily through `createRequire`, so a
 * missing/broken build degrades the terminal feature without breaking the
 * shell; the spawn factory is injectable for tests.
 */

import { createRequire } from 'node:module'

/** The interactive shell for this platform (empty SHELL falls back). */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL
  return shell !== undefined && shell.trim() !== '' ? shell : '/bin/bash'
}

/** The subset of node-pty's IPty the registry uses (injectable for tests). */
export interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

/** One live terminal. */
export interface PtyHandle {
  /** Registry key (the injected panel's tab id). */
  tabId: string
  /** The working directory the process was spawned with. */
  cwd: string
  /** The live pty process. */
  pty: PtyLike
  /** Output accumulated since spawn (bounded; head dropped when over the limit). */
  transcript: string
  /** Whether the top-level process exited (transcript stays replayable). */
  exited: boolean
  /** Exit code once known. */
  exitCode: number | null
}

/** Options controlling the registry; every knob is injectable for tests. */
export interface PtyRegistryOptions {
  /** Shell binary; defaults to {@link defaultShell}. */
  shell?: string
  /** Per-tab transcript bound in bytes; defaults to 1 MiB. */
  transcriptLimit?: number
  /** Pty spawn factory; defaults to a lazy `node-pty` require. */
  spawn?: (shell: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike
}

const DEFAULT_TRANSCRIPT_LIMIT = 1 << 20

/** Clamp a pty dimension into the supported 2..1024 range (flooring decimals). */
export function clampDims(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (value: number): number =>
    Math.min(1024, Math.max(2, Math.floor(value)))
  return { cols: clamp(cols), rows: clamp(rows) }
}

/**
 * Multi-tab PTY registry. One shell process per tab key; processes survive
 * panel hide/show and re-attach by key with the transcript replayed.
 */
export class PtyRegistry {
  private readonly tabs = new Map<string, PtyHandle>()
  private readonly pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly shell: string
  private readonly transcriptLimit: number
  private readonly spawn: (shell: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike

  constructor(options: PtyRegistryOptions = {}) {
    this.shell = options.shell ?? defaultShell()
    this.transcriptLimit = options.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT
    this.spawn = options.spawn ?? defaultSpawn
  }

  /** All live tab keys, in insertion order. */
  keys(): string[] {
    return [...this.tabs.keys()]
  }

  /** Resolve a live handle by tab id, or undefined. */
  get(tabId: string): PtyHandle | undefined {
    return this.tabs.get(tabId)
  }

  /**
   * Open (or reuse) the terminal for a tab key. A handle whose process
   * already exited is replaced with a fresh spawn (re-attaching a dead
   * terminal must yield a live shell, not an input sink), and so is a live
   * handle whose spawn cwd differs from the requested one (the panel can
   * re-open after the workspace changed; a shell in the wrong directory must
   * not linger). Reopening also cancels any pending scheduled close (an
   * attach within the grace window keeps the process alive).
   * @param tabId - client tab id.
   * @param cwd - initial working directory (the panel's root).
   * @param cols - initial terminal width.
   * @param rows - initial terminal height.
   * @returns the live handle.
   */
  open(tabId: string, cwd: string, cols = 80, rows = 24): PtyHandle {
    this.cancelClose(tabId)
    const existing = this.tabs.get(tabId)
    if (existing !== undefined && !existing.exited && existing.cwd === cwd) return existing
    if (existing !== undefined) this.close(tabId)
    // Zombie cleanup: exited handles (shell closed, tab dropped) must not
    // linger and consume resources.
    for (const [candidate, handle] of [...this.tabs]) {
      if (handle.exited) this.close(candidate)
    }
    const dims = clampDims(cols, rows)
    const handle: PtyHandle = {
      tabId,
      cwd,
      pty: this.spawn(this.shell, [], {
        name: 'xterm-256color',
        cols: dims.cols,
        rows: dims.rows,
        cwd,
        env: { ...process.env },
      }),
      transcript: '',
      exited: false,
      exitCode: null,
    }
    handle.pty.onData((data) => {
      handle.transcript += data
      if (handle.transcript.length > this.transcriptLimit) {
        handle.transcript = handle.transcript.slice(handle.transcript.length - this.transcriptLimit)
      }
    })
    handle.pty.onExit(({ exitCode }) => {
      handle.exited = true
      handle.exitCode = exitCode
    })
    this.tabs.set(tabId, handle)
    return handle
  }

  /**
   * Schedule the tab's destruction after `delayMs`. A tab close sends delay 0
   * (release the cap immediately); a bare detach (panel hidden, navigation)
   * uses the grace period so a quick re-attach keeps the process. `open()`
   * cancels any pending close.
   */
  scheduleClose(tabId: string, delayMs: number): void {
    const handle = this.tabs.get(tabId)
    if (handle === undefined) return
    this.cancelClose(tabId)
    const timer = setTimeout(() => { this.close(tabId) }, Math.max(0, Math.floor(delayMs)))
    this.pendingCloses.set(tabId, timer)
  }

  /** Cancel a pending scheduled close (the tab is being re-attached). */
  cancelClose(tabId: string): void {
    const timer = this.pendingCloses.get(tabId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.pendingCloses.delete(tabId)
    }
  }

  /** Close a tab and drop its state (the owning tab was closed). */
  close(tabId: string): boolean {
    this.cancelClose(tabId)
    const handle = this.tabs.get(tabId)
    if (handle === undefined) return false
    this.tabs.delete(tabId)
    try {
      handle.pty.kill()
    } catch {
      // Already exited or gone; nothing left to kill.
    }
    return true
  }

  /** Close every tab (app quit, panel teardown). */
  disposeAll(): void {
    for (const timer of this.pendingCloses.values()) clearTimeout(timer)
    this.pendingCloses.clear()
    for (const tabId of [...this.tabs.keys()]) this.close(tabId)
  }
}

/** Default spawn factory: lazy `node-pty` require, so a broken native build cannot crash the shell. */
function defaultSpawn(
  shell: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
): PtyLike {
  const require_ = createRequire(import.meta.url)
  const pty: unknown = require_('node-pty')
  return (pty as {
    spawn(shell: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): PtyLike
  }).spawn(shell, args, opts)
}
