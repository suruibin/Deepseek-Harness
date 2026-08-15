/**
 * Sandboxed preload bridge for the hosted DSH page: exposes the glass controls
 * the injected settings slider needs, plus the embedded terminal and folder
 * browser bridges. Compiled to CommonJS (`.cts` → `lib/preload.cjs`)
 * because a sandboxed renderer can only load a CJS preload; the main-world
 * injected script talks to the main process through this bridge instead of
 * raw IPC.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** Terminal open result: the attach snapshot for transcript replay. */
export interface TerminalOpenResult {
  /** Output accumulated since spawn; write it into the xterm before live data. */
  transcript: string
  /** Whether the top-level process already exited (a dead tab respawns). */
  exited: boolean
  /** Exit code once known; null until the process exits. */
  exitCode: number | null
}

/** Embedded terminal controls backed by main-process node-pty sessions. */
const terminal = {
  /** Attach (or spawn) a shell for one tab; resolves with the replay snapshot. */
  open: (tabId: string, cwd?: string): Promise<TerminalOpenResult | { error: string }> =>
    ipcRenderer.invoke('dsh:term-open', tabId, cwd),
  /** Forward a chunk of input (keystrokes/paste) to the tab's PTY. */
  input: (tabId: string, data: string): void => { ipcRenderer.send('dsh:term-input', tabId, data) },
  /** Resize the tab's PTY to the given column/row count. */
  resize: (tabId: string, cols: number, rows: number): void => { ipcRenderer.send('dsh:term-resize', tabId, cols, rows) },
  /** Release the tab's PTY immediately (the owning tab was closed). */
  close: (tabId: string): void => { ipcRenderer.send('dsh:term-close', tabId) },
  /** Subscribe to PTY output (tab-tagged); returns an unsubscribe fn. */
  onData: (callback: (tabId: string, data: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      const record = payload as { tabId?: unknown; data?: unknown } | null
      if (record !== null && typeof record === 'object' && typeof record.tabId === 'string' && typeof record.data === 'string') {
        callback(record.tabId, record.data)
      }
    }
    ipcRenderer.on('dsh:term-data', listener)
    return () => { ipcRenderer.removeListener('dsh:term-data', listener) }
  },
  /** Subscribe to PTY exit (tab-tagged); returns an unsubscribe fn. */
  onExit: (callback: (tabId: string, code: number) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      const record = payload as { tabId?: unknown; code?: unknown } | null
      if (record !== null && typeof record === 'object' && typeof record.tabId === 'string') {
        callback(record.tabId, typeof record.code === 'number' ? record.code : 0)
      }
    }
    ipcRenderer.on('dsh:term-exit', listener)
    return () => { ipcRenderer.removeListener('dsh:term-exit', listener) }
  },
}

/** Folder browsing backed by main-process readdir. */
const fs = {
  /** List a directory; resolves to { cwd, path, parent, entries } or { error }. */
  list: (path: string): Promise<unknown> => ipcRenderer.invoke('dsh:fs-list', path),
  /** Read a file; resolves to { kind:'text', content, truncated } | { kind:'binary', size, head } | { error }. */
  read: (path: string): Promise<unknown> => ipcRenderer.invoke('dsh:fs-read', path),
  /** Resolve a DSH workspace title (e.g. "projects") to its directory path. */
  workspace: (title: string): Promise<unknown> => ipcRenderer.invoke('dsh:fs-workspace', title),
}

/** Git status for the file tree's change badges. */
const git = {
  /** Resolves to { isRepo, branch?, root?, entries } or { error }; outside a repo it is { isRepo: false }. */
  status: (): Promise<unknown> => ipcRenderer.invoke('dsh:git-status'),
}

/** /backup command bridge (mirrors the backup skill's semantics). */
const backup = {
  /** Backup a source directory; resolves to { ok, backupDir, output } or { error }. */
  run: (srcDir: string, args: string[]): Promise<unknown> => ipcRenderer.invoke('dsh:backup-run', srcDir, args),
}

/** Per-project terminal state (names + working dirs), persisted by the main process. */
const state = {
  /** Resolves to the full { projectRoot: { tabs, active } } map or {}. */
  get: (): Promise<unknown> => ipcRenderer.invoke('dsh:term-state-get'),
  /** Replace the whole map; resolves to { ok: true } or { error }. */
  set: (state: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:term-state-set', state),
}

/** System clipboard via the main process (the page's http origin has no clipboard permission). */
const clipboard = {
  /** Resolves to the current clipboard text. */
  readText: (): Promise<string> => ipcRenderer.invoke('dsh:clipboard-read'),
  /** Replace the clipboard with text. */
  writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('dsh:clipboard-write', text),
}

contextBridge.exposeInMainWorld('dshDesktop', {
  /** Ask the main process to change the window glass tint (0..1). */
  setAlpha: (alpha: number): void => { ipcRenderer.send('dsh:set-alpha', alpha) },
  /** Read the current persisted glass tint. */
  getAlpha: (): Promise<number> => ipcRenderer.invoke('dsh:get-alpha'),
  /** Embedded terminal bridge. */
  terminal,
  /** Folder browser bridge. */
  fs,
  /** Git status bridge. */
  git,
  /** /backup command bridge. */
  backup,
  /** Terminal state bridge. */
  state,
  /** System clipboard bridge (terminal copy/paste). */
  clipboard,
})
