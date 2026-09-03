#!/usr/bin/env bash
# Start a Chrome/Chromium instance with the remote debugging port open for
# Logger to attach.
#
# Works on macOS and Linux. The browser binary and profile path are resolved
# per platform:
#
#   macOS  — /Applications/$APP.app/Contents/MacOS/$APP
#            $HOME/Library/Application Support/Google/Chrome/logger-debug
#   Linux  — resolved from PATH (google-chrome-stable, google-chrome,
#            chromium, chromium-browser) unless BROWSER is an absolute path
#            $HOME/.config/google-chrome/logger-debug  (or chromium variant)
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
#         BROWSER=chromium pnpm chrome      # Linux: pick a binary from PATH
#         BROWSER=/usr/bin/chromium pnpm chrome
set -euo pipefail

PORT="${CDP_PORT:-9222}"

# ── Resolve platform-specific browser binary and profile dir ────────────
case "$(uname -s)" in
  Darwin)
    APP="${BROWSER:-Google Chrome}"
    APP_PATH="/Applications/$APP.app/Contents/MacOS/$APP"
    PROFILE_BASE="$HOME/Library/Application Support/Google/Chrome"
    ;;
  Linux)
    # If BROWSER is an absolute path, use it verbatim. Otherwise search PATH
    # for a known candidate, preferring the one named by BROWSER if set.
    if [ -n "${BROWSER:-}" ] && [[ "$BROWSER" == /* ]]; then
      APP_PATH="$BROWSER"
      APP="$(basename "$APP_PATH")"
    else
      CANDIDATES=(google-chrome-stable google-chrome chromium chromium-browser)
      if [ -n "${BROWSER:-}" ]; then
        CANDIDATES=("$BROWSER" "${CANDIDATES[@]}")
      fi
      APP_PATH=""
      for c in "${CANDIDATES[@]}"; do
        if command -v "$c" >/dev/null 2>&1; then
          APP_PATH="$(command -v "$c")"
          APP="$c"
          break
        fi
      done
      if [ -z "$APP_PATH" ]; then
        echo "Could not find a Chrome/Chromium binary on PATH." >&2
        echo "Tried: ${CANDIDATES[*]}" >&2
        echo "Set BROWSER to an absolute path, e.g. BROWSER=/usr/bin/chromium" >&2
        exit 1
      fi
    fi
    # Chromium uses ~/.config/chromium; google-chrome uses ~/.config/google-chrome.
    case "$APP" in
      chromium|chromium-browser) PROFILE_BASE="$HOME/.config/chromium" ;;
      *) PROFILE_BASE="$HOME/.config/google-chrome" ;;
    esac
    ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

PROFILE="$PROFILE_BASE/logger-debug"

if [ ! -x "$APP_PATH" ]; then
  echo "Browser not found or not executable at $APP_PATH" >&2
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
