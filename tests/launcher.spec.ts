import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  childExited,
  detectExistingServer,
  parseReadyLine,
  readDshVersion,
  resolveExternalLaunchToken,
  resolveWebLaunch,
  validateInstanceToken,
  waitForHttpOk,
  waitForReadyLine,
  WEB_ARGS,
} from '../src/launcher.ts'

// Fixture paths are built with the host's `join` because the launcher resolves
// its candidates with the host's `node:path`; a Windows literal would not
// normalize on POSIX. `platform` is injected separately and only selects the
// permission fallback, so the win32 default below is independent of the path
// flavor.
const DSH_HOME = join('dsh-checkout')

function launchWith(
  exists: (path: string) => boolean,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = 'win32',
): ReturnType<typeof resolveWebLaunch> {
  return resolveWebLaunch({ env, exists, platform })
}

describe('parseReadyLine', () => {
  it('parses the plain readiness line', () => {
    const url = parseReadyLine('dsh web: http://127.0.0.1:34567')
    expect(url?.href).toBe('http://127.0.0.1:34567/')
  })

  it('parses the readiness line with the LAN note', () => {
    const url = parseReadyLine('dsh web: http://127.0.0.1:34567 (LAN: http://192.168.1.5:34567)')
    expect(url?.port).toBe('34567')
  })

  it('returns undefined for a non-readiness line', () => {
    expect(parseReadyLine('cordis: plugin loaded')).toBeUndefined()
  })

  it('returns undefined when the URL part is not a URL', () => {
    expect(parseReadyLine('dsh web: not a url')).toBeUndefined()
  })
})

describe('resolveWebLaunch', () => {
  // `platform` is explicit: the permission fallback is a win32 behavior, and
  // leaving it to `process.platform` would make these cases host-dependent.
  const base = { env: {}, platform: 'win32' as NodeJS.Platform }

  it('prefers DSH_BIN over every other candidate', () => {
    const dshBin = join('tools', 'dsh')
    const launch = resolveWebLaunch({
      ...base,
      env: { DSH_BIN: dshBin },
    })
    expect(launch).toEqual({
      command: dshBin,
      args: [...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      source: 'DSH_BIN',
    })
  })

  it('falls back to danger-full-access on win32 when DSH_PERMISSION_MODE is unset', () => {
    const launch = launchWith(() => false)
    expect(launch.env).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
  })

  it('keeps an explicit DSH_PERMISSION_MODE untouched', () => {
    const launch = launchWith(() => false, { DSH_PERMISSION_MODE: 'workspace-write' })
    expect(launch.env).toEqual({})
  })

  it('adds no permission fallback off Windows', () => {
    const launch = launchWith(() => false, {}, 'linux')
    expect(launch.env).toEqual({})
  })

  it('prefers the DSH_HOME built lib over the source launch', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'lib', 'bin.js')), { DSH_HOME: DSH_HOME })
    expect(launch).toEqual({
      command: 'node',
      args: [join(DSH_HOME, 'apps', 'cli', 'lib', 'bin.js'), ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      source: 'DSH_HOME lib',
    })
  })

  it('falls back to the tsx source launch with DSH_HOME as cwd', () => {
    const launch = launchWith(path => path.endsWith(join('apps', 'cli', 'src', 'bin.ts')), { DSH_HOME: DSH_HOME })
    expect(launch).toEqual({
      command: 'node',
      args: ['--import', 'tsx/esm', join(DSH_HOME, 'apps', 'cli', 'src', 'bin.ts'), ...WEB_ARGS],
      env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      cwd: DSH_HOME,
      source: 'DSH_HOME source',
    })
  })

  it('falls back to PATH when DSH_HOME holds no CLI', () => {
    const launch = launchWith(() => false, { DSH_HOME: DSH_HOME })
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
  })

  it('treats an empty DSH_HOME as unset', () => {
    // A blank DSH_HOME must not be probed as a checkout root: `join('', …)`
    // would resolve relative to the process cwd and could spawn a stranger's CLI.
    const launch = launchWith(() => true, { DSH_HOME: '' })
    expect(launch.source).toBe('PATH')
  })

  it('falls back to dsh on PATH when nothing else exists', () => {
    const launch = launchWith(() => false)
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
  })

  it('treats an empty DSH_BIN as unset', () => {
    const launch = launchWith(() => false, { DSH_BIN: '' })
    expect(launch).toEqual({ command: 'dsh', args: [...WEB_ARGS], env: { DSH_PERMISSION_MODE: 'danger-full-access' }, source: 'PATH' })
  })

  it('treats an empty DSH_PERMISSION_MODE as unset on win32', () => {
    const launch = launchWith(() => false, { DSH_PERMISSION_MODE: '' })
    expect(launch.env).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
  })
})

