/**
 * dsh-desktop wallpaper: a background image the user picks in the settings
 * page. The image is copied under userData (so it survives restarts) and
 * served to the hosted page as a data URL — the page's http origin cannot
 * load file:// paths, and the shell must not register a custom protocol.
 *
 * Pure Node logic with no Electron imports (the system file dialog lives in
 * main.ts), so the store/load/remove round-trip is unit-testable without a
 * window. The data URL is cached per file: the layer script re-reads it on
 * every page load, and re-encoding a multi-MiB image per injection is the
 * kind of work a cache should eliminate.
 */

import { copyFileSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Allowed image extensions → the data URL mime type. */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

/** Default size cap for a picked wallpaper (12 MiB). */
export const DEFAULT_MAX_BYTES = 12 * 1024 * 1024

/** The fixed on-disk name; a new pick overwrites the previous wallpaper. */
function storedName(ext: string): string {
  return 'wallpaper' + ext
}

let cache: { file: string; url: string } | null = null

/** The data URL for a stored wallpaper file; null when absent or unreadable. */
export function wallpaperDataUrl(userData: string, file: string | null): string | null {
  if (file === null) {
    cache = null
    return null
  }
  if (cache !== null && cache.file === file) return cache.url
  const mime = MIME[extname(file).toLowerCase()]
  if (mime === undefined) return null
  try {
    const url = `data:${mime};base64,${readFileSync(join(userData, file)).toString('base64')}`
    cache = { file, url }
    return url
  } catch {
    return null
  }
}

/**
 * Copy a picked image into userData and return its data URL. Rejects
 * unsupported extensions, empty files and files over the size cap — a
 * multi-hundred-MiB image must not end up as a base64 string shuttled to the
 * renderer. Best-effort on the copy: a failure resolves as `{ error }`.
 */
export function storeWallpaper(
  userData: string,
  srcPath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): { file: string; url: string } | { error: string } {
  const ext = extname(srcPath).toLowerCase()
  const mime = MIME[ext]
  if (mime === undefined) return { error: `unsupported image type: ${ext === '' ? '(none)' : ext}` }
  let size: number
  try {
    size = statSync(srcPath).size
  } catch {
    return { error: 'cannot read image file' }
  }
  if (size <= 0) return { error: 'image file is empty' }
  if (size > maxBytes) {
    const miB = 1024 * 1024
    return { error: `image too large (${Math.round(size / miB)} MiB, limit ${Math.round(maxBytes / miB)} MiB)` }
  }
  const file = storedName(ext)
  try {
    copyFileSync(srcPath, join(userData, file))
  } catch {
    return { error: 'failed to store wallpaper' }
  }
  // The on-disk file changed under the SAME name, so the cached data URL for
  // it is now stale — drop it, or the next apply of a same-extension image
  // would return the previous wallpaper's bytes (double-click "doesn't
  // switch"). wallpaperDataUrl re-encodes on the next call.
  cache = null
  const url = wallpaperDataUrl(userData, file)
  if (url === null) return { error: 'failed to encode wallpaper' }
  return { file, url }
}

/** Remove the stored wallpaper file and drop the cache (best-effort). */
export function removeStoredWallpaper(userData: string, file: string | null): void {
  cache = null
  if (file === null || file === '') return
  try {
    unlinkSync(join(userData, file))
  } catch {
    // Already gone; nothing left to clean.
  }
}
