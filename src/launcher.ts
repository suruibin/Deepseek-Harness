/**
 * dsh-desktop launcher: resolve the `dsh` command, spawn the Web server, and
 * wait for it to report readiness. Pure Node logic with no Electron imports,
 * so the unit suite can exercise it without a window; Electron glue lives in
 * `main.ts`.
 */

import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Server flags every surface launch passes to `dsh web`. Port 0 requests an OS-assigned port (headless already uses this). `--no-open` keeps the system browser closed: the desktop shell hosts the GUI in its own window, and `dsh web` would otherwise open a browser tab on every launch/restart. */
export const WEB_ARGS = ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'] as const

/** The stdout prefix `dsh web` prints once the server listens. */
const READY_LINE_PREFIX = 'dsh web: '

/** How to spawn the Web server: executable, argv, extra env, cwd, and the resolution source for diagnostics. */
export interface WebServerLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  source: string
}

/** Filesystem and process facts the launcher reads; injectable for tests. */
export interface LaunchEnvironment {
  env: NodeJS.ProcessEnv
  /** Node executable for `DSH_HOME` checkout launches; defaults to `node` on PATH. */
  nodeCommand?: string
  /** Platform for the permission-mode fallback; defaults to the running platform. */
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

/**
 * The harness has no confinement backend on Windows, so its default
 * `workspace-write` permission mode cannot boot there. The shell falls back to
 * `danger-full-access` when the mode is unset (an explicit empty string counts
 * as unset too), exactly the environment a Windows user must otherwise supply
 * for every `dsh` invocation; an explicit non-empty `DSH_PERMISSION_MODE`
 * always wins.
 */
const WINDOWS_PERMISSION_FALLBACK = 'danger-full-access' as const

/**
 * Resolve how to launch `dsh web`. Order: `DSH_BIN` env (an explicit
 * executable) → `DSH_HOME` env (a harness checkout: its built `lib/bin.js` on
 * Node, else the tsx source launch the repository's own `pnpm run dsh` uses) →
 * `dsh` on PATH.
 *
 * This shell carries no harness source and bundles no Node runtime: the
 * backend is whatever `dsh web` the host already provides. `DSH_HOME` is the
 * checkout root — `~/.dsh/source/current` for an `install.sh` install.
 * @param options - environment facts; `exists` defaults to the real filesystem.
 * @returns the spawn descriptor.
 */
export function resolveWebLaunch(options: LaunchEnvironment): WebServerLaunch {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  // An empty DSH_PERMISSION_MODE is treated exactly like an unset one, the
  // same convention DSH_BIN uses below: an explicitly blank value must not
  // bypass the Windows fallback.
  const permissionMode = platform === 'win32' && (options.env.DSH_PERMISSION_MODE === undefined || options.env.DSH_PERMISSION_MODE === '')
    ? { DSH_PERMISSION_MODE: WINDOWS_PERMISSION_FALLBACK }
    : {}
  const dshBin = options.env.DSH_BIN
  if (dshBin !== undefined && dshBin !== '') {
    return { command: dshBin, args: [...WEB_ARGS], env: permissionMode, source: 'DSH_BIN' }
  }
  const dshHome = options.env.DSH_HOME
  if (dshHome !== undefined && dshHome !== '') {
    const builtBin = join(dshHome, 'apps', 'cli', 'lib', 'bin.js')
    if (exists(builtBin)) {
      return { command: options.nodeCommand ?? 'node', args: [builtBin, ...WEB_ARGS], env: permissionMode, source: 'DSH_HOME lib' }
    }
    const sourceBin = join(dshHome, 'apps', 'cli', 'src', 'bin.ts')
    if (exists(sourceBin)) {
      return {
        command: options.nodeCommand ?? 'node',
        // The same launch the checkout's own `pnpm run dsh` script uses; cwd is
        // the checkout root so tsx resolves there.
        args: ['--import', 'tsx/esm', sourceBin, ...WEB_ARGS],
        env: permissionMode,
        cwd: dshHome,
        source: 'DSH_HOME source',
      }
    }
  }
  return { command: 'dsh', args: [...WEB_ARGS], env: permissionMode, source: 'PATH' }
}

/**
 * Extract the server URL from one readiness line — `dsh web: http://127.0.0.1:PORT`
 * with an optional LAN note — or undefined for any other line. The URL must
 * carry an explicit port: the readiness line always does, and a port-less
 * fragment (`http://127`) is how a line split across stdout chunks looks mid-way.
 * @param line - one complete line of child stdout, without its trailing newline.
 * @returns the advertised URL, or undefined when the line is not a readiness line.
 */
export function parseReadyLine(line: string): URL | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(READY_LINE_PREFIX)) return undefined
  const candidate = trimmed.slice(READY_LINE_PREFIX.length).split(' ')[0]
  if (candidate === undefined) return undefined
  try {
    const url = new URL(candidate)
    return url.port === '' ? undefined : url
  } catch {
    // new URL(string) throws only SyntaxError for unparsable input; any such
    // line is not a readiness line.
    return undefined
  }
}

