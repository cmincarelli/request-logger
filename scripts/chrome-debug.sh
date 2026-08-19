#!/usr/bin/env bash
# Start a Chrome instance with the remote debugging port open for Logger to attach.
#
# By default this uses a DEDICATED user-data-dir so it won't collide with your
# everyday Chrome (Chrome refuses a second instance against the same profile).
# Set LOGGER_CHROME_PROFILE=main to reuse your normal profile instead — note
# that your everyday Chrome must be fully quit first when you do that.
#
# Self-healing: if port 9222 is already taken by a debug Chrome, this reuses
# it instead of failing. Stale SingletonLock files from a crashed/killed Chrome
# are removed before launch. A stale non-Chrome process on the port is an error.
#
# Usage:  pnpm chrome
#         LOGGER_CHROME_PROFILE=main pnpm chrome
set -euo pipefail

PORT="${CDP_PORT:-9222}"
APP="${BROWSER:-Google Chrome}"
APP_PATH="/Applications/$APP.app/Contents/MacOS/$APP"
PROFILE="$HOME/Library/Application Support/Google/Chrome/logger-debug"

if [ ! -x "$APP_PATH" ]; then
  echo "Chrome not found at $APP_PATH" >&2
  exit 1
fi

# ── Reuse a running debug Chrome if the port already answers as one ──────
if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "A debug browser is already serving on 127.0.0.1:$PORT — reusing it."
  echo "Logger will attach to http://127.0.0.1:$PORT"
  exit 0
fi

# ── If something else holds the port, fail loudly ───────────────────────
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use by a non-Chrome process:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "Free it, or set CDP_PORT to a different port." >&2
  exit 1
fi

# ── main profile mode ──────────────────────────────────────────────────
if [ "${LOGGER_CHROME_PROFILE:-dedicated}" = "main" ]; then
  echo "Starting $APP against your default profile on debug port $PORT ..."
  echo "Make sure your everyday Chrome is fully quit first."
  exec "$APP_PATH" --remote-debugging-port="$PORT"
fi

# ── dedicated profile mode ─────────────────────────────────────────────
# Clear a stale SingletonLock from a Chrome that was killed (-9) last time.
LOCK="$PROFILE/SingletonLock"
if [ -e "$LOCK" ] || [ -L "$LOCK" ]; then
  echo "Removing stale profile lock: $LOCK"
  rm -f "$LOCK"
fi

echo "Starting $APP with dedicated profile at:"
echo "  $PROFILE"
echo "Debug port: $PORT"
echo "Logger will attach to http://127.0.0.1:$PORT"
exec "$APP_PATH" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE"
