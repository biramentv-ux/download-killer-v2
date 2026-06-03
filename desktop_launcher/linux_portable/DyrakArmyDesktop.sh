#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 is required for DyrakArmy Desktop." >&2
  exit 1
fi
VENV_DIR="$DIR/.venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null
"$VENV_DIR/bin/python" -m pip install -r "$DIR/requirements.txt"
export DYRAKARMY_URL="${DYRAKARMY_URL:-https://dyrakarmy.online}"
exec "$VENV_DIR/bin/python" "$DIR/sounddrop_desktop.py"
