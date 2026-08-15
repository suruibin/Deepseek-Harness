import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampDims, defaultShell, PtyRegistry, type PtyLike } from '../src/pty-registry.ts'

/** Controllable fake pty for spawn-factory injection. */
function fakePty(): PtyLike & {
  emitData(data: string): void
  emitExit(exitCode: number): void
  written: string
  resized: Array<[number, number]>
  killed: boolean
} {
  const listeners: { data: Array<(data: string) => void>; exit: Array<(info: { exitCode: number }) => void> } = {
    data: [],
    exit: [],
  }
  const pty = {
    written: '',
    resized: [] as Array<[number, number]>,
    killed: false,
    emitData(data: string): void { for (const l of listeners.data) l(data) },
    emitExit(exitCode: number): void { for (const l of listeners.exit) l({ exitCode }) },
    write(data: string): void { pty.written += data },
    resize(cols: number, rows: number): void { pty.resized.push([cols, rows]) },
    kill(): void { pty.killed = true },
    onData(listener: (data: string) => void): { dispose(): void } {
      listeners.data.push(listener)
      return { dispose: () => {} }
    },
    onExit(listener: (info: { exitCode: number }) => void): { dispose(): void } {
      listeners.exit.push(listener)
      return { dispose: () => {} }
    },
  }
  return pty
}

function makeRegistry(): {
  registry: PtyRegistry
  spawns: Array<ReturnType<typeof fakePty>>
} {
  const spawns: Array<ReturnType<typeof fakePty>> = []
  const registry = new PtyRegistry({
    spawn: () => {
      const pty = fakePty()
      spawns.push(pty)
      return pty
    },
  })
  return { registry, spawns }
}

afterEach(() => { vi.useRealTimers() })

describe('PtyRegistry', () => {
  it('spawns one pty per tab and reuses it on re-attach', () => {
    const { registry, spawns } = makeRegistry()
    const first = registry.open('t1', '/work', 80, 24)
    const again = registry.open('t1', '/work', 80, 24)
    expect(again).toBe(first)
    expect(spawns.length).toBe(1)
    expect(registry.keys()).toEqual(['t1'])
  })

  it('mirrors output into a bounded transcript for replay', () => {
    const { registry, spawns } = makeRegistry()
    const handle = registry.open('t1', '/work')
    spawns[0]!.emitData('hello ')
    spawns[0]!.emitData('world')
    expect(handle.transcript).toBe('hello world')
    // Re-attach replays the accumulated transcript.
    const reopened = registry.open('t1', '/work')
    expect(reopened.transcript).toBe('hello world')
  })

  it('caps the transcript at the configured limit (head dropped)', () => {
    const spawns: Array<ReturnType<typeof fakePty>> = []
    const registry = new PtyRegistry({
      transcriptLimit: 10,
      spawn: () => {
        const pty = fakePty()
        spawns.push(pty)
        return pty
      },
    })
    const handle = registry.open('t1', '/work')
    spawns[0]!.emitData('0123456789')
    spawns[0]!.emitData('ABCDEF')
    // '0123456789ABCDEF' keeps its last 10 bytes: '6789ABCDEF'
    expect(handle.transcript).toBe('6789ABCDEF')
  })

  it('respawns an exited terminal on re-attach (reconnect yields a live shell)', () => {
    const { registry, spawns } = makeRegistry()
    const handle = registry.open('t1', '/work')
    spawns[0]!.emitExit(1)
    expect(handle.exited).toBe(true)
    expect(handle.exitCode).toBe(1)
    const fresh = registry.open('t1', '/work')
    expect(fresh).not.toBe(handle)
    expect(spawns.length).toBe(2)
    expect(fresh.exited).toBe(false)
  })

  it('respawns when the requested cwd changed (no shell in the wrong directory)', () => {
    const { registry, spawns } = makeRegistry()
    const first = registry.open('t1', '/old')
    registry.open('t1', '/new')
    expect(spawns.length).toBe(2)
    expect(spawns[0]!.killed).toBe(true)
    expect(registry.get('t1')!.cwd).toBe('/new')
    expect(first.exited).toBe(false)
  })

  it('close kills the process, drops state, and is idempotent', () => {
    const { registry, spawns } = makeRegistry()
    registry.open('t1', '/work')
    expect(registry.close('t1')).toBe(true)
    expect(spawns[0]!.killed).toBe(true)
    expect(registry.get('t1')).toBeUndefined()
    expect(registry.close('t1')).toBe(false)
  })

  it('scheduleClose releases after the grace; open within the grace cancels it', () => {
    vi.useFakeTimers()
    const { registry, spawns } = makeRegistry()
    registry.open('t1', '/work')
    registry.scheduleClose('t1', 100)
    expect(registry.get('t1')).toBeDefined()
    vi.advanceTimersByTime(99)
    // Re-attach within the grace: the pending close is cancelled.
    registry.open('t1', '/work')
    vi.advanceTimersByTime(5000)
    expect(registry.get('t1')).toBeDefined()
    expect(spawns[0]!.killed).toBe(false)
    // A second detach with no re-attach releases it.
    registry.scheduleClose('t1', 100)
    vi.advanceTimersByTime(100)
    expect(registry.get('t1')).toBeUndefined()
    expect(spawns[0]!.killed).toBe(true)
  })

  it('opens tabs without a cap (unlimited)', () => {
    const { registry, spawns } = makeRegistry()
    for (let i = 0; i < 10; i++) registry.open('t' + i, '/a')
    expect(registry.keys()).toHaveLength(10)
    expect(spawns).toHaveLength(10)
  })

  it('disposeAll kills every tab', () => {
    const { registry, spawns } = makeRegistry()
    registry.open('t1', '/a')
    registry.open('t2', '/b')
    registry.disposeAll()
    expect(spawns.every((pty) => pty.killed)).toBe(true)
    expect(registry.keys()).toEqual([])
  })

  it('clampDims floors decimals and bounds into 2..1024', () => {
    expect(clampDims(80.9, 24.1)).toEqual({ cols: 80, rows: 24 })
    expect(clampDims(0, 0)).toEqual({ cols: 2, rows: 2 })
    expect(clampDims(5000, 5000)).toEqual({ cols: 1024, rows: 1024 })
  })

  it('defaultShell prefers $SHELL and falls back per platform', () => {
    const saved = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    expect(defaultShell()).toBe('/bin/zsh')
    process.env.SHELL = ''
    expect(defaultShell()).toBe('/bin/bash')
    process.env.SHELL = saved
  })
})
