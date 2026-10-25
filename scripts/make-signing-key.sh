#!/usr/bin/env bash
# Creates the Ed25519 key pairs that sign FXM's updates for the desktop and Android apps (the
# YouTube config and resolver module, stage 1.13). Run it once, as the owner:
#
#   scripts/make-signing-key.sh ~/fxm-keys
#
# It writes two pairs into that folder, which must be outside the repository, and refuses to
# overwrite a key: the signing key (fxm-update-signing-key.pem) and a backup key
# (fxm-update-backup-key.pem) to keep offline, for the day the signing key leaks or is lost.
# Private keys are readable only by you. Then put the two printed entries into
# packages/platform/src/updates/update-keys.json and commit it.
# See packages/platform/src/updates/README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
umask 077
exec "$here/run.sh" node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$here/sign-update.mjs" keygen "$@"
