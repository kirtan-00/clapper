#!/usr/bin/env bash
#
# Senchine AI — one-command start.
#
#   ./run.sh              start the platform on http://localhost:8000
#   ./run.sh --test       run the test suite
#   ./run.sh --reset      wipe the database and models, then start fresh
#
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
PORT="${SENCHINE_PORT:-8000}"
HOST="${SENCHINE_HOST:-0.0.0.0}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

if [[ -f .env ]]; then
  set -a; . ./.env; set +a
  info "loaded configuration from .env"
fi

if ! "$PYTHON" -c 'import fastapi, numpy, uvicorn' 2>/dev/null; then
  bold "Installing dependencies"
  "$PYTHON" -m pip install --quiet -r requirements.txt
fi

case "${1:-}" in
  --test)
    bold "Running the test suite"
    exec "$PYTHON" -m pytest
    ;;
  --reset)
    bold "Resetting local state"
    rm -f "${SENCHINE_DB:-senchine.db}"*
    rm -rf "${SENCHINE_MODEL_DIR:-models}"
    info "database and trained models removed"
    ;;
  --help|-h)
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

bold "Starting Senchine AI"
info "First run seeds 30 machines across 10 plants and trains the models"
info "(about 20 seconds). Subsequent runs load from cache."
info ""
info "  URL:   http://localhost:${PORT}"
info "  Login: engineer@senchine.ai / senchine"
info ""

exec "$PYTHON" -m uvicorn backend.app.main:app --host "$HOST" --port "$PORT"
