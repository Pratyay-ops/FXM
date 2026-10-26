#!/usr/bin/env bash
# Builds and signs the YouTube resolver module (packages/sources/src/youtube/module, version =
# YOUTUBE_MODULE_VERSION in version.ts) for the desktop and Android apps, as the owner, with the
# private key from scripts/make-signing-key.sh. Commit the sources first: only committed sources
# are signed, and the signature records the commit.
#
#   scripts/sign-module.sh --key ~/fxm-keys/fxm-update-signing-key.pem [--out <folder>]
#
# It builds the module in a separate process that never sees the key, then writes
# youtube-module-<api>.js and its .sig to apps/site/public/updates/ (or --out), which the site
# serves at /updates/. To sign a module built elsewhere from the same commit (the build job of a
# CI workflow), pass it with --from <file>; in an approval-gated CI environment, pass the PEM in
# an environment variable: --key-env FXM_UPDATE_SIGNING_KEY.
# See packages/sources/src/youtube/module/README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/run.sh" node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$here/sign-update.mjs" sign module "$@"
