import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergePlugins, pluginsCssScript, readPluginDir } from '../src/plugins.ts'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugins-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup.
    }
  }
})

describe('readPluginDir', () => {
  it('returns [] for a missing directory', () => {
    expect(readPluginDir(join(tmpdir(), 'definitely-missing-' + Date.now()))).toEqual([])
  })

  it('reads css and js files in filename order, skipping others', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'b.css'), 'b{}')
    writeFileSync(join(dir, 'a.js'), 'a()')
    writeFileSync(join(dir, 'c.css'), 'c{}')
    writeFileSync(join(dir, 'note.txt'), 'ignored')
    writeFileSync(join(dir, 'd.js'), 'd()')
    expect(readPluginDir(dir).map((f) => f.name)).toEqual(['a.js', 'b.css', 'c.css', 'd.js'])
    expect(readPluginDir(dir).find((f) => f.name === 'b.css')?.content).toBe('b{}')
  })

  it('skips unreadable files instead of throwing', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'sub.css')) // a directory named like a plugin
    writeFileSync(join(dir, 'ok.css'), 'ok{}')
    expect(readPluginDir(dir).map((f) => f.name)).toEqual(['ok.css'])
  })
})

describe('mergePlugins', () => {
  it('lets user files replace built-ins by basename', () => {
    const builtin = [
      { name: 'a.css', content: 'builtin-a' },
      { name: 'b.css', content: 'builtin-b' },
    ]
    const user = [
      { name: 'b.css', content: 'user-b' },
      { name: 'c.css', content: 'user-c' },
    ]
    expect(mergePlugins(builtin, user)).toEqual([
      { name: 'a.css', content: 'builtin-a' },
      { name: 'b.css', content: 'user-b' },
      { name: 'c.css', content: 'user-c' },
    ])
  })

  it('returns built-ins unchanged when the user dir is empty', () => {
    const builtin = [{ name: 'a.css', content: 'x' }]
    expect(mergePlugins(builtin, [])).toEqual(builtin)
  })
})

describe('pluginsCssScript', () => {
  it('mounts one style node with the concatenated css', () => {
    const script = pluginsCssScript(['a{}', 'b{}'])
    expect(script).toContain("'#dsh-dt-plugin-style'")
    expect(script).toContain(JSON.stringify('a{}\nb{}'))
    expect(script).toContain("document.createElement('style')")
  })

  it('escapes css content safely', () => {
    const script = pluginsCssScript(['a{content:"</style><script>alert(1)</script>"}'])
    expect(script).toContain(JSON.stringify('a{content:"</style><script>alert(1)</script>"}'))
  })
})
