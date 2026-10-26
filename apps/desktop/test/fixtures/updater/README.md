# Updater test fixtures

A minisign key pair made for tests only, with a signature, so that both checks of a release's
signatures can run offline and agree on the same bytes:

- `release/minisign.test.ts` checks them with `release/minisign.ts`, the code the release
  workflow signs with;
- `src-tauri/src/updater.rs` checks them with minisign-verify, the crate tauri-plugin-updater
  checks every download with, and reads the version from the trusted comment as the plugin does
  (`requireSignedVersion`).

| File | What it is |
|---|---|
| `test-key.pub` | The public key, as `tauri signer generate` wrote it: a minisign `.pub` file in base64 |
| `data.txt` | The signed bytes |
| `data.txt.sig` | Their signature, as `release/minisign.ts` makes it for a release: version `1.2.3` in the trusted comment |

The key pair was made on 2026-10-26 with `tauri signer generate` (Tauri CLI 2.12.2) in a temporary
folder, and `data.txt` signed with `release/minisign.ts`. The secret key was then deleted: nothing
can sign with this key, and nothing but these tests trusts it. The tests in `release/` make fresh
pairs of their own in temporary folders.
