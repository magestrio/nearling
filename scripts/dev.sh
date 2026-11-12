#!/usr/bin/env bash
# Start the testnet Worker and client against local D1 databases.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f server/.dev.vars ]; then
  echo "Missing server/.dev.vars. Copy server/.dev.vars.example and fill its dev values locally." >&2
  exit 1
fi
if [ ! -x server/node_modules/.bin/wrangler ] || [ ! -x web/node_modules/.bin/vite ]; then
  echo "Install dependencies with npm ci in server/ and web/ first." >&2
  exit 1
fi

(cd server && ./node_modules/.bin/wrangler d1 migrations apply nearling-db-dev --env dev --local)
(cd server && ./node_modules/.bin/wrangler d1 migrations apply nearling-events-dev --env dev --local)
npm --prefix web run build

worker_pid=""
web_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; fi
  if [ -n "$worker_pid" ]; then kill "$worker_pid" 2>/dev/null || true; fi
  if [ -n "$web_pid" ]; then wait "$web_pid" 2>/dev/null || true; fi
  if [ -n "$worker_pid" ]; then wait "$worker_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(cd server && exec ./node_modules/.bin/wrangler dev --env dev) &
worker_pid=$!
(cd web && exec ./node_modules/.bin/vite --mode dev) &
web_pid=$!

echo "Worker: http://localhost:8787 · Client: http://localhost:5173"
while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done
echo "A dev server stopped; stopping the other server." >&2
exit 1
