/**
 * dsh-desktop git status: the minimal git surface the injected file tree
 * needs to show change badges. Mirrors DSH better-sidebar's status path —
 * the system `git` binary spawned per request (no library, no state), with
 * `--porcelain=v1 -z` NUL framing so parsing never depends on locale or
 * color config, and `-C <cwd>` on the panel's working directory.
 *
 * Every failure degrades to `{ isRepo: false }` (no git binary, not a
 * repository, timeout): the file tree keeps working without badges. The
 * spawn is injectable so the porcelain parser and the command pipeline are
 * unit-testable without a real git.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

/** One parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  /** Absolute path (joined against the repo root by {@link gitStatus}). */
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control snapshot the file tree consumes. */
export interface GitStatusResult {
  isRepo: boolean
  /** Current branch name ('HEAD' when detached); absent outside a repo. */
  branch?: string
  /** Repository top level (the base for absolute entry paths). */
  root?: string
  entries: GitStatusEntry[]
}

/** Options controlling one status query; injectable for tests. */
export interface GitStatusOptions {
  /** Command timeout in milliseconds; defaults to 30 s (better-sidebar's). */
  timeoutMs?: number
  /** Spawn implementation; defaults to `node:child_process` spawn. */
  spawn?: (command: string, args: string[], opts: { stdio: Array<'ignore' | 'pipe'>; env: NodeJS.ProcessEnv }) => ChildProcess
}

/**
 * Parse porcelain v1 `-z` output into entries (rename/copy pairs collapse to
 * one row — the display path is the new path, the origin is the next NUL
 * field).
 */
export function parsePorcelainZ(output: string): Array<{ path: string; xy: string }> {
  const tokens = output.split('\0')
  const entries: Array<{ path: string; xy: string }> = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/** Run one git command; resolves with stdout, rejects with the error. */
function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  spawnImpl: NonNullable<GitStatusOptions['spawn']>,
): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawnImpl('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    // stdio is 'pipe': the streams are non-null once the child is spawned.
    const out = child.stdout
    const err = child.stderr
    out?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    err?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(stderr.trim() || `git exited with ${String(code)}`))
    })
  })
}

/** The interactive-command flag git uses to avoid filesystem conflicts. */
function defaultSpawn(command: string, args: string[], opts: { stdio: Array<'ignore' | 'pipe'>; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, { stdio: opts.stdio, env: opts.env })
}

/**
 * Working-tree status for `cwd` (untracked included), or
 * `{ isRepo: false }` when the directory is not inside a git work tree or
 * git is unavailable. Never throws: every failure degrades so the file tree
 * keeps rendering without badges.
 */
export async function gitStatus(cwd: string, options: GitStatusOptions = {}): Promise<GitStatusResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const spawnImpl = options.spawn ?? defaultSpawn
  const tryRun = async (args: string[]): Promise<string> => {
    try {
      return await runGit(cwd, args, timeoutMs, spawnImpl)
    } catch {
      throw new Error('not-a-repo')
    }
  }
  let inside: string
  try {
    inside = await tryRun(['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, entries: [] }
  }
  if (inside.trim() !== 'true') return { isRepo: false, entries: [] }
  const [branch, root, raw] = await Promise.all([
    tryRun(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD'),
    tryRun(['rev-parse', '--show-toplevel']).catch(() => cwd),
    tryRun(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ])
  const repoRoot = root.trim()
  return {
    isRepo: true,
    branch: branch.trim(),
    root: repoRoot,
    entries: parsePorcelainZ(raw).map((entry) => ({ ...entry, path: join(repoRoot, entry.path) })),
  }
}

/** One cached status query: expiry timestamp + the in-flight/final promise. */
interface GitStatusCacheEntry {
  expiresAt: number
  promise: Promise<GitStatusResult>
}

/** Module-level store (the default {@link gitStatusCached} cache). */
const gitStatusCache = new Map<string, GitStatusCacheEntry>()
/** Cached-cwd cap; the oldest entry is evicted past it. */
const GIT_STATUS_CACHE_LIMIT = 16

/** Options for {@link gitStatusCached}; all injectable for tests. */
export interface GitStatusCachedOptions extends GitStatusOptions {
  /** Cache TTL in milliseconds; defaults to 1500ms. */
  ttlMs?: number
  /** TTL clock; defaults to `Date.now`. */
  now?: () => number
  /** Cache store; defaults to the module-level map (test isolation). */
  cache?: Map<string, GitStatusCacheEntry>
}

/**
 * {@link gitStatus} behind a short TTL cache keyed by cwd, with in-flight
 * dedupe. The file panel re-queries the SAME workspace cwd on every
 * navigation/refresh, so each query used to re-run the full git pipeline
 * (4 processes over 2 serial rounds) even though nothing changed; within the
 * TTL every repeat — including concurrent ones — shares one result. Non-repo
 * outcomes are cached too, so browsing outside a repository doesn't spawn
 * either. A handful of cwds are kept (oldest evicted) so panel workspaces
 * stay hot across switches.
 */
export function gitStatusCached(cwd: string, options: GitStatusCachedOptions = {}): Promise<GitStatusResult> {
  const ttlMs = options.ttlMs ?? 1_500
  const nowFn = options.now ?? Date.now
  const store = options.cache ?? gitStatusCache
  const now = nowFn()
  const hit = store.get(cwd)
  if (hit !== undefined) {
    if (hit.expiresAt > now) return hit.promise
    store.delete(cwd)
  }
  const entry: GitStatusCacheEntry = {
    expiresAt: now + ttlMs,
    promise: gitStatus(cwd, options),
  }
  // delete-then-set refreshes the insertion order so a re-queried cwd counts
  // as recent for the eviction pass below.
  store.delete(cwd)
  store.set(cwd, entry)
  while (store.size > GIT_STATUS_CACHE_LIMIT) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  return entry.promise
}