describe('waitForReadyLine', () => {
  function streamOf(chunks: string[]): AsyncIterable<string> {
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  it('resolves with the URL even when the line spans chunks', async () => {
    const url = await waitForReadyLine(streamOf(['dsh web: http://127', '.0.0.1:1234\nmore noise']))
    expect(url.href).toBe('http://127.0.0.1:1234/')
  })

  it('rejects when the stream ends without a readiness line', async () => {
    await expect(waitForReadyLine(streamOf(['cordis: booting\n']))).rejects.toThrow(/exited before printing/)
  })

  it('rejects after the timeout when the stream never yields a line', async () => {
    const pending = new Promise<string>(() => {})
    const stream = (async function* () { yield 'no line here\n'; await pending })()
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
  })

  it('accepts a final readiness line without a trailing newline', async () => {
    const url = await waitForReadyLine(streamOf(['noise line\n', 'dsh web: http://127.0.0.1:4321']))
    expect(url.href).toBe('http://127.0.0.1:4321/')
  })

  it('keeps consuming the stream after readiness instead of destroying it', async () => {
    // Regression: returning from a `for await` over a Node stream destroys it,
    // and the live server then dies with EPIPE on its next stdout write.
    const stream = new PassThrough()
    const forwarded: string[] = []
    const urlPromise = waitForReadyLine(stream, { onChunk: (chunk) => { forwarded.push(chunk) } })
    stream.write('dsh web: http://127.0.0.1:1234\n')
    const url = await urlPromise
    expect(url.href).toBe('http://127.0.0.1:1234/')
    stream.write('more server output after readiness\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.destroyed).toBe(false)
    expect(forwarded.join('')).toContain('more server output after readiness')
    stream.end()
    await new Promise(resolve => setTimeout(resolve, 20))
  })

  it('destroys the stream on timeout so the consumption loop cannot leak', async () => {
    const stream = new PassThrough()
    stream.write('nothing useful\n')
    await expect(waitForReadyLine(stream, { timeoutMs: 10 })).rejects.toThrow(/within 10ms/)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream.destroyed).toBe(true)
  })
})

describe('waitForHttpOk', () => {
  it('resolves when the server answers 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 100, pollIntervalMs: 5 })).resolves.toBeUndefined()
  })

  it('resolves on 303 without following the redirect (dsh 0.1.2 token-URL cookie flow)', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: { redirect?: string }) => {
      expect(init?.redirect).toBe('manual')
      return new Response('see other', { status: 303, headers: { location: '/' } })
    })
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 100, pollIntervalMs: 5 })).resolves.toBeUndefined()
  })

  it('resolves once a failing server recovers', async () => {
    let attempts = 0
    const fetchImpl = vi.fn(async () => {
      attempts += 1
      return attempts < 3 ? new Response('no', { status: 503 }) : new Response('ok', { status: 200 })
    })
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 200, pollIntervalMs: 5 })).resolves.toBeUndefined()
    expect(attempts).toBe(3)
  })

  it('rejects with the URL when the server never answers', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 30, pollIntervalMs: 5 }))
      .rejects.toThrow(/http:\/\/127\.0\.0\.1:1\/.*ECONNREFUSED/)
  })

  it('keeps polling and rejects when the server only answers non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 50, pollIntervalMs: 5 }))
      .rejects.toThrow(/HTTP 500/)
    // The poll must have retried until the deadline, not given up after one attempt.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
  })

  it('accepts any non-5xx answer for a tokenless ready URL (dsh rc.2 loopback fence)', async () => {
    // rc.2 prints `http://127.0.0.1:PORT` with no token; its fence can 401 the
    // tokenless probe even though the server is perfectly alive and the window
    // will get the same loopback trust.
    const fetchImpl = vi.fn(async () => new Response('dsh web authentication required', { status: 401 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/'), { fetchImpl, timeoutMs: 100, pollIntervalMs: 5 })).resolves.toBeUndefined()
  })

  it('still gates tokened URLs on 200/303 (rc.1-style cookie flow)', async () => {
    const fetchImpl = vi.fn(async () => new Response('dsh web authentication required', { status: 401 }))
    await expect(waitForHttpOk(new URL('http://127.0.0.1:1/?token=abc'), { fetchImpl, timeoutMs: 50, pollIntervalMs: 5 }))
      .rejects.toThrow(/HTTP 401/)
  })
})

describe('childExited', () => {
  it('is false while the child is still running', () => {
    expect(childExited({ exitCode: null, signalCode: null })).toBe(false)
  })

  it('is true once the child exited with a code', () => {
    expect(childExited({ exitCode: 0, signalCode: null })).toBe(true)
  })

  it('is true once the child was killed by a signal', () => {
    expect(childExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true)
  })
})

describe('detectExistingServer', () => {
  it('returns undefined when no candidate is reachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing).toBeUndefined()
  })

  it('returns undefined when a candidate answers but lacks the Harness marker', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>other app</html>', { status: 200 }))
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing).toBeUndefined()
  })

  it('reuses the default GUI port when it serves a real instance', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html><script>window.__DSH_BOOT__ = {}</script></html>', { status: 200 }))
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:3080/')
    expect(existing?.authRequired).toBe(false)
  })

  it('finds the marker even when it sits past the document head', async () => {
    // Regression: the marker lives inside the bundled client scripts ~14KB
    // into the payload; a 4KiB head window never saw it and reuse never fired.
    const filler = 'x'.repeat(20_000)
    const fetchImpl = vi.fn(async () => new Response(`<html><body>${filler}window.__DSH_BOOT__</body></html>`, { status: 200 }))
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:3080/')
  })

  it('honors DSH_DESKTOP_GUI_PORT', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>window.__DSH_BOOT__</html>', { status: 200 }))
    const existing = await detectExistingServer({ env: { DSH_DESKTOP_GUI_PORT: '41501' }, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:41501/')
  })

  it('prefers an explicit DSH_DESKTOP_GUI_URL over the default port', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response('<html>window.__DSH_BOOT__</html>', { status: 200 })
    })
    const existing = await detectExistingServer({ env: { DSH_DESKTOP_GUI_URL: 'http://127.0.0.1:9999/' }, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:9999/')
    // The explicit URL is probed first; the default port is never reached.
    expect(seen).toEqual(['http://127.0.0.1:9999/'])
  })

  it('falls back to the default port when the explicit URL is unreachable', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === 'http://127.0.0.1:9999/') throw new Error('ECONNREFUSED')
      return new Response('<html>window.__DSH_BOOT__</html>', { status: 200 })
    })
    const existing = await detectExistingServer({ env: { DSH_DESKTOP_GUI_URL: 'http://127.0.0.1:9999/' }, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:3080/')
  })

  it('reuses a token-gated instance answering 401 with the dsh auth signature', async () => {
    // Regression: rc.1+ token fences answer every tokenless probe with 401, so
    // the old 200+marker-only check judged the live instance "not running" and
    // spawned a second instance — its session writes then all failed with
    // SessionAlreadyOwnedError (user: 不能选择模型了).
    const fetchImpl = vi.fn(async () => new Response('dsh web authentication required; reopen the URL printed by dsh web.\n', { status: 401 }))
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing?.url.href).toBe('http://127.0.0.1:3080/')
    expect(existing?.authRequired).toBe(true)
  })

  it('ignores a 401 from a non-dsh server (no auth signature body)', async () => {
    const fetchImpl = vi.fn(async () => new Response('router admin login', { status: 401 }))
    const existing = await detectExistingServer({ env: {}, fetchImpl, timeoutMs: 10 })
    expect(existing).toBeUndefined()
  })
})

