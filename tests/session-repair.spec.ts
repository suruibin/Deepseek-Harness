import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { repairSessionLogs } from '../src/session-repair.ts'

const dirs: string[] = []

function sessionDir(root: string, id: string): string {
  const d = join(root, '--projects--', id)
  dirs.push(d)
  return d
}

/** 把 JSONL 行数组压缩成 dsh 日志格式 (每行一个 zstd 帧)。 */
function encodeLog(header: unknown, events: unknown[]): Buffer {
  return Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')),
    ...events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n'))),
  ])
}

function event(seq: number, type = 'user/message'): Record<string, unknown> {
  return { type, seq, time: 1786700000000 + seq, data: { content: 'm' + seq } }
}

function decode(buf: Buffer): Array<Record<string, unknown>> {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames: number[] = []
  let pos = 0
  while (pos < buf.length - 4) {
    const idx = buf.indexOf(magic, pos)
    if (idx === -1) break
    frames.push(idx)
    pos = idx + 4
  }
  const out: Array<Record<string, unknown>> = []
  for (let i = 1; i < frames.length; i++) {
    const text = zstdDecompressSync(buf.subarray(frames[i], i + 1 < frames.length ? frames[i + 1] : buf.length)).toString('utf8')
    for (const row of text.split('\n').filter((r) => r.length)) out.push(JSON.parse(row))
  }
  return out
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('repairSessionLogs', () => {
  it('修复 seq 回退的双写流日志', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
    const id = 'session-test-0000-0000-0000-000000000001'
    const dir = sessionDir(root, id)
    const file = join(dir, 'session.jsonl.zstd')
    const header = { type: 'session', version: 0, id, createdAt: 1786699999000, cwd: '/projects', delegationDepth: 0 }
    // 写流 A: seq 0..2; 写流 B 基于旧内存 (只有 1 个事件), 从 seq 1 重新写: 1,2,3
    const buf = encodeLog(header, [event(0), event(1), event(2), event(1, 'assistant/message'), event(2, 'assistant/message'), event(3, 'turn/end')])
    require('node:fs').mkdirSync(dir, { recursive: true })
    require('node:fs').writeFileSync(file, buf)

    const report = repairSessionLogs(root)

    expect(report.scanned).toBe(1)
    expect(report.fixed).toBe(1)
    expect(report.brokenRemaining).toBe(0)
    expect(report.details[0]?.ok).toBe(true)

    // 修复后 seq 必须连续 0..3, 且保留 B 流(最新)的事件
    const repaired = decode(readFileSync(file))
    expect(repaired.map((e) => e.seq)).toEqual([0, 1, 2, 3])
    expect(repaired[1]?.type).toBe('assistant/message') // 取最后一次出现 (B 流)
    // 备份已生成
    const backups = readdirSync(dir).filter((f) => f.includes('.bak-'))
    expect(backups.length).toBe(1)
  })

  it('正常日志不做任何修改', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repair-ok-'))
    const id = 'session-test-0000-0000-0000-000000000002'
    const dir = sessionDir(root, id)
    const file = join(dir, 'session.jsonl.zstd')
    const header = { type: 'session', version: 0, id, createdAt: 1786699999000, cwd: '/projects', delegationDepth: 0 }
    const buf = encodeLog(header, [event(0), event(1), event(2), event(3, 'turn/end')])
    require('node:fs').mkdirSync(dir, { recursive: true })
    require('node:fs').writeFileSync(file, buf)

    const report = repairSessionLogs(root)
    expect(report.fixed).toBe(0)
    expect(report.brokenRemaining).toBe(0)
    expect(report.details[0]?.ok).toBe(true)
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(0)
  })

  it('缺失会话目录时安全返回', () => {
    const report = repairSessionLogs(join(tmpdir(), 'dsh-repair-none-' + Date.now()))
    expect(report.scanned).toBe(0)
    expect(report.fixed).toBe(0)
  })
})
