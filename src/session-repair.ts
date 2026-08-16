/**
 * 会话日志自动修复。
 *
 * dsh 把会话历史存在 ~/.dsh/sessions/<project>/<session>/session.jsonl.zstd
 * (每行一个 JSONL 记录、每行独立 zstd 压缩)。当多个 dsh 实例同时写同一个
 * 会话时, 各实例基于自己内存里的 seq 分配事件序号, 文件里会出现 seq 缺口
 * 或回退 ("corrupt session log: seq gap in committed region"), 导致历史无法
 * 加载。本模块在启动时扫描全部会话日志, 检测此类损坏并自动修复:
 *
 *   1. 备份原文件 (同目录 .bak-<时间戳>)
 *   2. 分析写流结构, 保留 seq 最多的一条完整流 (尾部流=最新, 头部流=主对话,
 *      自动取事件数多的)
 *   3. 逐事件重建 (每事件一行, zstd 单帧, header 原样保留)
 *   4. 重扫自检, 失败不写盘
 *
 * 由 main.ts 在启动 dsh web 之前调用, 保证 GUI 打开会话时历史已可用。
 */
import { copyFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export interface RepairDetail {
  id: string
  /** 会话日志当前是否完好 (正常或已修复均为 true) */
  ok: boolean
  /** 本次是否执行了修复 */
  fixed: boolean
  /** 修复后的事件数 */
  events: number
  /** 修复方案等说明 */
  note?: string
}

export interface RepairReport {
  scanned: number
  fixed: number
  brokenRemaining: number
  details: RepairDetail[]
}

interface EventLike {
  seq: number
  type: string
  time: number
  [key: string]: unknown
}

interface ParsedLog {
  header: Record<string, unknown> | null
  events: EventLike[]
}

interface Plan {
  seqCount: number
  S_last: number
  head: boolean
}

/** 解码一行存储记录: chunk 打包行展开为多个 assistant/chunk, 其余原样返回。 */
function decodeStorageRecord(value: unknown): EventLike[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [value as EventLike]
  const v = value as Record<string, unknown>
  const tag = v.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [v as unknown as EventLike]
  const row = v
  const data = row.data as Record<string, unknown>
  const members = (row.type === 'tool-call-chunks' ? data.args : data.texts) as unknown[]
  const events: EventLike[] = []
  let time = row.time0 as number
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += (data.dt as number[])[k - 1]!
    let chunk: Record<string, unknown>
    if (row.type === 'text-chunks') chunk = { type: 'text-delta', index: data.index, text: members[k] }
    else if (row.type === 'reasoning-chunks') chunk = { type: 'reasoning-delta', index: data.index, text: members[k] }
    else chunk = {
      type: 'tool-call-delta',
      index: data.index,
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      argumentsDelta: members[k],
    }
    events.push({ type: 'assistant/chunk', seq: (row.seq0 as number) + k, time, data: { turn: data.turn, step: data.step, chunk } })
  }
  return events
}

function parseLog(buf: Buffer): ParsedLog {
  const frames: number[] = []
  let pos = 0
  while (pos < buf.length - 4) {
    const idx = buf.indexOf(MAGIC, pos)
    if (idx === -1) break
    frames.push(idx)
    pos = idx + 4
  }
  let header: Record<string, unknown> | null = null
  const events: EventLike[] = []
  for (let i = 0; i < frames.length; i++) {
    const start = frames[i]
    const end = i + 1 < frames.length ? frames[i + 1] : buf.length
    let text: string
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      continue
    }
    for (const rowText of text.split('\n').filter((r) => r.length > 0)) {
      let v: unknown
      try {
        v = JSON.parse(rowText)
      } catch {
        continue
      }
      if (typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'session' && header === null) {
        header = v as Record<string, unknown>
        continue
      }
      for (const ev of decodeStorageRecord(v)) events.push(ev)
    }
  }
  return { header, events }
}

function findFirstGap(events: EventLike[]): string {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq !== events[i - 1]!.seq + 1) {
      return 'seq ' + events[i]!.seq + ' (期望 ' + (events[i - 1]!.seq + 1) + ')'
    }
  }
  return '无'
}

/** 分析损坏结构: 尾部最长连续后缀 [T..S_last]、头部最长连续前缀 [0..H]、前缀完整性。 */
function analyze(events: EventLike[]): { ok: boolean; firstGap: string; plan?: Plan; error?: string } {
  const n = events.length
  if (n === 0) return { ok: false, firstGap: '无事件', error: '无事件' }
  const S_last = events[n - 1]!.seq
  let T = S_last
  for (let i = n - 2; i >= 0; i--) {
    if (events[i]!.seq === events[i + 1]!.seq - 1) T = events[i]!.seq
    else break
  }
  let H = events[0]!.seq === 0 ? 0 : -1
  for (let i = 1; i < n; i++) {
    if (events[i]!.seq === events[i - 1]!.seq + 1) H = events[i]!.seq
    else break
  }
  const seen = new Set(events.map((e) => e.seq))
  let prefixOk = T > 0
  for (let s = 0; s < T; s++) {
    if (!seen.has(s)) {
      prefixOk = false
      break
    }
  }
  const cand1: Plan | null = prefixOk ? { seqCount: S_last + 1, S_last, head: false } : null
  const cand2: Plan | null = H >= 0 ? { seqCount: H + 1, S_last: H, head: true } : null
  const plan = cand1 && cand2 ? (cand1.seqCount >= cand2.seqCount ? cand1 : cand2) : (cand1 ?? cand2)
  if (!plan) return { ok: false, firstGap: findFirstGap(events), error: '无法确定可恢复的连续序列' }
  return { ok: true, firstGap: findFirstGap(events), plan }
}

