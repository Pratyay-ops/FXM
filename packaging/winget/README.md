# winget

winget, the Windows Package Manager, installs apps from the manifests in [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). Each FXM release with the Windows installer gets its manifests from the channels workflow; the owner submits them with a pull request. Nothing here submits anything.

## The manifests

[`manifest.ts`](manifest.ts) writes the three files of a multi-file manifest in schema 1.12.0, the version winget-pkgs' pull request template asks for (read 2026-10-26; the singleton format is refused there):

| File | Holds |
|---|---|
| `FXM.FXM.yaml` | The version manifest: the package `FXM.FXM`, its version and default locale |
| `FXM.FXM.locale.en-US.yaml` | The listing: publisher, name, licence, links (including the privacy page), the short and long descriptions from `packaging/listing.ts` with the non-affiliation notice, tags and the release's page |
| `FXM.FXM.installer.yaml` | The release's NSIS installer, `fxm-desktop-<version>-windows-x64-setup.exe` (stage 7.5), with its SHA-256 from the release's `SHA256SUMS` and the day it was published |

The installer is the one that installs for the user's account, without administrator rights (`Scope: user`; Tauri's `currentUser` NSIS mode). winget passes it the silent switches it knows for `nullsoft` installers. `ProductCode` and `AppsAndFeaturesEntries` match what the installer writes to Windows' list of installed apps: Tauri's NSIS script keys it by the product name, `FXM`, with the publisher `FXM` (`bundle.publisher` in `tauri.conf.json`), so winget recognizes an installed FXM, including one FXM updated by itself (stage 7.5's updater, which runs the new installer), and both update paths agree on the installed version.

`FXM.FXM` is `<publisher>.<name>`; nothing in winget-pkgs used it on 2026-10-26. The tests validate the files against winget's JSON schemas for 1.12.0, copied in [`schema/`](schema/) from [microsoft/winget-cli](https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests/v1.12.0) (MIT, [`schema/LICENSE`](schema/LICENSE)).

## Each release

After a release that has the Windows installer, the channels workflow (`.github/workflows/channels.yml`, run when the Release workflow finishes on `main`) writes the manifests into the artifact `channels-vX.Y.Z`, as `winget/manifests/f/FXM/FXM/<version>/`. It first checks that FXM's release workflow attested the release's `SHA256SUMS`, which the installer's checksum comes from (`gh attestation verify`), and writes nothing when that check fails. Releases before stage 7.5 have no installer: the workflow says so and writes nothing. For a release that is already out, run it by hand (Actions → Channels → Run workflow, with the version), or write them locally: `scripts/run.sh pnpm --filter @fxm/packaging --silent channels winget <x.y.z> --sums SHA256SUMS --date <YYYY-MM-DD> --out <folder>`.

## Submitting

The owner does this, by hand, once per release. winget-pkgs accepts one manifest per pull request.

1. Download the artifact `channels-vX.Y.Z` from the workflow run and unzip it.
2. Optional checks. The workflow checked the attestation of `SHA256SUMS`; to check the installer itself, download `fxm-desktop-<version>-windows-x64-setup.exe` from the release and run, in its folder:

   ```sh
   gh attestation verify fxm-desktop-<version>-windows-x64-setup.exe --repo Pratyay-ops/FXM \
     --cert-identity https://github.com/Pratyay-ops/FXM/.github/workflows/release.yml@refs/heads/main \
     --deny-self-hosted-runners
   ```

   Its SHA-256 (`sha256sum` or `Get-FileHash`) must be `InstallerSha256` in `FXM.FXM.installer.yaml`. Then, on a Windows PC: `winget settings --enable LocalManifestFiles` (as administrator, once), then `winget validate --manifest <folder>` and `winget install --manifest <folder>` with the folder that holds the three files. Windows Sandbox keeps the test install off the PC.
3. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), copy the folder to `manifests/f/FXM/FXM/<version>/` in a new branch, commit and push.
4. Open the pull request with the repository's template filled in. The title is "New package: FXM.FXM version x.y.z" the first time, then "Update: FXM.FXM to x.y.z". Sign Microsoft's Contributor License Agreement when the bot asks (once).
5. The validation pipeline downloads the installer, scans it with antivirus engines and installs it in a clean machine. A detection blocks the pull request: if Microsoft Defender flags the unsigned installer, submit the file to Microsoft as a false positive (the validation guide links the form); once it is cleared, a moderator runs the validation again (`@wingetbot run`). When the pull request is assigned back to you, answer: after 5 days without activity the bot labels it, and 3 days later it closes it.

[Winget-Create](https://github.com/microsoft/winget-create) can do steps 3 and 4 from the folder (`wingetcreate submit <folder>`, with a GitHub token of the owner's).

**Signing.** winget's validation doesn't require a signed installer. Until stage 7.6 finds a free signing route, the installer stays unsigned, so SmartScreen may still warn when people run it from the browser.

## Sources

Read 2026-10-26, from [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs): its README, `CONTRIBUTING.md`, the pull request template, `doc/Authoring.md`, `doc/Policies.md`, `doc/Validation.md` and the 1.12.0 manifest documentation; Tauri's NSIS template (`installer.nsi` in tauri-bundler) for the uninstall key.
