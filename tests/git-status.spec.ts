import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { gitStatus, gitStatusCached, parsePorcelainZ } from '../src/git-status.ts'

/** Minimal ChildProcess-like fake: streams stdout/stderr and emits close. */
function fakeChild(out: string, code = 0, errOut = ''): ReturnType<typeof spawnFake> {
  const child = new EventEmitter() as ReturnType<typeof spawnFake>
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  setImmediate(() => {
    if (errOut !== '') child.stderr.write(errOut)
    if (out !== '') child.stdout.write(out)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code)
  })
  return child
}

type FakeChild = {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Scripted git: key the response off the first real arg after the -C prefix. */
function makeSpawn(script: Record<string, { out?: string; code?: number; err?: string }>) {
  const calls: string[][] = []
  const spawnImpl = (_command: string, args: string[], _opts: unknown): FakeChild => {
    calls.push(args)
    // full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
    const key = args.slice(5).join(' ')
    const entry = script[key] ?? { out: '', code: 0 }
    return fakeChild(entry.out ?? '', entry.code ?? 0, entry.err ?? '')
  }
  return { spawnImpl, calls }
}

describe('parsePorcelainZ', () => {
  it('parses plain entries (xy + path)', () => {
    const entries = parsePorcelainZ(' M src/a.ts\0?? new.txt\0A  staged.ts\0')
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'new.txt', xy: '??' },
      { path: 'staged.ts', xy: 'A ' },
    ])
  })

  it('collapses rename/copy pairs to the new path (real git: NEW path first)', () => {
    // Real `git status --porcelain=v1 -z` puts the NEW path in the first NUL
    // field and the origin in the second: 'RM new.txt\0old.txt\0'.
    const entries = parsePorcelainZ('R  new.ts\0old.ts\0C  src/n.ts\0src/o.ts\0')
    expect(entries).toEqual([
      { path: 'new.ts', xy: 'R ' },
      { path: 'src/n.ts', xy: 'C ' },
    ])
  })

  it('returns [] for empty output', () => {
    expect(parsePorcelainZ('')).toEqual([])
  })
})

describe('gitStatus', () => {
  it('reports not-a-repo when rev-parse fails', async () => {
    const { spawnImpl } = makeSpawn({
      'rev-parse --is-inside-work-tree': { code: 128, err: 'fatal: not a git repository' },
    })
    expect(await gitStatus('/work', { spawn: spawnImpl })).toEqual({ isRepo: false, entries: [] })
  })

  it('reports not-a-repo when git is missing (spawn error)', async () => {
    const spawnImpl = (): FakeChild => {
      const child = new EventEmitter() as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      setImmediate(() => { child.emit('error', new Error('ENOENT')) })
      return child
    }
    expect(await gitStatus('/work', { spawn: spawnImpl })).toEqual({ isRepo: false, entries: [] })
  })

  it('returns branch, root and absolute entry paths inside a repo', async () => {
    const { spawnImpl } = makeSpawn({
      'rev-parse --is-inside-work-tree': { out: 'true\n' },
      'rev-parse --abbrev-ref HEAD': { out: 'main\n' },
      'rev-parse --show-toplevel': { out: '/repo\n' },
      'status --porcelain=v1 -z --untracked-files=normal': { out: ' M src/a.ts\0?? new.txt\0' },
    })
    const result = await gitStatus('/repo/sub', { spawn: spawnImpl })
    expect(result).toEqual({
      isRepo: true,
      branch: 'main',
      root: '/repo',
      entries: [
        { path: '/repo/src/a.ts', xy: ' M' },
        { path: '/repo/new.txt', xy: '??' },
      ],
    })
  })

  it('falls back to HEAD on a detached branch query', async () => {
    const { spawnImpl } = makeSpawn({
      'rev-parse --is-inside-work-tree': { out: 'true\n' },
      'rev-parse --abbrev-ref HEAD': { code: 128, err: 'fatal: ambiguous' },
      'rev-parse --show-toplevel': { out: '/repo\n' },
      'status --porcelain=v1 -z --untracked-files=normal': { out: '' },
    })
    const result = await gitStatus('/repo', { spawn: spawnImpl })
    expect(result.branch).toBe('HEAD')
    expect(result.isRepo).toBe(true)
  })
})

describe('gitStatusCached', () => {
  const repoScript = (): Record<string, { out?: string; code?: number; err?: string }> => ({
    'rev-parse --is-inside-work-tree': { out: 'true\n' },
    'rev-parse --abbrev-ref HEAD': { out: 'main\n' },
    'rev-parse --show-toplevel': { out: '/repo\n' },
    'status --porcelain=v1 -z --untracked-files=normal': { out: ' M a.ts\0' },
  })

  it('serves repeat calls within the TTL from cache (one git pipeline)', async () => {
    const { spawnImpl, calls } = makeSpawn(repoScript())
    const cache = new Map()
    let t = 0
    const opts = { spawn: spawnImpl, now: (): number => t, cache }
    const first = await gitStatusCached('/repo', opts)
    const second = await gitStatusCached('/repo', opts)
    expect(second).toBe(first)
    expect(calls.length).toBe(4)
    // TTL boundary: expiresAt = 0 + 1500, so t=1500 is already expired.
    t = 1500
    await gitStatusCached('/repo', opts)
    expect(calls.length).toBe(8)
  })

  it('dedupes concurrent in-flight calls into one pipeline', async () => {
    const { spawnImpl, calls } = makeSpawn(repoScript())
    const cache = new Map()
    const opts = { spawn: spawnImpl, now: (): number => 0, cache }
    const [a, b] = await Promise.all([gitStatusCached('/repo', opts), gitStatusCached('/repo', opts)])
    expect(b).toBe(a)
    expect(calls.length).toBe(4)
  })

  it('keys the cache per cwd', async () => {
    const { spawnImpl, calls } = makeSpawn(repoScript())
    const cache = new Map()
    const opts = { spawn: spawnImpl, now: (): number => 0, cache }
    await gitStatusCached('/repo', opts)
    await gitStatusCached('/other', opts)
    expect(calls.length).toBe(8)
  })

  it('caches non-repo results too (no re-spawn while hot)', async () => {
    const { spawnImpl, calls } = makeSpawn({
      'rev-parse --is-inside-work-tree': { code: 128, err: 'fatal: not a git repository' },
    })
    const cache = new Map()
    const opts = { spawn: spawnImpl, now: (): number => 0, cache }
    const first = await gitStatusCached('/plain', opts)
    const second = await gitStatusCached('/plain', opts)
    expect(first).toEqual({ isRepo: false, entries: [] })
    expect(second).toBe(first)
    expect(calls.length).toBe(1)
  })
})
