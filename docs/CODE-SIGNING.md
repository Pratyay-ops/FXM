# Code signing

How FXM signs what it ships, the policy a signing service asks a project to publish, and the owner's runbook for getting the Windows app signed for free: when to apply where, the texts to send, and how the release workflow uses a certificate once there is one (stage 7.6).

## Code signing policy

This section is FXM's code signing policy. The repository's README links to it under this title.

**What is signed, and with what:**

| What | Signed with | Where the key lives |
|---|---|---|
| Windows app and installers (`fxm.exe`, the NSIS plugins, `fxm-desktop-<version>-windows-x64-setup.exe` and `.msi`) | Unsigned until a code signing service accepts FXM (below). Then: that service's or FXM's Authenticode certificate, with an RFC 3161 timestamp. The NSIS installer's uninstaller stays unsigned (below) | With the service, or in the GitHub environment `windows-signing`, which only release runs on `main` can use, and only the two jobs that sign, which run none of the build's code |
| macOS app (`.dmg`, `.app.tar.gz`) | Ad hoc, not notarized: FXM joins no Apple program ([ARCHITECTURE.md §1](ARCHITECTURE.md#non-goals)) | No key |
| Desktop updates (`latest.json` and the files it names) | FXM's updater key (minisign, Ed25519); every installed app checks it ([apps/desktop/README.md](../apps/desktop/README.md#updates)) | GitHub environment `desktop-updater`, limited to `main`; an offline copy with the owner |
| Android app (APK) | FXM's APK signing key (stage 6.6) | GitHub secrets that only release runs can use; an offline copy with the owner |
| YouTube config and resolver module | FXM's Ed25519 signing key (stage 1.13) | Never in the deploy job: the owner signs locally |
| FXM Connect for Firefox | Mozilla, through Firefox Add-ons | Mozilla's |

**How releases are built.** Only `.github/workflows/release.yml` builds release files, on GitHub-hosted runners, from the merge commit on `main` that a reviewed release pull request created ([WORKFLOW.md, "Releases"](WORKFLOW.md#8-releases)). Each release lists the SHA-256 checksum of every file and a build-provenance attestation that ties each file to that workflow and commit. The jobs that build run the code of hundreds of third-party packages, so they never get a signing key: the Windows files are signed in jobs of their own, which install and build nothing. Every Windows file is checked after signing: signed by the expected certificate and timestamped, or, while FXM has no certificate, not signed at all. A file built anywhere else is never signed.

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

- **What to sign:** the Windows x64 desktop app, built by the release workflow for each release, in two requests: first the application `fxm.exe` (two copies, which differ only in the installer type the bundler writes into each) and, if the policy allows third-party open-source files, the five NSIS plugins the installer carries (NSIS's own and Tauri's `nsis_tauri_utils.dll`, unchanged), then the NSIS installer `fxm-desktop-<version>-windows-x64-setup.exe` and the MSI `fxm-desktop-<version>-windows-x64.msi`, built around the signed files. Product name "FXM"; the version is the release's, the same in every file.
- **Build system:** GitHub Actions, GitHub-hosted runners only: `.github/workflows/release.yml` calls `.github/workflows/desktop-release.yml`, which builds each platform with tauri-action from the release commit on `main`, with a frozen lockfile and no caches. The Windows files go to signing from jobs of their own, which build nothing, and are checked after it. Every release publishes SHA-256 checksums and build-provenance attestations.
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
> - **What to sign:** the Windows app `fxm.exe`, the NSIS plugins its installer carries, its NSIS installer and its MSI, at each release. The workflow runs your CLI in two signing jobs that build nothing, the only ones granted a GitHub OIDC token for your keyless server (`id-token: write`).
> - **Nature of the software:** a music player. Note that it plays YouTube audio without YouTube's player and can download tracks, which YouTube's terms don't allow; experimental options, off by default, decipher YouTube's signatures as yt-dlp does. It is not a security tool and has no political purpose.
> - **Maintainer:** <the owner's name>, GitHub `Pratyay-ops`.

### Certum Open Source Code Signing (paid fallback)

Not an application but an order: "Open Source Code Signing in the Cloud" at <https://shop.certum.eu/open-source-code-signing-on-simplysign.html>, for the owner as a natural person. Certum lists the documents it needs at <https://support.certum.eu/en/code-signing-required-documents/>: an identity document, and the project's public repository as the open-source project. Activation installs SimplySign on a phone, which then gives the one-time codes every signing session needs. The certificate names "Open Source Developer" and the owner's name, which Windows shows as the publisher.

## Signing in the release workflow

A certificate's key must never meet the build's code: the build runs Vite and its plugins, cargo with the build scripts and macros of hundreds of crates, the Tauri CLI, NSIS and WiX, and any of them, compromised, could sign its own payload with a key it can reach, or copy the key itself. A key that the store marks "not exportable" only asks code to leave it alone, and secrets a job reads sit in the runner's memory for the whole job. So `.github/workflows/desktop-release.yml` builds Windows in five jobs, and only two of them, which run none of that code, ever see the certificate (`apps/desktop/release/windows-signing.ts`):

| Job | Runs | What it does |
|---|---|---|
| `windows-build` | The build: pnpm, Vite, cargo, the Tauri CLI, NSIS, WiX | Compiles `fxm.exe` and makes both installers with `tauri build`. Tauri's own signing runs FXM's hook (`release.ts windows-hook`) instead of signtool, which copies each file Tauri would sign before packing it and signs nothing: `fxm.exe`, once for each installer (Tauri writes the bundle type into a copy for each, which the updater reads), and the five NSIS plugins. Its installers are unsigned |
| `windows-sign-app` | GitHub's own actions, PowerShell, signtool, `release.ts` | Checks the collected files, then signs them: the two copies of `fxm.exe` may differ in their bundle type alone, and the plugins must be the ones Tauri downloads, by SHA-256, so the build can't get anything else signed |
| `windows-bundle` | The Tauri CLI, NSIS, WiX | Makes the installers again around the same `fxm.exe` (`tauri bundle`), with the hook putting the signed copy of each file where Tauri packs the same bytes, and checks that every signed file went in |
| `windows-sign-installers` | GitHub's own actions, PowerShell, signtool, `release.ts` | Signs the two installers |
| `windows-check` | GitHub's own actions, PowerShell, 7-Zip, `msiexec`, `release.ts` | Unpacks the installers and reads every signature (`Get-AuthenticodeSignature`): both installers, the `fxm.exe` inside each and the NSIS plugins, each signed by its job's certificate and timestamped. Then it hands the installers to the updater's sign job |

Only the two signing jobs name the `windows-signing` environment and read its secrets. Each one puts the certificate in its runner's store (`apps/desktop/release/windows-certificate.ps1`), signs with the Windows SDK's signtool (SHA-256 digests, "FXM" as the description, an RFC 3161 timestamp, three tries for a timestamp server that doesn't answer), and takes the certificate out again; the runner is thrown away after the job. The updater's signatures are made after all that, by the updater's sign job, over the signed installers, so the two never conflict.

**The NSIS uninstaller stays unsigned.** NSIS makes it while it packs the installer, and Tauri signed it then, through NSIS's `!uninstfinalize`; to sign it now, a job with the key would have to run NSIS, which is build code. Nothing runs it while FXM installs or updates (an update runs the new installer, never the old uninstaller), but Smart App Control may block it when the user uninstalls an app installed with the `-setup.exe`. The MSI has no such file: Windows uninstalls it itself ([INSTALL.md](../apps/desktop/INSTALL.md#windows)).

| Run | Certificate | Result |
|---|---|---|
| Dry run (`desktop.yml`, `release-dry-run`) | A throwaway self-signed certificate in each signing job, exported to a PKCS #12 file with a random password and imported from it, as a release's certificate is | Every file signed and checked; nothing trusts the certificates |
| Release, with `WINDOWS_CERTIFICATE` in the `windows-signing` environment | That certificate, in both signing jobs | Every file signed by it, checked, and trusted by Windows |
| Release without it | None: `windows-sign-app` finds no certificate, and the bundling and second signing are skipped | `windows-build`'s unsigned installers, with a notice in the run; the check makes sure nothing is signed |

A dry run on 2026-10-26 (run 40286470087) showed the five jobs working on GitHub's Windows runners, in 11 minutes, 3 of them after the build. The hook collected the two copies of `fxm.exe` and the five plugins, whose SHA-256 matched the pins; each signing job imported its throwaway certificate from a PKCS #12 file and signed, with timestamps from Certum's server; `tauri bundle` took every signed copy and left the uninstaller, WiX's libraries and the installers as they were; and the check found 9 files signed by their jobs' certificates: the two installers, the `fxm.exe` inside each and the five plugins. Before the split, one job's `tauri build` signed all of them, with the certificate in the store while the build ran.

### Setting up the certificate

1. Make the environment, limited to `main`, so that only release runs can read its secrets. Adding the owner as a required reviewer also makes each release wait for the owner's approval, twice: once for each signing job, before it gets the certificate.

   ```sh
   scripts/run.sh gh api -X PUT repos/Pratyay-ops/FXM/environments/windows-signing \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   scripts/run.sh gh api -X POST repos/Pratyay-ops/FXM/environments/windows-signing/deployment-branch-policies \
     -f name=main -f type=branch
   ```

2. Give it the certificate: `WINDOWS_CERTIFICATE` is the PKCS #12 (`.pfx`) file in base64, `WINDOWS_CERTIFICATE_PASSWORD` its password (leave it out for a file without one). Add them to the environment, never to the repository's secrets, which a workflow run from any pushed branch can read. `release.yml` passes both names on to `desktop-release.yml`, as GitHub needs for an environment's secret to reach a called workflow's job, and only the signing jobs, which name the environment, get the values.

   ```sh
   base64 -i fxm-code-signing.pfx | scripts/run.sh gh secret set WINDOWS_CERTIFICATE --env windows-signing
   scripts/run.sh gh secret set WINDOWS_CERTIFICATE_PASSWORD --env windows-signing
   ```

3. Optionally, set the repository variable `WINDOWS_TIMESTAMP_URL` to the certificate authority's RFC 3161 server; the default is Certum's, `http://time.certum.pl`.
4. Start a dry run (`scripts/run.sh gh workflow run desktop.yml --ref develop -f release-dry-run=true`), which signs with throwaway certificates through the same import, to see the signing work before a release.

### Per service

Certificate authorities issue code-signing keys only on hardware since June 2023, so a `.pfx` file in `WINDOWS_CERTIFICATE` fits a certificate issued as a file, and every dry run's throwaway certificate, which tries that whole path: decoding, importing, signing, removing. Each service needs a few lines more in the two signing jobs, written once it accepts FXM and its own test setup can check them; the jobs' checks of what they sign stay as they are:

- **Certum (cloud):** in each signing job, a step that signs in to SimplySign with the account and the one-time-code seed (both secrets of `windows-signing`), so that the certificate appears in the runner's store; then `release.ts windows-sign` by its thumbprint, as now. Command-line SimplySign clients exist (for example `ssign`, MIT, which signed PE files but not yet MSI on 2026-10-26): such a client would be the one third-party program in the signing jobs, so check it before relying on it. The seed works like a private key: keep it only in the environment, with the owner as required reviewer.
- **OSSign:** its CLI in place of signtool in the signing jobs (`ossign -t pecoff` for the executables and plugins, `-t msi` for the MSI), installed by its action, with `id-token: write` for its keyless server, granted to those two jobs only. A token in a job that builds could sign anything, as a key could.
- **SignPath:** the signing jobs submit what they would sign to SignPath (`signpath/github-action-submit-signing-request`, pinned to a commit, with the organization ID, project, signing policy and artifact configuration that SignPath sets up, and the API token as a secret of `windows-signing`) and download what it signed: first the copies of `fxm.exe` and the plugins (the artifact `windows-to-sign`), then the installers (`windows-installers`). SignPath holds the key, and the owner approves each request. Its terms allow only the project's own binaries: if the NSIS plugins (NSIS's and Tauri's, open source, unchanged) don't count as such, the first request carries the two copies of `fxm.exe` alone, and the plugins stay unsigned, as NSIS ships them.

Whichever service signs: update [INSTALL.md](../apps/desktop/INSTALL.md#windows) (the warnings users still see), the attribution above, and [apps/desktop/README.md](../apps/desktop/README.md#releases).
