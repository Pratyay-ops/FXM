#!/usr/bin/env bash
# Installs uv and creates this checkout's .venv with the Python pinned in
# .python-version. Python itself is downloaded into .tools/uv/python.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

"$here/install-uv.sh"
(cd "$FXM_ROOT" && uv venv --allow-existing .venv)
fxm_info "Python venv ready: $FXM_ROOT/.venv (activate with 'source .venv/bin/activate' or use 'uv run')"
