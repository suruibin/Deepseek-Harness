/**
 * 会话删除与已归档管理（主进程半边）。
 *
 * 语义：
 *   - 「归档」是官方单向 API（workspace.archiveSession），只把会话从列表隐藏、
 *     日志原地保留。本模块不重复实现，由客户端脚本通过官方网关调用它来
 *     「即时隐藏行」。
 *   - 「删除」把会话日志目录（~/.dsh/sessions/<项目>/<sessionId>/）移入独立
 *     回收站目录（~/.dsh-delete-session-trash/sessions/），同时从
 *     workspace.json（archivedSessionIds + 各 workspace 的 sessionIds）与
 *     session_projcache.json 移除该会话，使其在重启后彻底消失；回收站清单
 *     （manifest.json）登记删除项供「已删除」区列出与恢复。
 *   - 「取消归档 / 回收站恢复」直接改写 workspace.json 的归档集合与账本槽位。
 *     宿主内存 registry 权威且不随文件改动刷新，因此这类改动需重启 dsh web
 *     后才在官方列表生效（客户端 toast 提示「重启后生效」）。
 *
 * 并发守卫：宿主 dsh web 与本模块可能同时写 workspace.json。本模块全部采用
 * 读-改-写（同步 writeFileSync），对同一文件没有跨进程锁；宿主只有收到
 * 归档/新建等显式操作时才落盘，普通浏览不写，因此实测不会与本模块冲突。
 * 物理目录移动失败时立即中止（不留下「列表已删但日志还在」的中间态）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ipcMain } from 'electron'

// 会话 id 形如 session-<uuid>；沿用 zh_pro 的收紧校验，防御路径注入。
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id)
}

/** 已归档列表项（客户端面板展示用）。 */
export interface ArchivedItem {
  sessionId: string
  title: string
  cwd: string
  createdAt: number | null
  workspaceTitle: string
  /** 是否已在回收站清单中（已删除但账本尚未同步掉）。 */
  trashed: boolean
}

/** 回收站（已删除）清单项。 */
export interface TrashItem {
  sessionId: string
  title: string
  cwd: string
  trashedAt: number
  /** 删除前是否已在归档集合（恢复时据此决定挂回归档还是工作区列表）。 */
  wasArchived: boolean
  /** 删除前挂载的工作区 id（空串表示未挂载任何工作区）。 */
  workspaceId: string
  /** 删除前记录的创建时间（毫秒）；恢复时重建 projcache 元数据用。 */
  createdAt: number | null
  /** 按 cwd 匹配到的工作区标题（面板按工作区分组回收站用）。 */
  workspaceTitle: string
}

function dshHome(): string {
  return join(homedir(), '.dsh')
}

function sessionsDir(): string {
  return join(dshHome(), 'sessions')
}

function trashRoot(): string {
  return join(homedir(), '.dsh-delete-session-trash')
}

function trashDir(): string {
  return join(trashRoot(), 'sessions')
}

function manifestFile(): string {
  return join(trashRoot(), 'manifest.json')
}

function workspaceFile(): string {
  return join(dshHome(), 'storages', 'workspace.json')
}

function projcacheFile(): string {
  return join(dshHome(), 'storages', 'session_projcache.json')
}

