#!/bin/bash
# One-shot launcher for the desktop shell in dev verification mode:
# hardware GL (main.ts appendSwitch), CDP on :9222, log to /tmp/dsh-dev.log.
# usage: scripts/dsh-run.sh
cd "$(dirname "$0")/.."
exec env DSH_HOME=~/.dsh/source/current node_modules/electron/dist/electron \
  --ozone-platform=wayland --remote-debugging-port=9222 . > /tmp/dsh-dev.log 2>&1
