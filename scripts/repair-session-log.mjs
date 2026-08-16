#!/usr/bin/env node
/**
 * 自动检测并修复损坏的 dsh 会话日志（seq 缺口 / 多写流交错导致的 corrupt session log）。
 *
 * 用法:
 *   node scripts/repair-session-log.mjs                  # 扫描全部会话并自动修复损坏的
 *   node scripts/repair-session-log.mjs --dry-run        # 只检测并报告，不修改任何文件
 *   node scripts/repair-session-log.mjs --session <id>   # 只处理指定会话(可传多次)
 *   node scripts/repair-session-log.mjs --root <dir>     # 指定会话根目录(默认 ~/.dsh/sessions)
 *
 * 每个被修复的会话都会先备份原文件(同目录 .bak-<时间戳>)，重建后重新扫描自检。
 * 修复原则: 保留 seq 最多的一条完整流(尾部流或头部流，自动取事件数多的)。
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
const opts = { dryRun: false, sessions: [], root: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--session") opts.sessions.push(argv[++i]);
  else if (a === "--root") opts.root = argv[++i];
  else { console.error("未知参数: " + a); process.exit(1); }
}
const ROOT = opts.root ?? join(homedir(), ".dsh", "sessions");

// ---------- 解码一行存储记录(与 dsh-session/chunk-rows 一致) ----------
function decodeStorageRecord(value) {
  const isRecord = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord) return [value];
  const tag = value.type;
  if (tag !== "text-chunks" && tag !== "reasoning-chunks" && tag !== "tool-call-chunks") return [value];
  const row = value;
  const members = row.type === "tool-call-chunks" ? row.data.args : row.data.texts;
  const events = [];
  let time = row.time0;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += row.data.dt[k - 1];
    let chunk;
    if (row.type === "text-chunks") chunk = { type: "text-delta", index: row.data.index, text: members[k] };
    else if (row.type === "reasoning-chunks") chunk = { type: "reasoning-delta", index: row.data.index, text: members[k] };
    else chunk = { type: "tool-call-delta", index: row.data.index, id: row.data.id, ...(row.data.name !== undefined ? { name: row.data.name } : {}), argumentsDelta: members[k] };
    events.push({ type: "assistant/chunk", seq: row.seq0 + k, time, data: { turn: row.data.turn, step: row.data.step, chunk } });
  }
  return events;
}

// ---------- 解析日志文件 ----------
// 返回 { header, events: [{seq,obj}], frames, badFrames }
function parseLog(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length - 4) {
    const idx = buf.indexOf(MAGIC, pos);
    if (idx === -1) break;
    frames.push(idx);
    pos = idx + 4;
  }
  let header = null;
  const events = [];
  let badFrames = 0;
  for (let i = 0; i < frames.length; i++) {
    const start = frames[i];
    const end = i + 1 < frames.length ? frames[i + 1] : buf.length;
    let text;
    try { text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8"); } catch { badFrames++; continue; }
    for (const rowText of text.split("\n").filter((r) => r.length)) {
      let v;
      try { v = JSON.parse(rowText); } catch { badFrames++; continue; }
      if (v && typeof v === "object" && v.type === "session" && header === null) { header = v; continue; }
      let decoded;
      try { decoded = decodeStorageRecord(v); } catch { decoded = []; }
      for (const ev of decoded) events.push(ev);
    }
  }
  return { header, events, frames: frames.length, badFrames };
}

// ---------- 分析损坏结构与修复方案 ----------
function findFirstGap(events) {
  for (let i = 1; i < events.length; i++) if (events[i].seq !== events[i - 1].seq + 1) return "seq " + events[i].seq + " (期望 " + (events[i - 1].seq + 1) + ")";
  return "无";
}
function analyze(events) {
  const n = events.length;
  if (n === 0) return { ok: false, error: "无事件" };
  // 1) 从尾部找最长连续后缀 [T..S_last]
  const S_last = events[n - 1].seq;
  let T = S_last;
  for (let i = n - 2; i >= 0; i--) {
    if (events[i].seq === events[i + 1].seq - 1) T = events[i].seq;
    else break;
  }
  // 2) 头部最长连续前缀 [0..H]
  let H = events[0].seq === 0 ? 0 : -1;
  for (let i = 1; i < n; i++) {
    if (events[i].seq === events[i - 1].seq + 1) H = events[i].seq;
    else break;
  }
  // 3) 前缀完整性: seq 0..T-1 是否都出现过(任意位置)
  const seen = new Set(events.map((e) => e.seq));
  let prefixOk = T > 0;
  for (let s = 0; s < T; s++) if (!seen.has(s)) { prefixOk = false; break; }
  // 4) 候选: 尾部流 vs 头部流，取事件数多的
  const cand1 = prefixOk ? { seqCount: S_last + 1, S_last, head: false } : null;
  const cand2 = H >= 0 ? { seqCount: H + 1, S_last: H, head: true } : null;
  const plan = cand1 && cand2 ? (cand1.seqCount >= cand2.seqCount ? cand1 : cand2) : (cand1 ?? cand2);
  if (!plan) return { ok: false, error: "无法确定可恢复的连续序列" };
  return { ok: true, firstGap: findFirstGap(events), plan };
}

// ---------- 重建: 对保留的每个 seq 取"最后一次出现"的事件，逐事件一行(zstd 单帧)，header 原样 ----------
function rebuild(parsed, plan) {
  const bySeq = new Map();
  for (const ev of parsed.events) bySeq.set(ev.seq, ev);
  const chunks = [zstdCompressSync(Buffer.from(JSON.stringify(parsed.header) + "\n"))];
  // 每批 ~2MB 明文一个 zstd 帧，避免超大会话逐事件一帧导致文件膨胀
  const BATCH_BYTES = 2 * 1024 * 1024;
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    chunks.push(zstdCompressSync(Buffer.from(batch.join("\n") + "\n")));
    batch = [];
    batchBytes = 0;
  };
  for (let s = 0; s <= plan.S_last; s++) {
    const ev = bySeq.get(s);
    if (ev === undefined) return { ok: false, error: "seq " + s + " 缺失" };
    const line = JSON.stringify(ev);
    batch.push(line);
    batchBytes += line.length;
    if (batchBytes >= BATCH_BYTES) flush();
  }
  flush();
  return { ok: true, buf: Buffer.concat(chunks) };
}

// ---------- 验证: seq 必须严格连续 ----------
function verify(buf) {
  const parsed = parseLog(buf);
  for (let i = 0; i < parsed.events.length; i++) if (parsed.events[i].seq !== i) return { ok: false, error: "seq " + parsed.events[i].seq + "@" + i };
  return { ok: true, count: parsed.events.length };
}

// ---------- 扫描 ----------
function findLogs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    // 跳过隐藏/备份目录，避免把备份文件误当会话日志
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      findLogs(p, out);
    }
    else if (e.name.endsWith(".jsonl.zstd")) out.push(p);
  }
  return out;
}

const allLogs = findLogs(ROOT).filter((p) =>
  opts.sessions.length === 0 || opts.sessions.some((id) => p.includes(id))
);
if (allLogs.length === 0) { console.error("在 " + ROOT + " 下未找到任何 session.jsonl.zstd"); process.exit(1); }

let fixed = 0, broken = 0, failed = 0;
for (const file of allLogs) {
  const id = file.split("/").filter(Boolean).find((s) => s.startsWith("session-")) ?? file;
  let parsed;
  try { parsed = parseLog(readFileSync(file)); }
  catch (e) { console.log("❌ " + id + " 读取失败: " + e.message); failed++; continue; }
  const analysis = analyze(parsed.events);
  const healthy = analysis.ok && analysis.firstGap === "无" && analysis.plan.S_last === parsed.events.length - 1;
  if (healthy) { console.log("✅ " + id + "  正常 (" + parsed.events.length + " 事件)"); continue; }
  broken++;
  console.log("❌ " + id + "  损坏: " + analysis.firstGap + " | " + parsed.events.length + " 事件, " + statSync(file).size + " 字节");
  if (!analysis.ok) { console.log("   无法自动修复: " + analysis.error); failed++; continue; }
  const plan = analysis.plan;
  console.log("   方案: " + (plan.head ? "保留头部流" : "保留尾部流") + " → seq 0.." + plan.S_last + " (" + plan.seqCount + " 事件)");
  if (opts.dryRun) { console.log("   (dry-run, 未修改)"); continue; }
  const rebuilt = rebuild(parsed, plan);
  if (!rebuilt.ok) { console.log("   重建失败: " + rebuilt.error); failed++; continue; }
  const check = verify(rebuilt.buf);
  if (!check.ok) { console.log("   重建后验证失败: " + check.error + " (未写盘)"); failed++; continue; }
  const bak = file + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(file, bak);
  const tmp = file + ".fixing";
  writeFileSync(tmp, rebuilt.buf);
  renameSync(tmp, file);
  console.log("   已修复: " + check.count + " 事件 | 备份: " + bak.split("/").pop());
  fixed++;
}
console.log("\n完成: 正常 " + (allLogs.length - broken) + ", 损坏 " + broken + ", 已修复 " + fixed + ", 失败 " + failed);
process.exit(failed > 0 ? 1 : 0);
