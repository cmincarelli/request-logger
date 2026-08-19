#!/usr/bin/env bash
# Start a Chrome instance with the remote debugging port open for Logger to attach.
#
# By default this uses a DEDICATED user-data-dir so it won't collide with your
# everyday Chrome (Chrome refuses a second instance against the same profile).
# Set LOGGER_CHROME_PROFILE=main to reuse your normal profile instead — note
# that your everyday Chrome must be fully quit first when you do that.
#
# Usage:  pnpm chrome          # dedicated profile
#         LOGGER_CHROME_PROFILE=main pnpm chrome
set -euo pipefail

PORT="${CDP_PORT:-9222}"
APP="${BROWSER:-Google Chrome}"
APP_PATH="/Applications/$APP.app/Contents/MacOS/$APP"

if [ ! -x "$APP_PATH" ]; then
  echo "Chrome not found at $APP_PATH" >&2
  exit 1
fi

if [ "${LOGGER_CHROME_PROFILE:-dedicated}" = "main" ]; then
  echo "Starting $APP against your default profile on debug port $PORT ..."
  echo "Make sure Chrome is fully quit first."
  exec "$APP_PATH" --remote-debugging-port="$PORT"
fi

PROFILE="$HOME/Library/Application Support/Google/Chrome/logger-debug"
echo "Starting $APP with dedicated profile at:"
echo "  $PROFILE"
echo "Debug port: $PORT"
echo "Logger will attach to http://127.0.0.1:$PORT"
exec "$APP_PATH" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE"