describe('resolveExternalLaunchToken', () => {
  it('prefers an explicit DSH_WEB_TOKEN over the journal scan', async () => {
    const runImpl = vi.fn(async () => { throw new Error('journalctl not run') })
    const token = await resolveExternalLaunchToken({ env: { DSH_WEB_TOKEN: 'tok-explicit' }, runImpl })
    expect(token).toBe('tok-explicit')
    expect(runImpl).not.toHaveBeenCalled()
  })

  it('scans the journal unit ready lines and takes the last token', async () => {
    const runImpl = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('journalctl')
      expect(args).toContain('--user')
      expect(args).toContain('-u')
      expect(args).toContain('dsh-web')
      return [
        'dsh web: http://127.0.0.1:3080/?token=G90prKgHeJOgzLMTgSGWcgQ_cu2omHZW1jIw0WWNLc8',
        'some other log line',
        'dsh web: http://127.0.0.1:3080/?token=tok-newer-2',
      ].join('\n')
    })
    const token = await resolveExternalLaunchToken({ env: {}, runImpl })
    expect(token).toBe('tok-newer-2')
  })

  it('honors DSH_WEB_UNIT for the journal scan', async () => {
    const runImpl = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toContain('dsh-web-custom')
      return 'dsh web: http://127.0.0.1:3080/?token=tok-unit'
    })
    const token = await resolveExternalLaunchToken({ env: { DSH_WEB_UNIT: 'dsh-web-custom' }, runImpl })
    expect(token).toBe('tok-unit')
  })

  it('returns undefined when the journal scan fails or has no token', async () => {
    const failing = await resolveExternalLaunchToken({ env: {}, runImpl: async () => { throw new Error('no journal') } })
    expect(failing).toBeUndefined()
    const empty = await resolveExternalLaunchToken({ env: {}, runImpl: async () => 'no tokens here' })
    expect(empty).toBeUndefined()
  })
})