/** 读 JSON 文件；缺失/损坏/空文件统一返回 null。 */
function loadJson(file: string): unknown {
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (raw.trim() === '') return null
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** 写 JSON 文件（先写临时文件再原子 rename，避免宿主读到半截内容）。 */
function writeJson(file: string, data: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.dsh-tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

// ---------- workspace.json ----------

interface ParsedWorkspace {
  archivedSessionIds: string[]
  /** wsId → 原始 entry（保留未识别字段，只按需读写 sessionIds/title/path）。 */
  workspaces: Record<string, Record<string, unknown>>
  root: Record<string, unknown>
}

function loadWorkspace(): ParsedWorkspace | null {
  const raw = loadJson(workspaceFile())
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  const global = typeof root.global === 'object' && root.global !== null && !Array.isArray(root.global)
    ? root.global as Record<string, unknown>
    : {}
  const archivedSessionIds = Array.isArray(global.archivedSessionIds)
    ? (global.archivedSessionIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const tables = typeof root.tables === 'object' && root.tables !== null && !Array.isArray(root.tables)
    ? root.tables as Record<string, unknown>
    : {}
  const wsTable = typeof tables.workspaces === 'object' && tables.workspaces !== null && !Array.isArray(tables.workspaces)
    ? tables.workspaces as Record<string, unknown>
    : {}
  const workspaces: Record<string, Record<string, unknown>> = {}
  for (const key of Object.keys(wsTable)) {
    const value = wsTable[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      workspaces[key] = value as Record<string, unknown>
    }
  }
  return { archivedSessionIds, workspaces, root }
}

function saveWorkspace(data: ParsedWorkspace): boolean {
  let global = data.root.global
  if (typeof global !== 'object' || global === null || Array.isArray(global)) {
    global = {}
    data.root.global = global
  }
  const g = global as Record<string, unknown>
  g.archivedSessionIds = data.archivedSessionIds
  return writeJson(workspaceFile(), data.root)
}

function wsTitle(entry: Record<string, unknown>): string {
  return typeof entry.title === 'string' ? entry.title : ''
}

function wsPath(entry: Record<string, unknown>): string {
  return typeof entry.path === 'string' ? entry.path : ''
}

function wsSessionIds(entry: Record<string, unknown>): string[] {
  return Array.isArray(entry.sessionIds)
    ? (entry.sessionIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
}

/** cwd 是否属于某工作区（路径前缀匹配）。 */
function pathMatches(cwd: string, workspacePath: string): boolean {
  if (cwd === '' || workspacePath === '') return false
  if (cwd === workspacePath) return true
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`
  return cwd.startsWith(prefix)
}

/** 从全部工作区里找 cwd 对应的工作区标题。 */
function workspaceTitleOf(cwd: string, workspaces: Record<string, Record<string, unknown>>): string {
  for (const entry of Object.values(workspaces)) {
    if (pathMatches(cwd, wsPath(entry))) {
      const title = wsTitle(entry)
      if (title !== '') return title
    }
  }
  return ''
}

/** 从账本（各工作区 sessionIds + archivedSessionIds）移除一个会话 id。 */
function removeIdFromLedger(data: ParsedWorkspace, id: string): void {
  for (const entry of Object.values(data.workspaces)) {
    const ids = wsSessionIds(entry)
    const next = ids.filter((candidate) => candidate !== id)
    if (next.length !== ids.length) entry.sessionIds = next
  }
  data.archivedSessionIds = data.archivedSessionIds.filter((candidate) => candidate !== id)
}

/** 把会话挂回账本：从归档集合移除，并按 cwd 挂入匹配工作区（恢复/取消归档）。 */
function addIdToLedger(data: ParsedWorkspace, id: string, cwd: string): boolean {
  let changed = false
  if (cwd !== '') {
    for (const entry of Object.values(data.workspaces)) {
      if (pathMatches(cwd, wsPath(entry))) {
        const ids = wsSessionIds(entry)
        if (!ids.includes(id)) {
          entry.sessionIds = [...ids, id]
          changed = true
        }
        break
      }
    }
  }
  const nextArchived = data.archivedSessionIds.filter((candidate) => candidate !== id)
  if (nextArchived.length !== data.archivedSessionIds.length) {
    data.archivedSessionIds = nextArchived
    changed = true
  }
  return changed
}

// ---------- session_projcache.json ----------

interface ParsedProjcache {
  sessions: Record<string, Record<string, unknown>>
  root: Record<string, unknown>
}

function loadProjcache(): ParsedProjcache | null {
  const raw = loadJson(projcacheFile())
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  const tables = typeof root.tables === 'object' && root.tables !== null && !Array.isArray(root.tables)
    ? root.tables as Record<string, unknown>
    : {}
  const sTable = typeof tables.sessions === 'object' && tables.sessions !== null && !Array.isArray(tables.sessions)
    ? tables.sessions as Record<string, unknown>
    : {}
  const sessions: Record<string, Record<string, unknown>> = {}
  for (const key of Object.keys(sTable)) {
    const value = sTable[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sessions[key] = value as Record<string, unknown>
    }
  }
  return { sessions, root }
}

function pcCwd(entry: Record<string, unknown>): string {
  const identity = typeof entry.identity === 'object' && entry.identity !== null && !Array.isArray(entry.identity)
    ? entry.identity as Record<string, unknown>
    : {}
  return typeof identity.cwd === 'string' ? identity.cwd : ''
}

function pcCreatedAt(entry: Record<string, unknown>): number | null {
  const identity = typeof entry.identity === 'object' && entry.identity !== null && !Array.isArray(entry.identity)
    ? entry.identity as Record<string, unknown>
    : {}
  return typeof identity.createdAt === 'number' ? identity.createdAt : null
}

function pcTitle(entry: Record<string, unknown>): string {
  const rows = typeof entry.rows === 'object' && entry.rows !== null && !Array.isArray(entry.rows)
    ? entry.rows as Record<string, unknown>
    : {}
  const title = rows.title
  if (typeof title === 'object' && title !== null) {
    const value = (title as Record<string, unknown>).val
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

function removeFromProjcache(pc: ParsedProjcache, id: string): void {
  const tables = typeof pc.root.tables === 'object' && pc.root.tables !== null && !Array.isArray(pc.root.tables)
    ? pc.root.tables as Record<string, unknown>
    : {}
  const sTable = typeof tables.sessions === 'object' && tables.sessions !== null && !Array.isArray(tables.sessions)
    ? tables.sessions as Record<string, unknown>
    : {}
  delete sTable[id]
  delete pc.sessions[id]
  writeJson(projcacheFile(), pc.root)
}

/** 恢复时重建 projcache 元数据（标题/cwd/创建时间），让面板立即显示正确信息。 */
function restoreProjcacheEntry(id: string, title: string, cwd: string, createdAt: number | null): void {
  const pc = loadProjcache()
  if (pc === null || pc.sessions[id] !== undefined) return
  pc.sessions[id] = {
    identity: {
      ...(cwd !== '' ? { cwd } : {}),
      ...(createdAt !== null ? { createdAt } : {}),
    },
    rows: { title: { val: title } },
  }
  const tables = typeof pc.root.tables === 'object' && pc.root.tables !== null && !Array.isArray(pc.root.tables)
    ? pc.root.tables as Record<string, unknown>
    : {}
  const sTable = typeof tables.sessions === 'object' && tables.sessions !== null && !Array.isArray(tables.sessions)
    ? tables.sessions as Record<string, unknown>
    : {}
  sTable[id] = pc.sessions[id]
  writeJson(projcacheFile(), pc.root)
}

// ---------- 回收站清单 ----------

interface ManifestFile {
  items: TrashItem[]
  root: Record<string, unknown>
}

function loadManifest(): ManifestFile {
  const raw = loadJson(manifestFile())
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const root = raw as Record<string, unknown>
    const items = Array.isArray(root.items) ? root.items as unknown[] : []
    const parsed = items.filter((x): x is Record<string, unknown> => {
      if (typeof x !== 'object' || x === null) return false
      const entry = x as Record<string, unknown>
      return typeof entry.sessionId === 'string' && typeof entry.trashedAt === 'number'
    }).map((entry) => ({
      sessionId: String(entry.sessionId),
      title: typeof entry.title === 'string' ? entry.title : '',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      trashedAt: entry.trashedAt as number,
      wasArchived: entry.wasArchived === true,
      workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : '',
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
      workspaceTitle: '',
    }))
    return { items: parsed, root }
  }
  return { items: [], root: {} }
}

function saveManifest(manifest: ManifestFile): boolean {
  manifest.root.items = manifest.items
  return writeJson(manifestFile(), manifest.root)
}

// ---------- 日志目录定位 ----------

/** cwd → 会话目录的项目子目录名（--projects-- / --projects-Deepseek-Harness--）。 */
function slugOf(cwd: string): string {
  const body = cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `--${body}--`
}

/** 在 ~/.dsh/sessions/<项目>/ 下按 id 找会话目录；找不到返回 null。 */
function findSessionDir(id: string): string | null {
  try {
    const projects = readdirSync(sessionsDir(), { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(sessionsDir(), project.name, id)
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
      } catch {
        // 单目录 stat 失败不影响继续扫描
      }
    }
  } catch {
    // sessions 目录不可读时按无日志处理
  }
  return null
}

// ---------- 操作 ----------

function deleteSession(id: string): { ok: true; moved: boolean } | { ok: false; message: string } {
  // 1) 先读元数据（随后要移除 projcache 条目，标题/cwd 需提前取），并记录
  //    删除前在账本中的位置（恢复时据此决定挂回归档还是工作区列表）。
  const pc = loadProjcache()
  const meta = pc !== null ? pc.sessions[id] : undefined
  const title = meta !== undefined ? pcTitle(meta) : ''
  const cwd = meta !== undefined ? pcCwd(meta) : ''
  const createdAt = meta !== undefined ? pcCreatedAt(meta) : null
  const ws = loadWorkspace()
  let wasArchived = false
  let workspaceId = ''
  if (ws !== null) {
    wasArchived = ws.archivedSessionIds.includes(id)
    for (const [wid, entry] of Object.entries(ws.workspaces)) {
      if (wsSessionIds(entry).includes(id)) {
        workspaceId = wid
        break
      }
    }
  }

  // 2) 物理移动日志目录；失败则中止（不留中间态）。
  let moved = false
  const src = findSessionDir(id)
  if (src !== null) {
    try {
      mkdirSync(trashDir(), { recursive: true })
      renameSync(src, join(trashDir(), id))
      moved = true
    } catch (error) {
      return { ok: false, message: `移动会话日志失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // 3) 登记回收站清单（幂等，已存在则不重复）。
  try {
    const manifest = loadManifest()
    if (!manifest.items.some((item) => item.sessionId === id)) {
      manifest.items.push({ sessionId: id, title, cwd, trashedAt: Date.now(), wasArchived, workspaceId, createdAt, workspaceTitle: '' })
      saveManifest(manifest)
    }
  } catch (error) {
    console.warn(`[dsh-desktop] 会话 ${id} 回收站清单登记失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 4) 从工作区账本移除（列表/归档集合都不会再出现）。
  try {
    if (ws !== null) {
      removeIdFromLedger(ws, id)
      if (!saveWorkspace(ws)) {
        console.warn(`[dsh-desktop] 会话 ${id} 工作区账本移除写入失败`)
      }
    }
  } catch (error) {
    console.warn(`[dsh-desktop] 会话 ${id} 工作区账本移除失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 5) 从 projcache 移除元数据。
  if (pc !== null) {
    try {
      removeFromProjcache(pc, id)
    } catch (error) {
      console.warn(`[dsh-desktop] 会话 ${id} projcache 移除失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { ok: true, moved }
}

function archivedList(): { ok: true; items: ArchivedItem[] } | { ok: false; message: string } {
  const ws = loadWorkspace()
  if (ws === null) return { ok: false, message: '无法读取工作区账本' }
  const pc = loadProjcache()
  const manifest = loadManifest()
  const trashedIds = new Set(manifest.items.map((item) => item.sessionId))
  // 已删除的会话只进回收站区，不留在「已归档」列表（即使宿主内存仍把它挂在
  // 归档集合里，这里按回收站清单过滤，重启前后都稳定）。
  const items: ArchivedItem[] = ws.archivedSessionIds
    .filter((id) => !trashedIds.has(id))
    .map((id) => {
      const meta = pc !== null ? pc.sessions[id] : undefined
      const cwd = meta !== undefined ? pcCwd(meta) : ''
      return {
        sessionId: id,
        title: meta !== undefined ? pcTitle(meta) : '',
        cwd,
        createdAt: meta !== undefined ? pcCreatedAt(meta) : null,
        workspaceTitle: workspaceTitleOf(cwd, ws.workspaces),
        trashed: trashedIds.has(id),
      }
    })
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return { ok: true, items }
}

function unarchiveSession(id: string): { ok: true; changed: boolean } | { ok: false; message: string } {
  const ws = loadWorkspace()
  if (ws === null) return { ok: false, message: '无法读取工作区账本' }
  const pc = loadProjcache()
  const meta = pc !== null ? pc.sessions[id] : undefined
  const cwd = meta !== undefined ? pcCwd(meta) : ''
  const changed = addIdToLedger(ws, id, cwd)
  if (!saveWorkspace(ws)) return { ok: false, message: '写入工作区账本失败' }
  return { ok: true, changed }
}

function trashList(): { ok: true; items: TrashItem[] } | { ok: false; message: string } {
  const manifest = loadManifest()
  const ws = loadWorkspace()
  const items = [...manifest.items]
    .sort((a, b) => b.trashedAt - a.trashedAt)
    .map((item) => ({
      ...item,
      workspaceTitle: ws !== null ? workspaceTitleOf(item.cwd, ws.workspaces) : '',
    }))
  return { ok: true, items }
}

function trashRestore(id: string): { ok: true } | { ok: false; message: string } {
  const manifest = loadManifest()
  const entry = manifest.items.find((item) => item.sessionId === id)
  if (entry === undefined) return { ok: false, message: '回收站中不存在该会话' }

  // 1) 移回日志目录（按 cwd 还原项目子目录）。
  const src = join(trashDir(), id)
  if (existsSync(src)) {
    try {
      const destDir = entry.cwd === '' ? sessionsDir() : join(sessionsDir(), slugOf(entry.cwd))
      mkdirSync(destDir, { recursive: true })
      renameSync(src, join(destDir, id))
    } catch (error) {
      return { ok: false, message: `恢复会话日志失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // 2) 移出回收站清单。
  manifest.items = manifest.items.filter((item) => item.sessionId !== id)
  saveManifest(manifest)

  // 3) 重新挂回账本：删除前已归档的挂回「已归档」集合（面板可见），
  //    删除前挂载在工作区的按原工作区挂回（主列表可见）；都找不到则
  //    挂回归档集合兜底，保证恢复后不会消失。
  try {
    const ws = loadWorkspace()
    if (ws !== null) {
      if (entry.wasArchived) {
        if (!ws.archivedSessionIds.includes(id)) ws.archivedSessionIds = [...ws.archivedSessionIds, id]
        for (const w of Object.values(ws.workspaces)) {
          const ids = wsSessionIds(w)
          if (ids.includes(id)) w.sessionIds = ids.filter((candidate) => candidate !== id)
        }
      } else {
        const target = entry.workspaceId !== '' ? ws.workspaces[entry.workspaceId] : undefined
        if (target !== undefined && !wsSessionIds(target).includes(id)) {
          target.sessionIds = [...wsSessionIds(target), id]
          ws.archivedSessionIds = ws.archivedSessionIds.filter((candidate) => candidate !== id)
        } else if (target === undefined) {
          if (!ws.archivedSessionIds.includes(id)) ws.archivedSessionIds = [...ws.archivedSessionIds, id]
        } else {
          ws.archivedSessionIds = ws.archivedSessionIds.filter((candidate) => candidate !== id)
        }
      }
      if (!saveWorkspace(ws)) {
        console.warn(`[dsh-desktop] 会话 ${id} 恢复后账本写入失败`)
      }
    }
  } catch (error) {
    console.warn(`[dsh-desktop] 会话 ${id} 恢复后账本挂载失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 4) 重建 projcache 元数据（标题/工作目录/创建时间）。
  restoreProjcacheEntry(id, entry.title, entry.cwd, entry.createdAt)

  return { ok: true }
}

/** 从回收站清单中同步清理账本残留 id（宿主内存仍可能挂着，重启后生效）。 */
function purgeIdFromLedger(id: string): void {
  try {
    const ws = loadWorkspace()
    if (ws !== null) {
      removeIdFromLedger(ws, id)
      saveWorkspace(ws)
    }
  } catch {
    // 账本清理失败不影响删除结果
  }
}

/** 永久删除回收站中的单个会话（日志删除 + 移出清单 + 账本清理）。 */
function trashDelete(id: string): { ok: true; removed: boolean } | { ok: false; message: string } {
  const manifest = loadManifest()
  if (!manifest.items.some((item) => item.sessionId === id)) return { ok: false, message: '回收站中不存在该会话' }
  let removed = false
  const src = join(trashDir(), id)
  if (existsSync(src)) {
    try {
      rmSync(src, { recursive: true, force: true })
      removed = true
    } catch (error) {
      return { ok: false, message: `删除会话日志失败: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  manifest.items = manifest.items.filter((item) => item.sessionId !== id)
  saveManifest(manifest)
  purgeIdFromLedger(id)
  return { ok: true, removed }
}

/** 清空整个回收站（删除全部日志 + 清空清单 + 账本清理）。 */
function trashEmpty(): { ok: true; removed: number } | { ok: false; message: string } {
  const manifest = loadManifest()
  const ids = manifest.items.map((item) => item.sessionId)
  let removed = 0
  try {
    if (existsSync(trashDir())) {
      rmSync(trashDir(), { recursive: true, force: true })
      removed = ids.length
    }
  } catch (error) {
    return { ok: false, message: `清空回收站失败: ${error instanceof Error ? error.message : String(error)}` }
  }
  manifest.items = []
  saveManifest(manifest)
  for (const id of ids) purgeIdFromLedger(id)
  return { ok: true, removed }
}

// ---------- IPC ----------

/**
 * 注册会话管理 IPC（preload 桥经 window.dshDesktop.session 调用）。
 * 在 main.ts 的单实例分支里、app.whenReady 之前调用。
 */
export function registerSessionManageIpc(): void {
  ipcMain.handle('dsh:session-delete', (_event, id: unknown) => {
    if (!isValidSessionId(id)) return { ok: false, message: '无效的会话 id' }
    return deleteSession(id)
  })
  ipcMain.handle('dsh:session-archived-list', () => archivedList())
  ipcMain.handle('dsh:session-unarchive', (_event, id: unknown) => {
    if (!isValidSessionId(id)) return { ok: false, message: '无效的会话 id' }
    return unarchiveSession(id)
  })
  ipcMain.handle('dsh:session-trash-list', () => trashList())
  ipcMain.handle('dsh:session-trash-restore', (_event, id: unknown) => {
    if (!isValidSessionId(id)) return { ok: false, message: '无效的会话 id' }
    return trashRestore(id)
  })
  ipcMain.handle('dsh:session-trash-delete', (_event, id: unknown) => {
    if (!isValidSessionId(id)) return { ok: false, message: '无效的会话 id' }
    return trashDelete(id)
  })
  ipcMain.handle('dsh:session-trash-empty', () => trashEmpty())
}
