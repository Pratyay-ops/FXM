#!/usr/bin/env bash
# Creates the Ed25519 key pair that signs FXM's updates for the desktop and Android apps (the
# YouTube config and resolver module, stage 1.13). Run it once, as the owner:
#
#   scripts/make-signing-key.sh ~/fxm-keys
#
# It writes the private key (fxm-update-signing-key.pem, readable only by you) and the public key
# into that folder, which must be outside the repository, and refuses to overwrite a key. Then
# put the printed entry into packages/platform/src/updates/update-keys.json and commit it.
# See packages/platform/src/updates/README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
umask 077
exec "$here/run.sh" node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$here/sign-update.mjs" keygen "$@"