describe('validateInstanceToken', () => {
  const base = new URL('http://127.0.0.1:3080/')

  it('accepts the 303 cookie-mint redirect', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://127.0.0.1:3080/?token=tok')
      return new Response(null, { status: 303, headers: { location: '/' } })
    })
    expect(await validateInstanceToken(base, 'tok', fetchImpl)).toBe(true)
  })

  it('accepts a direct 200 (future no-redirect flow)', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>window.__DSH_BOOT__</html>', { status: 200 }))
    expect(await validateInstanceToken(base, 'tok', fetchImpl)).toBe(true)
  })

  it('rejects 401 (token belongs to another instance run) and transport errors', async () => {
    const unauthorized = vi.fn(async () => new Response('dsh web authentication required', { status: 401 }))
    expect(await validateInstanceToken(base, 'stale', unauthorized)).toBe(false)
    const unreachable = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await validateInstanceToken(base, 'tok', unreachable)).toBe(false)
  })
})

describe('readDshVersion', () => {
  it('swaps the web subcommand for --version and returns the first stdout line', async () => {
    // `node --version` prints one line, exercising the same swap path as
    // `node <bin> --version` for a DSH_HOME launch.
    const version = await readDshVersion({ command: process.execPath, args: ['web'] }, 5_000)
    expect(version).toMatch(/^v\d/)
  })

  it('resolves "" instead of throwing when the command fails', async () => {
    const version = await readDshVersion({ command: 'dsh-desktop-definitely-not-a-binary', args: ['web'] }, 2_000)
    expect(version).toBe('')
  })
})
