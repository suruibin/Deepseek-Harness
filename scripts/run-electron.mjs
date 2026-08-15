/** Launch the desktop shell without inheriting Electron's Node-compat mode. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const electronPath = require_('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// Native Wayland when available: the X server niri exposes (xwayland-satellite)
// has no ARGB visual, so a transparent window falls back to opaque there and
// the frosted glass is lost. The ozone platform must be chosen at process
// start (an appendSwitch in main.js is too late), so the launcher passes the
// platform argument before spawning Electron. (ELECTRON_OZONE_PLATFORM_HINT
// is not honored by this Electron build.)
const args = []
if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== '') {
  args.push('--ozone-platform=wayland')
}

const result = spawnSync(electronPath, [...args, '.'], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) {
  process.kill(process.pid, result.signal)
} else {
  process.exitCode = result.status ?? 1
}
