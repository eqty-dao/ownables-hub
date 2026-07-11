#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cleanup() {
  if [[ -n "${TS_WATCH_PID:-}" ]]; then
    kill "$TS_WATCH_PID" 2>/dev/null || true
  fi
  if [[ -n "${NODE_WATCH_PID:-}" ]]; then
    kill "$NODE_WATCH_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

yarn build >/dev/null

yarn tsc -p tsconfig.build.json --watch --preserveWatchOutput &
TS_WATCH_PID=$!

while [[ ! -f dist/main.js ]]; do
  sleep 1
done

NODE_ARGS=(--watch --preserve-symlinks)
if [[ -f .env ]]; then
  NODE_ARGS+=(--env-file=.env)
fi
if [[ -n "${NODE_INSPECT:-}" ]]; then
  NODE_ARGS+=("${NODE_INSPECT}")
fi
NODE_ARGS+=(dist/main.js)

node "${NODE_ARGS[@]}" &
NODE_WATCH_PID=$!

wait "$NODE_WATCH_PID"
