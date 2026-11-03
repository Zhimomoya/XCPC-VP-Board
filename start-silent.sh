#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PORT=8770
PREVIOUS=
for ARG in "$@"; do
    if [ "$PREVIOUS" = "--port" ]; then PORT=$ARG; fi
    PREVIOUS=$ARG
done

LOG_DIR="$SCRIPT_DIR/data/logs"
PID_FILE=${XCPC_PID_FILE:-"$SCRIPT_DIR/data/server-ubuntu-$PORT.pid"}
LOG_FILE=${XCPC_LOG_FILE:-"$LOG_DIR/server-ubuntu-$PORT.log"}
mkdir -p "$LOG_DIR"

is_scoreboard_process() {
    CHECK_PID=$1
    [ -n "$CHECK_PID" ] && kill -0 "$CHECK_PID" 2>/dev/null || return 1
    [ "$(readlink "/proc/$CHECK_PID/cwd" 2>/dev/null || true)" = "$SCRIPT_DIR" ] || return 1
    tr '\000' ' ' <"/proc/$CHECK_PID/cmdline" 2>/dev/null | grep -q '[ /]server\.py\([[:space:]]\|$\)'
}

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if is_scoreboard_process "$OLD_PID"; then
        printf '榜单服务已经在运行（PID %s，端口 %s）。\n' "$OLD_PID" "$PORT"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

nohup python3 server.py --lan "$@" >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" >"$PID_FILE"
sleep 1

if ! is_scoreboard_process "$SERVER_PID"; then
    rm -f "$PID_FILE"
    printf '榜单服务启动失败，请查看日志：%s\n' "$LOG_FILE" >&2
    exit 1
fi

printf '榜单服务已静默启动：http://127.0.0.1:%s（PID %s）\n' "$PORT" "$SERVER_PID"
printf '日志：%s\n' "$LOG_FILE"
