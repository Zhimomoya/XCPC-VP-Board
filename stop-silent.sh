#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT=${1:-8770}
PID_FILE=${XCPC_PID_FILE:-"$SCRIPT_DIR/data/server-ubuntu-$PORT.pid"}

if [ ! -f "$PID_FILE" ]; then
    printf '没有找到端口 %s 的静默服务记录。\n' "$PORT"
    exit 0
fi

SERVER_PID=$(cat "$PID_FILE" 2>/dev/null || true)
IS_SCOREBOARD=false
if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null && \
   [ "$(readlink "/proc/$SERVER_PID/cwd" 2>/dev/null || true)" = "$SCRIPT_DIR" ] && \
   tr '\000' ' ' <"/proc/$SERVER_PID/cmdline" 2>/dev/null | grep -q '[ /]server\.py\([[:space:]]\|$\)'; then
    IS_SCOREBOARD=true
    kill "$SERVER_PID"
    WAIT_COUNT=0
    while kill -0 "$SERVER_PID" 2>/dev/null && [ "$WAIT_COUNT" -lt 50 ]; do
        sleep 0.1
        WAIT_COUNT=$((WAIT_COUNT + 1))
    done
fi
rm -f "$PID_FILE"
if [ "$IS_SCOREBOARD" = true ]; then
    printf '端口 %s 的榜单服务已停止。\n' "$PORT"
elif [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '已移除陈旧的服务 PID 记录；PID %s 属于其他进程。\n' "$SERVER_PID"
fi