/** 重建: 保留的每个 seq 取"最后一次出现"的事件, 逐事件一行, 每批 ~2MB 明文一个 zstd 帧, header 单独一帧。 */
function rebuild(parsed: ParsedLog, plan: Plan): { ok: boolean; buf?: Buffer; error?: string } {
  if (parsed.header === null) return { ok: false, error: '缺少 header 行' }
  const bySeq = new Map<number, EventLike>()
  for (const ev of parsed.events) bySeq.set(ev.seq, ev)
  const chunks: Buffer[] = [zstdCompressSync(Buffer.from(JSON.stringify(parsed.header) + '\n'))]
  const BATCH_BYTES = 2 * 1024 * 1024
  let batch: string[] = []
  let batchBytes = 0
  const flush = (): void => {
    if (batch.length === 0) return
    chunks.push(zstdCompressSync(Buffer.from(batch.join('\n') + '\n')))
    batch = []
    batchBytes = 0
  }
  for (let s = 0; s <= plan.S_last; s++) {
    const ev = bySeq.get(s)
    if (ev === undefined) return { ok: false, error: 'seq ' + s + ' 缺失' }
    const line = JSON.stringify(ev)
    batch.push(line)
    batchBytes += line.length
    if (batchBytes >= BATCH_BYTES) flush()
  }
  flush()
  return { ok: true, buf: Buffer.concat(chunks) }
}

function verify(buf: Buffer): { ok: boolean; count?: number; error?: string } {
  const parsed = parseLog(buf)
  for (let i = 0; i < parsed.events.length; i++) {
    if (parsed.events[i]!.seq !== i) return { ok: false, error: 'seq ' + parsed.events[i]!.seq + '@' + i }
  }
  return { ok: true, count: parsed.events.length }
}

function findLogs(dir: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    // 跳过隐藏/备份目录（如 ~/.dsh/sessions 下的 .dsh-* 或 .bak-*），它们不是会话目录
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue
      findLogs(p, out)
    }
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

/**
 * 扫描并修复会话日志。默认扫描 ~/.dsh/sessions; 传入 root 可覆盖 (测试用)。
 * 同步执行 (fs + zstd 均为同步), 由主进程在启动 dsh web 前调用。
 */
export function repairSessionLogs(root: string = join(homedir(), '.dsh', 'sessions')): RepairReport {
  const report: RepairReport = { scanned: 0, fixed: 0, brokenRemaining: 0, details: [] }
  for (const file of findLogs(root)) {
    const id = file.split('/').filter(Boolean).find((s) => s.startsWith('session-')) ?? file
    let parsed: ParsedLog
    try {
      parsed = parseLog(readFileSync(file))
    } catch {
      report.details.push({ id, ok: false, fixed: false, events: 0, note: '读取失败' })
      report.brokenRemaining++
      continue
    }
    report.scanned++
    const analysis = analyze(parsed.events)
    const healthy = analysis.ok && analysis.firstGap === '无' && analysis.plan !== undefined && analysis.plan.S_last === parsed.events.length - 1
    if (healthy) {
      report.details.push({ id, ok: true, fixed: false, events: parsed.events.length })
      continue
    }
    if (!analysis.ok || analysis.plan === undefined) {
      report.details.push({ id, ok: false, fixed: false, events: parsed.events.length, note: '无法自动修复: ' + analysis.error })
      report.brokenRemaining++
      continue
    }
    const plan = analysis.plan
    const rebuilt = rebuild(parsed, plan)
    if (!rebuilt.ok || rebuilt.buf === undefined) {
      report.details.push({ id, ok: false, fixed: false, events: parsed.events.length, note: '重建失败: ' + rebuilt.error })
      report.brokenRemaining++
      continue
    }
    const check = verify(rebuilt.buf)
    if (!check.ok) {
      report.details.push({ id, ok: false, fixed: false, events: parsed.events.length, note: '重建后验证失败: ' + check.error })
      report.brokenRemaining++
      continue
    }
    const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(file, bak)
    const tmp = file + '.fixing'
    writeFileSync(tmp, rebuilt.buf)
    renameSync(tmp, file)
    report.fixed++
    report.details.push({
      id,
      ok: true,
      fixed: true,
      events: check.count ?? 0,
      note: (plan.head ? '保留头部流' : '保留尾部流') + ' → seq 0..' + plan.S_last,
    })
  }
  return report
}