export interface ReadyLineOptions {
  /** How long to wait for the readiness line before failing. */
  timeoutMs?: number
  /** Receives every raw chunk, for logging. */
  onChunk?: (chunk: string) => void
}

/**
 * Wait for the `dsh web` readiness line on the child's stdout. Resolves with
 * the advertised URL; rejects when the stream ends first (the server exited
 * without ever listening) or after {@link ReadyLineOptions.timeoutMs}.
 *
 * The scan never breaks out of the consumption loop: for-await over a Node
 * stream destroys it on early return, and the live server keeps writing
 * stdout after readiness (a destroyed pipe kills it with EPIPE). Once the
 * line is found the loop keeps draining the stream — `onChunk` keeps
 * forwarding — but stops scanning. On the timeout path the iterator is
 * returned so the loop cannot leak.
 * @param stdout - the child's stdout as an async iterable of string chunks.
 * @param options - timeout and logging hooks.
 * @returns the readiness-line URL.
 */
export function waitForReadyLine(stdout: AsyncIterable<string>, options: ReadyLineOptions = {}): Promise<URL> {
  const timeoutMs = options.timeoutMs ?? 60_000
  return new Promise<URL>((resolve, reject) => {
    const iterator = stdout[Symbol.asyncIterator]()
    let resolved = false
    const timer = setTimeout(() => {
      // Giving up on the stream: stop the consumption loop. Node streams are
      // also destroyed here — the timeout means we are done with this server,
      // and an open pipe would otherwise keep the loop alive forever.
      void iterator.return?.()
      const destroyable = stdout as AsyncIterable<string> & { destroy?: () => void }
      destroyable.destroy?.()
      reject(new Error(`dsh-desktop: no readiness line from dsh web within ${timeoutMs}ms`))
    }, timeoutMs)
    void (async () => {
      try {
        // Chunks split lines arbitrarily; keep the unterminated tail across chunks.
        let buffer = ''
        while (true) {
          const result = await iterator.next()
          if (result.done) break
          const chunk = result.value
          options.onChunk?.(chunk)
          if (resolved) continue
          buffer += chunk
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const url = parseReadyLine(line)
            if (url !== undefined) {
              resolved = true
              clearTimeout(timer)
              resolve(url)
            }
          }
        }
        if (resolved) return
        // The stream ended: a final line without a trailing newline still counts.
        const url = parseReadyLine(buffer)
        if (url !== undefined) {
          resolved = true
          clearTimeout(timer)
          resolve(url)
          return
        }
        clearTimeout(timer)
        reject(new Error('dsh-desktop: dsh web exited before printing its readiness line'))
      } catch (error) {
        if (resolved) return
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

export interface HttpOkOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Poll the server URL until it answers HTTP 200. Each attempt carries a short
 * abort deadline so a wedged server cannot stall the poll past the overall timeout.
 * @param url - the readiness-line URL.
 * @param options - timeout, poll cadence, and an injectable fetch for tests.
 */
export async function waitForHttpOk(url: URL, options: HttpOkOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('no attempt made')
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`dsh-desktop: server not reachable at ${url.href} within ${timeoutMs}ms (last error: ${String(lastError)})`)
}

/**
 * Whether a spawned child process has already exited. `exitCode` and
 * `signalCode` stay null until the child exits, so either becoming non-null
 * means the process is gone (a clean exit sets the code, a signal death sets
 * the signal). A child that never spawned (spawn error) reports neither, which
 * this returns as not-exited; callers treat the spawn-error event separately.
 * @param child - the child process to probe.
 */
export function childExited(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * The HTML signature `dsh web` serves at its root: the boot payload marker.
 * Probing this (plus a 200) distinguishes a live Harness instance from any
 * other local server that happens to occupy the probed port.
 */
const DSH_ROOT_MARKER = '__DSH_BOOT__'

export interface ExistingServerOptions {
  env: NodeJS.ProcessEnv
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Per-probe deadline; defaults to 3s. */
  timeoutMs?: number
}

/**
 * Detect whether a `dsh web` instance is already running on this machine, so
 * the shell can reuse it instead of spawning a second one.
 *
 * Two `dsh web` processes share the same session storage (`~/.dsh/sessions`)
 * with no cross-process write lock, so each assigns sequence numbers from its
 * own in-memory snapshot of the log; concurrent appends then duplicate or gap
 * seq values and corrupt the file ("corrupt session log: seq gap in committed
 * region", history load fails). Reusing one instance removes that whole class
 * of corruption at the source.
 *
 * Candidate order: `DSH_DESKTOP_GUI_URL` (an explicit UI address, e.g. the
 * user's always-on GUI instance) → `DSH_DESKTOP_GUI_PORT` (default `3080`,
 * `dsh web`'s default listen port). A candidate counts as an existing instance
 * only when it answers HTTP 200 AND its HTML carries the Harness boot marker.
 * @param options - env and injectable fetch.
 * @returns the existing instance's URL, or undefined when none is reachable.
 */
export async function detectExistingServer(options: ExistingServerOptions): Promise<URL | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const candidates: string[] = []
  const explicit = options.env.DSH_DESKTOP_GUI_URL
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
  candidates.push(`http://127.0.0.1:${options.env.DSH_DESKTOP_GUI_PORT ?? '3080'}/`)
  for (const candidate of candidates) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      continue
    }
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) continue
      const head = (await response.text()).slice(0, 4096)
      if (head.includes(DSH_ROOT_MARKER)) return url
    } catch {
      // 不可达：候选端口上没有实例，继续下一个候选。
    }
  }
  return undefined
}

