#!/usr/bin/env bash
# Signs the YouTube config (packages/sources/src/youtube/youtube-config.json, version = its
# "revision") for the desktop and Android apps, as the owner, with the private key from
# scripts/make-signing-key.sh. Commit the config first: only committed sources are signed.
#
#   scripts/sign-config.sh --key ~/fxm-keys/fxm-update-signing-key.pem [--out <folder>]
#
# It first checks, in a separate process that never sees the key, that the YouTube module built
# from this checkout reads the config. Then it writes youtube-config-<schema>.json and its .sig
# to apps/site/public/updates/ (or --out), which the site serves at /updates/. In an
# approval-gated CI environment, pass the PEM in an environment variable instead:
# --key-env FXM_UPDATE_SIGNING_KEY. See packages/platform/src/updates/README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/run.sh" node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$here/sign-update.mjs" sign config "$@"
