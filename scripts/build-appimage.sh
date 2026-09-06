#!/bin/bash
# Build the Linux AppImage: tsc compile → electron-builder AppImage.
# Bypasses `pnpm run` (verify-deps-before-run triggers a failing install);
# calls tsc / electron-builder directly from node_modules.
# usage: scripts/build-appimage.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/3] tsc compile"
node node_modules/typescript/bin/tsc -p tsconfig.json

# Injected scripts are assembled into ONE executeJavaScript — a syntax error
# in any of them kills the whole batch. Cheap guard before packaging.
echo "[2/3] syntax-check injected scripts"
node -e '
// Injection scripts only — not lib/main.js etc., which import electron.
const mods = ["glass", "wallpaper-scripts", "misc-scripts", "terminal-scripts", "session-manage-client"];
let n = 0;
for (const name of mods) {
  const m = require("./lib/" + name + ".js");
  for (const k of Object.keys(m)) {
    if (typeof m[k] !== "function") continue;
    const src = m[k].length === 0 ? m[k]() : "";
    if (typeof src === "string" && /document\./.test(src)) { new Function(src); n++; }
  }
}
console.log("  " + n + " injected scripts OK");
'

# electron-builder needs the dist runtime; restore it if a pnpm install ate it.
if [ ! -x node_modules/electron/dist/electron ]; then
  echo "    electron/dist missing → node install.js"
  (cd node_modules/electron && node install.js)
fi

echo "[3/3] electron-builder AppImage"
node node_modules/electron-builder/cli.js --config electron-builder.yml --linux AppImage

ls -lh release/DeepSeek.AppImage