/**
 * Find the first process id listening on a TCP port. POSIX uses `lsof -ti
 * tcp:<port>`; Windows parses `netstat -ano` for the LISTENING row. Used by
 * the desktop shell's "restart dsh" path to locate an externally-spawned
 * server that this process did not create.
 * @param port - the TCP port to probe.
 * @returns the listening pid, or undefined when none is found or the lookup fails.
 */
export async function pidOnPort(port: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('netstat', ['-ano'], { windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 5) continue
          const local = parts[1]
          const state = parts[3]
          const pid = Number(parts[4])
          if (local !== undefined && state === 'LISTENING' && local.endsWith(`:${String(port)}`) && Number.isInteger(pid) && pid > 0) {
            resolve(pid)
            return
          }
        }
        resolve(undefined)
      })
    })
  }
  return new Promise((resolve) => {
    // -sTCP:LISTEN keeps only the socket OWNER, not the connected clients
    // (the shell's own NetworkService, browsers) that share the port.
    execFile('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      for (const line of stdout.split(/\r?\n/)) {
        const pid = Number(line.trim())
        if (Number.isInteger(pid) && pid > 0) {
          resolve(pid)
          return
        }
      }
      resolve(undefined)
    })
  })
}

/**
 * Read a process's original command line (argv). Only Linux exposes it via
 * `/proc/<pid>/cmdline`; other platforms return undefined so the caller falls
 * back to its own launch resolution.
 * @param pid - the process id to inspect.
 * @returns the argv array, or undefined when unavailable.
 */
export async function processCmdline(pid: number): Promise<string[] | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const args = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
    return args.length > 0 ? args : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a process's working directory. Only Linux exposes it via the
 * `/proc/<pid>/cwd` symlink; other platforms return undefined.
 * @param pid - the process id to inspect.
 * @returns the cwd, or undefined when unavailable.
 */
export async function processCwd(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    return readlinkSync(`/proc/${String(pid)}/cwd`)
  } catch {
    return undefined
  }
}
