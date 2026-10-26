# Code signing

How FXM signs what it ships, the policy a signing service asks a project to publish, and the owner's runbook for getting the Windows app signed for free: when to apply where, the texts to send, and how the release workflow uses a certificate once there is one (stage 7.6).

## Code signing policy

This section is FXM's code signing policy. The repository's README links to it under this title.

**What is signed, and with what:**

| What | Signed with | Where the key lives |
|---|---|---|
| Windows app and installers (`fxm.exe`, `fxm-desktop-<version>-windows-x64-setup.exe` and `.msi`) | Unsigned until a code signing service accepts FXM (below). Then: that service's or FXM's Authenticode certificate, with an RFC 3161 timestamp | With the service, or in the GitHub environment `windows-signing`, which only release runs on `main` can use |
| macOS app (`.dmg`, `.app.tar.gz`) | Ad hoc, not notarized: FXM joins no Apple program ([ARCHITECTURE.md §1](ARCHITECTURE.md#non-goals)) | No key |
| Desktop updates (`latest.json` and the files it names) | FXM's updater key (minisign, Ed25519); every installed app checks it ([apps/desktop/README.md](../apps/desktop/README.md#updates)) | GitHub environment `desktop-updater`, limited to `main`; an offline copy with the owner |
| Android app (APK) | FXM's APK signing key (stage 6.6) | GitHub secrets that only release runs can use; an offline copy with the owner |
| YouTube config and resolver module | FXM's Ed25519 signing key (stage 1.13) | Never in the deploy job: the owner signs locally |
| FXM Connect for Firefox | Mozilla, through Firefox Add-ons | Mozilla's |

**How releases are built.** Only `.github/workflows/release.yml` builds release files, on GitHub-hosted runners, from the merge commit on `main` that a reviewed release pull request created ([WORKFLOW.md, "Releases"](WORKFLOW.md#8-releases)). Each release lists the SHA-256 checksum of every file and a build-provenance attestation that ties each file to that workflow and commit. Every Windows file is checked after signing: signed by the expected certificate and timestamped, or, while FXM has no certificate, not signed at all. A file built anywhere else is never signed.

**Team and roles:**

| Role | Who |
|---|---|
| Owner, maintainer and committer | [Pratyay-ops](https://github.com/Pratyay-ops). Every commit comes in through the owner's account. Much of the code is written by AI coding agents (Claude Code) that the owner directs, each on a stage branch with automated reviews and `make check` before it is merged ([WORKFLOW.md](WORKFLOW.md)) |
| Reviewers | The owner, and the automated review agents of each stage |
| Approver of every signing request | The owner, and nobody else |

Everyone with write access to the repository, or access to a signing service, must use two-factor authentication.

**Privacy.** FXM has no accounts, analytics or telemetry. The apps contact only the services the [privacy policy](https://fxmusic.pages.dev/privacy) names, each for the reason it gives, and the music services can be switched off in Settings.

**Reporting.** Report a signed file that FXM didn't build, or anything else wrong with a signature, privately as the [security policy](../.github/SECURITY.md) says.

**Attribution.** Once a service signs FXM's files, its attribution goes here. For SignPath Foundation, word for word: "Free code signing provided by SignPath.io, certificate by SignPath Foundation".

## Where FXM can get Windows signing

Windows warns about unsigned installers (SmartScreen's "Run anyway"), and Smart App Control blocks unsigned apps outright, with no way to allow one app ([apps/desktop/INSTALL.md](../apps/desktop/INSTALL.md#windows)). A certificate fixes the second at once. SmartScreen's warning goes away as a signed release builds a reputation: since 2024 EV and OV certificates build it the same way, so even a signed release may meet the warning at first (Tauri's signing guide, read 2026-10-26), and keeping one certificate across releases carries the reputation over.

| Route | Cost | What it takes | When |
|---|---|---|---|
| **[SignPath Foundation](https://signpath.org/apply)** | Free | Its [terms](https://signpath.org/terms) (read 2026-10-26): an OSI license with no proprietary parts; actively maintained; **already released in the form to be signed**; functionality described on the download page; only the project's own binaries; no feature that circumvents security measures; a privacy policy for data sent to other systems; uninstallers; two-factor authentication for every team member; named authors, reviewers and approvers, with manual approval of each release; builds verifiable from source; this policy, with its attribution. SignPath holds the key, and the certificate names SignPath Foundation as publisher | Apply once a GitHub Release carries the Windows installers |
| **[OSSign](https://ossign.org/)** | Free | Its criteria (read 2026-10-26): an OSI license with all released code public; actively maintained, with a user base; at least **6 months of activity** on the account, organization and project; a verifiable build pipeline with quality checks; no political or controversial software. Signing with OSSign's certificate, from CI, through its CLI. **Applications were suspended** that day for a backlog | Not before 2027-04-25 (FXM started on 2026-10-25), and once applications reopen |
| **[Certum Open Source Code Signing](https://shop.certum.eu/open-source-code-signing-on-simplysign.html)** | €49 in the cloud (SimplySign), €69 as a card set with a reader (Certum's shop, 2026-10-26) | Identity checks for the owner as a natural person; the certificate names "Open Source Developer" and the owner's name. The card set needs the card at hand when signing, which GitHub's runners don't have, so the cloud certificate is the one for CI | The paid fallback, if both free routes decline or take too long |

Not routes for FXM:

- **The Microsoft Store** re-signs only MSIX packages, and Tauri builds MSI and NSIS installers.
- **Azure Artifact Signing** excludes individuals outside the US and Canada.
- **Apple notarization** needs Apple's developer program, which FXM doesn't join ([ARCHITECTURE.md §1](ARCHITECTURE.md#non-goals)).

### Before applying

- A release on GitHub carries `fxm-desktop-<version>-windows-x64-setup.exe` and `-windows-x64.msi` (stage 7.5's desktop release, which needs the updater key first).
- Two-factor authentication is on for the owner's GitHub account (and later the service's).
- This policy is linked from the README under "Code signing policy" (it is) and, if the service asks, from the site.
- The download page describes what the app does: the README, the [site](https://fxmusic.pages.dev/) and [INSTALL.md](../apps/desktop/INSTALL.md) do.

## The applications

The texts below are the owner's to send. They describe FXM as it is, including what a reviewer may ask about: a signing service that learns later what it signed would revoke the certificate. Replace the parts in angle brackets.

### SignPath Foundation

The form at <https://signpath.org/apply> asks about the project, its maintainers and its build. Answers for its fields:

- **Project name:** FXM (Free Cross-platform Media)
- **Repository:** https://github.com/Pratyay-ops/FXM
- **Home page:** https://fxmusic.pages.dev/
- **License:** Apache-2.0, for the whole repository. The Windows app's third-party code is open source too: Rust crates and npm packages (mostly MIT and Apache-2.0), and the NSIS and WiX installer stubs that Tauri builds the installers with.
- **Short description:** A free, open-source music player for the web, desktop and Android, with no servers, accounts or tracking.
- **Description:**

  > FXM is a free, open-source (Apache-2.0) music player for the web, Windows, macOS, Linux and Android. It searches and plays music from YouTube Music, Internet Archive, Jamendo and the user's own files, shows lyrics, builds a personal home feed on the device, and downloads tracks. Spotify's catalog supplies metadata and recommendations only, and can be switched off. FXM has no servers: the apps talk to the music services from the user's own device, and keep the library on it. The Windows app is a Tauri 2 shell around the same web app, built by GitHub Actions on GitHub-hosted runners.

- **What to sign:** the Windows x64 desktop app, built by the release workflow for each release: the application `fxm.exe`, the NSIS installer `fxm-desktop-<version>-windows-x64-setup.exe` (with its uninstaller) and the MSI `fxm-desktop-<version>-windows-x64.msi`. Product name "FXM"; the version is the release's, the same in every file.
- **Build system:** GitHub Actions, GitHub-hosted runners only: `.github/workflows/release.yml` calls `.github/workflows/desktop-release.yml`, which builds each platform with tauri-action from the release commit on `main`, with a frozen lockfile and no caches. Every release publishes SHA-256 checksums and build-provenance attestations.
- **Releases so far:** <list the releases with Windows installers, e.g. v0.x.0 on yyyy-mm-dd: https://github.com/Pratyay-ops/FXM/releases>
- **Team:** <the owner's name>, GitHub `Pratyay-ops`, owner and only maintainer: author, reviewer and approver. Code is also written by AI coding agents (Claude Code) that the maintainer directs; every change lands through reviewed stage branches and CI, and only the maintainer approves releases and signing requests. Two-factor authentication is on.
- **Code signing policy:** https://github.com/Pratyay-ops/FXM/blob/main/docs/CODE-SIGNING.md#code-signing-policy
- **Privacy policy:** https://fxmusic.pages.dev/privacy
- **Why signing:** Windows' Smart App Control blocks the unsigned app with no way to allow it, and SmartScreen warns about every unsigned installer. FXM is free and has no budget for a certificate.
- **Anything else the reviewers should know:**

  > FXM plays YouTube audio without YouTube's player, from stream URLs it resolves on the user's device, and can download any track; YouTube's terms don't allow either. By default it uses only stream URLs that YouTube's servers hand out as they are, without deciphering signatures or creating attestation tokens. Experimental, off-by-default options do decipher YouTube's signatures and create attestation tokens, as yt-dlp and NewPipe do. Spotify metadata comes from Spotify's web player API, anonymously or with the user's own login. FXM states that it is not affiliated with these services, keeps a clean-room log of where each protocol fact came from, and has a takedown process (docs/LEGAL.md). The installers make no system changes beyond installing the app, and uninstall through Windows' Apps settings.

### OSSign

Send when OSSign takes applications again and FXM has had 6 months of activity (from 2027-04-25), through the form on <https://ossign.org/>. The same facts, in the order of its criteria:

> **FXM** (https://github.com/Pratyay-ops/FXM), a free, open-source music player for the web, Windows, macOS, Linux and Android, without servers, accounts or tracking. It plays and downloads music from YouTube Music, Internet Archive, Jamendo and local files on the user's own device, and takes metadata and recommendations from Spotify (switchable).
>
> - **License:** Apache-2.0 for the whole repository; every line of the released apps is in the public repository.
> - **Maintenance and users:** active since 2026-10-25, with <releases, downloads, stars, issues by then>.
> - **Build pipeline:** GitHub Actions on GitHub-hosted runners. Every change passes `make check` (Biome lint, TypeScript, Vitest, the build) and, for the desktop app, rustfmt, clippy and cargo tests; releases are built by `.github/workflows/release.yml` from the release commit, with SHA-256 checksums and build-provenance attestations linking each file to its source.
> - **What to sign:** the Windows app `fxm.exe`, its NSIS installer (and uninstaller) and its MSI, at each release. The workflow can run your CLI from Tauri's sign command, with a GitHub OIDC token for your keyless server (`id-token: write`).
> - **Nature of the software:** a music player. Note that it plays YouTube audio without YouTube's player and can download tracks, which YouTube's terms don't allow; experimental options, off by default, decipher YouTube's signatures as yt-dlp does. It is not a security tool and has no political purpose.
> - **Maintainer:** <the owner's name>, GitHub `Pratyay-ops`.

### Certum Open Source Code Signing (paid fallback)

Not an application but an order: "Open Source Code Signing in the Cloud" at <https://shop.certum.eu/open-source-code-signing-on-simplysign.html>, for the owner as a natural person. Certum lists the documents it needs at <https://support.certum.eu/en/code-signing-required-documents/>: an identity document, and the project's public repository as the open-source project. Activation installs SimplySign on a phone, which then gives the one-time codes every signing session needs. The certificate names "Open Source Developer" and the owner's name, which Windows shows as the publisher.

## Signing in the release workflow

The Windows build of `.github/workflows/desktop-release.yml` signs through Tauri's own signing: given a certificate's thumbprint, `tauri build` runs Windows' `signtool` on `fxm.exe` before it packs it, on the NSIS uninstaller while NSIS packs it, and on the NSIS installer and the MSI, with SHA-256 digests, "FXM" as the description and an RFC 3161 timestamp (`apps/desktop/release/windows-signing.ts`). Then the job reads the signatures (`Get-AuthenticodeSignature`) of both installers and of the `fxm.exe` inside each, unpacked from them (Tauri signs a copy for each installer), and fails unless each is signed by that certificate and timestamped. The updater's signatures are made later, by the sign job, over the signed files, so the two never conflict.

| Run | Certificate | Result |
|---|---|---|
| Dry run (`desktop.yml`, `release-dry-run`) | A throwaway self-signed certificate made on the runner | Every file signed and checked; nothing trusts the certificate |
| Release, with `WINDOWS_CERTIFICATE` in the `windows-signing` environment | That certificate | Every file signed by it, checked, and trusted by Windows |
| Release without it | None | Unsigned, with a notice in the run; the check makes sure nothing is signed |

A dry run on 2026-10-26 showed it working on GitHub's Windows runner: Tauri signed `fxm.exe` (once for each installer), the NSIS plugins and uninstaller, the NSIS installer, WiX's extension libraries and the MSI with the throwaway certificate, each timestamped by Certum's server, and the check found both installers and the `fxm.exe` inside each signed by that certificate. The run before it had looked for `fxm.exe` in `target/`, where Tauri leaves the unsigned binary.

### Setting up the certificate

1. Make the environment, limited to `main`, so that only release runs can read its secrets. Adding the owner as a required reviewer also makes each release's Windows build wait for the owner's approval:

   ```sh
   scripts/run.sh gh api -X PUT repos/Pratyay-ops/FXM/environments/windows-signing \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   scripts/run.sh gh api -X POST repos/Pratyay-ops/FXM/environments/windows-signing/deployment-branch-policies \
     -f name=main -f type=branch
   ```

2. Give it the certificate: `WINDOWS_CERTIFICATE` is the PKCS #12 (`.pfx`) file in base64, `WINDOWS_CERTIFICATE_PASSWORD` its password. `release.yml` passes no secrets of these names, so only this environment can provide them.

   ```sh
   base64 -i fxm-code-signing.pfx | scripts/run.sh gh secret set WINDOWS_CERTIFICATE --env windows-signing
   scripts/run.sh gh secret set WINDOWS_CERTIFICATE_PASSWORD --env windows-signing
   ```

3. Optionally, set the repository variable `WINDOWS_TIMESTAMP_URL` to the certificate authority's RFC 3161 server; the default is Certum's, `http://time.certum.pl`.
4. Start a dry run (`scripts/run.sh gh workflow run desktop.yml --ref develop -f release-dry-run=true`), which signs with a throwaway certificate, to see the signing work before a release.

The certificate is imported into the runner's store with a key that can't be exported again, and its file is deleted at once. Code that runs later in that job, such as the build's own dependencies, could still sign files with it while the job runs: the reason for the environment's limits, and for preferring a key that never leaves hardware (Certum's SimplySign, or a service such as SignPath or OSSign) over a `.pfx` file.

### Per service

A `.pfx` file holds an exportable key, and certificate authorities issue code-signing keys only on hardware since June 2023, so `WINDOWS_CERTIFICATE` serves tests and certificates issued as files. Each service needs a few lines more, written once it accepts FXM and its own test setup can check them:

- **Certum (cloud):** a step before the build that signs in to SimplySign on the Windows runner with the account and the one-time-code seed (both secrets of `windows-signing`), so that the certificate appears in the runner's store; the rest is the thumbprint signing above. Command-line SimplySign clients exist (for example `ssign`, MIT, which signed PE files but not yet MSI on 2026-10-26); check one before relying on it. The seed works like a private key: keep it only in the environment, with the owner as required reviewer.
- **OSSign:** its CLI as Tauri's sign command (`bundle > windows > signCommand`, `ossign -t pecoff` or `-t msi` for each file), installed by its action, with `id-token: write` for its keyless server, granted to the Windows build of a release run only.
- **SignPath:** it signs artifacts that a workflow has uploaded (`signpath/github-action-submit-signing-request`, pinned to a commit, with the organization ID, project, signing policy and artifact configuration that SignPath sets up, and the API token as a secret of `windows-signing`), and waits for the owner to approve each request. Tauri can't call it while it packs, so the Windows build changes shape: build `fxm.exe` without bundles, have SignPath sign it, bundle the installers around the signed file (`tauri bundle`), then have SignPath sign the installers, before the updater signs them. The NSIS uninstaller, made while the installer is packed, stays unsigned that way.

Whichever service signs: update [INSTALL.md](../apps/desktop/INSTALL.md#windows) (the warnings users still see), the attribution above, and [apps/desktop/README.md](../apps/desktop/README.md#releases).
