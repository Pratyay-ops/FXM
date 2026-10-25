#!/usr/bin/env bash
# First-time setup: checks prerequisites, installs the pinned pnpm into
# .tools/bin and installs JavaScript dependencies. Safe to re-run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"

fxm_require_prereqs
"$here/install-pnpm.sh"
pnpm install
fxm_info "FXM is set up. Run 'make help' to see what you can do next."
