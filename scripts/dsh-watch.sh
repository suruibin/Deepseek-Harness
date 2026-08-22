#!/bin/bash
# Auto dev loop: watch src/ → rebuild → restart the shell.
# usage: scripts/dsh-watch.sh   (run in background, logs to /tmp/dsh-watch.log)
# Any .ts change under src/ triggers: build → kill → relaunch (GL + CDP).
cd "$(dirname "$0")/.."
echo "watch started $(date +%H:%M:%S)"
while true; do
  npm run build 2>&1 | tail -1
  ./scripts/dsh-kill.sh
  (cd "$(dirname "$0")/.." && DSH_HOME=~/.dsh/source/current node_modules/electron/dist/electron \
    --ozone-platform=wayland --remote-debugging-port=9222 . > /tmp/dsh-dev.log 2>&1 &)
  sleep 1
  echo "restarted $(date +%H:%M:%S)"
  inotifywait -q -e close_write,moved_to --include '.*\.ts$' -r src/ 2>/dev/null \
    || (sleep 5 && continue)   # inotifywait absent → slow-poll fallback
done
