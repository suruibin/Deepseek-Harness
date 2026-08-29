#!/bin/bash
# Backup a project to /projects/Backup/<project>/<date>/<time>/ per
# ~/.claude/skills/backup/SKILL.md. Runs from the dsh-desktop main process.
#
# usage: backup-project.sh <source-dir> [all] [remark...]
set -u

SRC="$1"; shift || true
MODE="default"
if [ "${1:-}" = "all" ]; then MODE="all"; shift || true; fi
NOTE="$*"

PROJ=$(basename "$SRC")
[ -n "$PROJ" ] || { echo "ERROR: empty project name"; exit 1; }
[ -d "$SRC" ] || { echo "ERROR: no such directory: $SRC"; exit 1; }

BACKUP_ROOT="/projects/Backup"
DEST="$BACKUP_ROOT/$PROJ/$(date +%Y%m%d)/$(date +%H_%M_%S)"
MARK="$BACKUP_ROOT/$PROJ/.last-backup"
mkdir -p "$DEST"

# DMS plugin projects: the source dir IS the plugin dir.
EXCLUDES=(--exclude='node_modules/' --exclude='.git/')
FIND_EXCLUDES=(! -path '*/node_modules/*' ! -path '*/.git/*')
if echo "$SRC" | grep -q 'DankMaterialShell/plugins/'; then
  cp -a "$SRC"/. "$DEST"/ 2>/dev/null
else
  if [ -f "$SRC/pubspec.yaml" ]; then
    EXCLUDES=(--exclude='build/' --exclude='.dart_tool/' --exclude='.pub-cache/' --exclude='.venv/' --exclude='.idea/' --exclude='*.iml' --exclude='*.log' --exclude='.metadata' --exclude='.flutter-plugins-dependencies' --exclude='.opencode/')
  elif [ -f "$SRC/package.json" ]; then
    # Node/TS/Electron: 跳过编译产物(lib/dist)与打包产物(release)，仅备份源码/配置/资源。
    EXCLUDES=(--exclude='node_modules/' --exclude='.git/' --exclude='release/' --exclude='dist/' --exclude='lib/' --exclude='.backup/' --exclude='*.log')
    FIND_EXCLUDES=(! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/release/*' ! -path '*/dist/*' ! -path '*/lib/*' ! -path '*/.backup/*')
  fi
  # Incremental default: only files newer than the last backup marker; `all`
  # (or a missing marker) copies everything. 编译/打包产物恒被排除。
  if [ "$MODE" = "all" ] || [ ! -f "$MARK" ]; then
    rsync -a "${EXCLUDES[@]}" "$SRC"/ "$DEST"/ 2>/dev/null
  else
    mapfile -t FILES < <(find "$SRC" -newer "$MARK" -type f "${FIND_EXCLUDES[@]}" 2>/dev/null | sed "s|^$SRC/||")
    if [ "${#FILES[@]}" -gt 0 ]; then
      rsync -a "${EXCLUDES[@]}" "${FILES[@]/#/$SRC/}" "$DEST"/ 2>/dev/null || true
    fi
  fi
fi

# 修改记录.txt
RECORD="$DEST/修改记录.txt"
{
  if [ -n "$NOTE" ]; then printf '%s\n\n' "$NOTE"; fi
  printf '%s\n' '--- 本次改动 ---'
  printf '%s\n' '其他修改:'
  if [ "$MODE" = "all" ] || [ ! -f "$MARK" ]; then
    find "$SRC" -type f "${FIND_EXCLUDES[@]}" 2>/dev/null | sed "s|^$SRC/||" | head -200
  else
    find "$SRC" -newer "$MARK" -type f "${FIND_EXCLUDES[@]}" 2>/dev/null | sed "s|^$SRC/||" | head -200
  fi
} > "$RECORD" 2>/dev/null

touch "$MARK"
echo "OK $DEST"
