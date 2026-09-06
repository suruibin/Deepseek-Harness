// electron-builder afterPack hook: trim Electron locale packs to the
// languages the UI actually uses (en-US / zh-CN / zh-TW). The stock
// runtime ships ~120 locales (46MB unpacked) that would otherwise bloat
// the AppImage for ~10MB of compressed space.
const path = require('node:path')
const { readdirSync, rmSync } = require('node:fs')

module.exports = async function afterPack(context) {
  const locales = path.join(context.appOutDir, 'locales')
  const keep = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'])
  let removed = 0
  for (const f of readdirSync(locales)) {
    if (f.endsWith('.pak') && !keep.has(f)) {
      rmSync(path.join(locales, f))
      removed++
    }
  }
  console.log(`afterPack: trimmed ${removed} locale packs (kept en-US/zh-CN/zh-TW)`)
}
