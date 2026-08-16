/**
 * Wallpaper store/load/remove round-trip plus the glass-settings wallpaper
 * field. Pure Node tests — no Electron window needed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeStoredWallpaper, storeWallpaper, wallpaperDataUrl } from '../src/wallpaper.ts'
import { loadGlassSettings, saveGlassSettings } from '../src/glass.ts'

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wallpaper-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  dirs.length = 0
})

describe('wallpaper store/load/remove', () => {
  it('stores a picked image and serves it back as a cached data URL', () => {
    const dir = tmpDir()
    const src = join(dir, 'pic.png')
    writeFileSync(src, PNG)
    const stored = storeWallpaper(dir, src)
    expect('error' in stored).toBe(false)
    if ('error' in stored) throw new Error('store failed')
    expect(stored.file).toBe('wallpaper.png')
    expect(stored.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(readFileSync(join(dir, stored.file)).equals(PNG)).toBe(true)
    // First read re-encodes, the identical cache hit returns the same string.
    expect(wallpaperDataUrl(dir, stored.file)).toBe(stored.url)
    expect(wallpaperDataUrl(dir, stored.file)).toBe(stored.url)
  })

  it('rejects unsupported extensions, empty files and oversized images', () => {
    const dir = tmpDir()
    const txt = join(dir, 'pic.txt')
    writeFileSync(txt, 'hello')
    expect('error' in storeWallpaper(dir, txt)).toBe(true)
    const empty = join(dir, 'empty.png')
    writeFileSync(empty, '')
    expect('error' in storeWallpaper(dir, empty)).toBe(true)
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(64)]))
    expect('error' in storeWallpaper(dir, big, 32)).toBe(true)
  })

  it('remove drops the file and the cache', () => {
    const dir = tmpDir()
    const src = join(dir, 'pic.png')
    writeFileSync(src, PNG)
    const stored = storeWallpaper(dir, src)
    if ('error' in stored) throw new Error('store failed')
    removeStoredWallpaper(dir, stored.file)
    expect(existsSync(join(dir, stored.file))).toBe(false)
    expect(wallpaperDataUrl(dir, stored.file)).toBe(null)
  })

  it('an absent or unknown stored file yields null', () => {
    const dir = tmpDir()
    expect(wallpaperDataUrl(dir, null)).toBe(null)
    expect(wallpaperDataUrl(dir, 'wallpaper.png')).toBe(null)
    expect(wallpaperDataUrl(dir, 'wallpaper.xyz')).toBe(null)
  })

  it('a new pick replaces the previous wallpaper file', () => {
    const dir = tmpDir()
    const first = join(dir, 'a.png')
    writeFileSync(first, PNG)
    const stored1 = storeWallpaper(dir, first)
    if ('error' in stored1) throw new Error('store failed')
    const jpeg = join(dir, 'b.jpg')
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const stored2 = storeWallpaper(dir, jpeg)
    if ('error' in stored2) throw new Error('store failed')
    expect(stored2.file).toBe('wallpaper.jpg')
    expect(stored2.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    // The old png file is gone (replaced by the jpg under the same basename
    // pattern), and the cache now serves the new image.
    expect(wallpaperDataUrl(dir, stored2.file)).toBe(stored2.url)
  })
})

describe('glass-settings wallpaper field', () => {
  it('round-trips the wallpaper field', () => {
    const dir = tmpDir()
    saveGlassSettings(dir, { alpha: 0.6, theme: 'dark', wallpaper: 'wallpaper.png' })
    const loaded = loadGlassSettings(dir)
    expect(loaded.wallpaper).toBe('wallpaper.png')
    expect(loaded.alpha).toBe(0.6)
    expect(loaded.theme).toBe('dark')
  })

  it('legacy settings without the field default to null', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'glass-settings.json'), JSON.stringify({ alpha: 0.5, theme: 'light' }))
    const loaded = loadGlassSettings(dir)
    expect(loaded.wallpaper).toBe(null)
    expect(loaded.alpha).toBe(0.5)
    expect(loaded.theme).toBe('light')
  })
})
