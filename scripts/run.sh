#!/usr/bin/env bash
# Runs a command inside the FXM toolchain environment (scripts/env.sh), e.g.
#
#   scripts/run.sh pnpm add -D some-package
#   scripts/run.sh uv pip list
#
# The Makefile runs every tool through this, so nothing depends on your shell setup.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/env.sh"
exec "$@"
