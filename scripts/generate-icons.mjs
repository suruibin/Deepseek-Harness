/**
 * Rasterize the Web GUI favicon into the desktop icons: `build/icon.png`
 * (256px, DeepSeek brand blue) and `build/tray-icon.png` (32px, DeepSeek
 * brand blue). Runs under plain Node with `@resvg/resvg-js`; run once with
 * `npm run icons` and commit the outputs — electron-builder and the tray need
 * static files.
 *
 * The favicon source defaults to the Web GUI checkout path
 * (`../web/public/favicon.svg`); set `DSH_FAVICON` to point at an installed
 * copy, e.g. the packaged frontend's `dist/favicon.svg`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const faviconPath = process.env.DSH_FAVICON ?? join(packageDir, '..', 'web', 'public', 'favicon.svg')

// DeepSeek brand blue (--dsw-static-deepseek-500: rgb(65, 118, 230)).
const DEEPSEEK_BLUE = '#4176e6'

const ICONS = [
  { file: 'icon.png', size: 256, fill: DEEPSEEK_BLUE },
  { file: 'tray-icon.png', size: 32, fill: DEEPSEEK_BLUE },
]

const source = await readFile(faviconPath, 'utf8')
await mkdir(join(packageDir, 'build'), { recursive: true })
for (const icon of ICONS) {
  // The favicon path is painted `fill="#000"` with a prefers-color-scheme
  // rule that would turn it white under dark mode; drop that rule and pin the
  // fill so every output is exactly the requested color. The root `fill="none"`
  // (the viewBox container) is untouched.
  const stripped = source.replace(/<style>[\s\S]*?<\/style>/, '')
  const svg = stripped.replaceAll('fill="#000"', `fill="${icon.fill}"`)
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: icon.size } }).render().asPng()
  await writeFile(join(packageDir, 'build', icon.file), png)
  console.log(`generated ${icon.file} (${png.length} bytes, fill ${icon.fill})`)
}
