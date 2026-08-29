#!/bin/bash
# Kill every dsh-desktop electron process. pgrep -f would match this script's
# own command line, so exclude self (and the wrapping bash) by PID.
# usage: scripts/dsh-kill.sh
for p in $(pgrep -f "node_modules/electron/dist/electron"); do
  [ "$p" = "$$" ] && continue
  kill -9 "$p" 2>/dev/null
done
# Also reap orphaned dsh web servers (spawned per launch; they survive electron
# being SIGKILLed and can hold the 9333 devtools port, breaking the next start).
for p in $(pgrep -f "\.local/bin/dsh web"); do
  [ "$p" = "$$" ] && continue
  kill -9 "$p" 2>/dev/null
done
echo "killed"
