# Legal notices and rules

FXM's legal notice and contacts, and the rules the project follows: how it names other services, how provider code is written, what to do with a takedown notice and where security reports go. The project wrote this page for its own use. It isn't legal advice, and no lawyer has reviewed it yet (see [Owner actions](#owner-actions)).

## Notice

FXM is an independent open-source project. It is not affiliated with, endorsed by or sponsored by YouTube, Google, Spotify or any other music service.

FXM hosts no music and has no servers of its own. Its apps run on the user's device and connect it directly to the services FXM works with.

Users are responsible for how they use FXM, including following the terms of the services they use with it and the laws where they live. FXM is provided as is, without warranties or conditions of any kind, under the [Apache License 2.0](../LICENSE).

The same notice is in the [README](../README.md#legal), on the site's [disclaimer page](https://fxmusic.pages.dev/disclaimer) (source: [`apps/site/src/pages/disclaimer.astro`](../apps/site/src/pages/disclaimer.astro)) and, shorter, under "Legal" in every release's notes, which [`scripts/release-notes.sh`](../scripts/release-notes.sh) adds after the release's summary. Change them all together.

## Contacts

| For | Where |
|---|---|
| Notices and takedown requests | The [issue tracker on GitHub](https://github.com/Pratyay-ops/FXM/issues). Issues are public |
| Security reports | GitHub's [private vulnerability reporting](https://github.com/Pratyay-ops/FXM/security/advisories/new), as the [security policy](../.github/SECURITY.md) describes |

FXM has no contact email address. Don't put an email address or a person's name in the notices unless the owner provides one.

## Trademark rules

YouTube, YouTube Music and Google are trademarks of Google LLC, and Spotify is a trademark of Spotify AB. FXM names them, and every other service, only to say what it works with.

- **No logos or brand assets** of YouTube, YouTube Music, Google or Spotify anywhere: not in the apps, on the site, in icons, in screenshots or in store listings.
- **No brand colours.** FXM's colours come from its own design tokens. Nothing that stands for a service (its name, a button or a section about it) uses that service's colours, for example YouTube's red or Spotify's green.
- **No lookalike names.** None of FXM's own names (of the product, a feature, a package, the extension or a domain) may be built from or imitate a service's name, such as a "Spot…" name in the style of Spotube, or a "…Tube" name. Naming the service itself in plain words is fine: the `spotify` provider folder, a "Spotify" section in Settings.
- **Plain words, no endorsement.** Write a service's name as ordinary text, never as a logo or in the service's own lettering, and only to say what FXM works with: "plays songs from YouTube Music", "search Spotify's catalog". Never use words that suggest a partnership or approval, such as "official", "partner" or "certified".
- **The non-affiliation notice goes with public descriptions** that name a service, wherever the format has room, such as store listings.

These rules are a review item for every stage that writes public text, and the [pull request template](../.github/pull_request_template.md) has a checklist line for them.

| Public text | Stages |
|---|---|
| The site: pages, metadata and images | 5.3, 2.7 |
| FXM Connect's name, descriptions and options page | 1.9, R.2 |
| The desktop app's bundle descriptions in `apps/desktop/src-tauri/tauri.conf.json` | 7.1 |
| Store listings | R.2, R.3 |
| The release notes: each release's summary in `docs/releases/`, which heads the release pull request and the GitHub Release | Every release |
| The web app's strings and web app manifest (5.1 added the manifest), and the Android app's name and strings | Every stage that changes them |

**Audit on 2026-10-26:** no logos, brand colours or lookalike names in the site's pages, metadata, icons and social image; FXM Connect's manifest, README, options page and icons; the desktop app's bundle descriptions and icon; the web app's `index.html` and its web app manifest (`app/manifest.webmanifest`, from 5.1: the name and short name "FXM", the description "A free, open-source music player: search and play practically any song.", the shortcuts "Search" and "Your library", FXM's own theme colour and icons drawn from FXM's violet mark); or the Android app's name, strings and icons.

## Clean-room rule

FXM talks to YouTube and Spotify through APIs they don't document. Code that relies on such an API is written from protocol facts only, so that it is FXM's own work and stays under the Apache License 2.0. The rule covers all such code, not only the providers in `packages/sources/`: FXM Connect's rules and Spotify session bridge, and the desktop and Android apps' network code too.

- **Protocol facts only:** endpoints, request and response fields, client names and versions, operation names, persisted-query hashes, header names, error codes and observed behaviour.
- **Each fact with its source and date.** Before code relies on a fact, record it in the clean-room log of the service it is about (listed below), whichever part of FXM uses it, with where it came from and the date you saw it. Good sources are the service's own files (name the web-player file you found it in), requests you captured yourself, public documentation and permissively licensed projects.
- **Nothing from GPL, AGPL or unlicensed projects.** Take no code, no test fixtures and no translated logic (a port to TypeScript, or a close paraphrase) from a project under the GPL or AGPL, or from one with no licence at all, which leaves every right with its authors. While you write a feature, don't work from such a project's implementation of it. A fact first seen there counts only once you have confirmed it from one of the sources above, and the log names that source. The Unlicense, which yt-dlp uses, is a public-domain dedication, not a missing licence.
- **Never open the AGPL spotube-plugin-spotify.** FXM's Spotify provider is written from Spotify's own web-player files. Copying from the plugin would put the whole distributed bundle under the AGPL (its section 5(c)), not just one module.
- **Permissively licensed code may be reused with its notice.** Code under the MIT, Apache-2.0 or 2- or 3-clause BSD licence may be copied or adapted if its copyright and licence notice stay with it. For Apache-2.0 code, also keep the notices from its NOTICE file, if it has one, and mark the files you changed. Note where the code came from. Code under any other licence needs the owner's approval first.

[ARCHITECTURE.md §17](ARCHITECTURE.md#17-security-privacy-licensing) lists the projects this rules out, among them Bloomee, Spotube and its Spotify plugin, bloom-factory and NewPipeExtractor, and the permissively licensed libraries FXM builds on.

**Clean-room logs,** one per service:

| Service | Log | Created by |
|---|---|---|
| YouTube and YouTube Music | [`packages/sources/src/youtube/CLEAN-ROOM.md`](../packages/sources/src/youtube/CLEAN-ROOM.md) | 1.3 |
| Spotify | [`packages/sources/src/spotify/CLEAN-ROOM.md`](../packages/sources/src/spotify/CLEAN-ROOM.md) | 1.5 |
| Last.fm (stations and API) | [`packages/sources/src/lastfm/CLEAN-ROOM.md`](../packages/sources/src/lastfm/CLEAN-ROOM.md) | 3.2 |
| ListenBrainz | [`packages/sources/src/listenbrainz/CLEAN-ROOM.md`](../packages/sources/src/listenbrainz/CLEAN-ROOM.md) | 3.2 |
| Cover Art Archive | [`packages/sources/src/coverart/CLEAN-ROOM.md`](../packages/sources/src/coverart/CLEAN-ROOM.md) | 3.2 |
| iTunes Search | [`packages/sources/src/itunes/CLEAN-ROOM.md`](../packages/sources/src/itunes/CLEAN-ROOM.md) | 3.2 |
| Imported files and links (Spotify's data export, Exportify's CSV, M3U, YouTube links) | [`packages/sources/src/import/CLEAN-ROOM.md`](../packages/sources/src/import/CLEAN-ROOM.md) | 3.6 |
| Scrobbling: Last.fm's and ListenBrainz's write APIs | [`packages/sources/src/scrobble/CLEAN-ROOM.md`](../packages/sources/src/scrobble/CLEAN-ROOM.md) | 8.2 |
| SponsorBlock | [`packages/sources/src/sponsorblock/CLEAN-ROOM.md`](../packages/sources/src/sponsorblock/CLEAN-ROOM.md) | 8.7 |

When FXM starts using another service's undocumented API, start a log for that service in its provider's folder (`packages/sources/src/<service>/CLEAN-ROOM.md`) and add a row here. FXM Connect was written before these logs: the service behaviour it relies on, measured against the live services in October 2026, is described in the header of [`apps/extension/src/rules.ts`](../apps/extension/src/rules.ts) and in the [extension's README](../apps/extension/README.md). New facts go into the logs.

## Takedown playbook

**Be ready:**

- Keep the clean-room logs current. They show where each protocol fact came from.
- Keep secrets out of git. Secret scanning and push protection are on (see [Security](#security)).
- Keep the contacts below at hand.
- Optionally, have a short legal consult before the public launch (see [Owner actions](#owner-actions)).

**When a notice arrives,** as an issue, a letter or email to the owner, a GitHub DMCA notice, a message from an extension store or a notice from Cloudflare about the site or the web app:

1. **Read it and keep it.** Work out exactly what it targets (files, a module, release files or a store listing) and on what grounds: copyright, circumvention (DMCA section 1201), trademark or a service's terms. Note any deadline. When a GitHub DMCA notice names only part of a repository, GitHub gives the owner about one business day to change it before disabling the repository ([GitHub's DMCA Takedown Policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy)).
2. **Get advice** before answering a notice that threatens legal action or names the owner personally. Don't argue about it in public.
3. **Remove only the targeted module, and keep FXM online.** Providers are separate modules, so one can be removed while the rest keeps working. FXM works without Spotify; without YouTube, it plays only free sources (Internet Archive, and Jamendo once it is turned on) and local files. To remove the Spotify provider, for example:
   - delete `packages/sources/src/spotify/` and the code that uses it;
   - remove the Spotify parts of FXM Connect (its Spotify rules, its session bridge and the Spotify hosts in its manifest) and of the desktop and Android apps (their Spotify hosts and their Spotify login);
   - take Spotify's hosts out of the web app's CSP, and update what the site says about Spotify, on the privacy page too;
   - release every affected channel: the web app and the site (a release or hotfix to `main` redeploys both), FXM Connect, the desktop app and the Android app.

   Remove release files only if the notice names them. For a store listing or a Cloudflare notice, also follow that company's process.
4. **Reply** to the sender, or on the issue, saying what changed, with links.
5. **If the notice is mistaken,** for example because the code is FXM's own clean-room work, a counter notice can restore what GitHub disabled ([GitHub's guide to counter notices](https://docs.github.com/en/site-policy/content-removal-policies/guide-to-submitting-a-dmca-counter-notice), sent through [GitHub's copyright claims form](https://github.com/contact/dmca)). Get legal advice first, because a counter notice:
   - is sworn under penalty of perjury;
   - must include your name, physical address, phone number and email address. GitHub publishes it in [github/dmca](https://github.com/github/dmca) with those details redacted, but may give the sender an unredacted copy, so filing one tells the sender who and where you are;
   - consents to the jurisdiction of a US federal court (for someone outside the US, the Northern District of California, where GitHub is) and to accept legal papers from the sender.

   GitHub restores the content after 10 to 14 days unless the sender files a lawsuit in that time and tells GitHub.
6. **For a circumvention claim,** GitHub has the claim reviewed by technical and legal experts. When GitHub processes one, it offers the repository owner a referral for independent legal advice at no cost through its Developer Defense Fund.

**Contacts to keep:**

| Who | What they offer | Link |
|---|---|---|
| Electronic Frontier Foundation (EFF) | Takes on, or refers, some technology cases, mainly in US courts. It chooses its cases, and the page explains how to ask | [Legal assistance from EFF](https://www.eff.org/pages/legal-assistance) |
| SFLC.in (Software Freedom Law Center, India) | Helps free and open-source software developers in India and gives free legal advice. Contact details are at the foot of its home page | [sflc.in](https://sflc.in/) |
| GitHub's Developer Defense Fund | Independent legal advice at no cost for the owner of a repository facing a circumvention claim that GitHub processes. GitHub makes the referral | [GitHub's policy on circumvention claims](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy#c-what-about-circumvention-claims) |

Every link in this playbook was checked on 2026-10-26.

## Security

- **Policy:** [`.github/SECURITY.md`](../.github/SECURITY.md). Reports go through GitHub's private vulnerability reporting.
- **security.txt** ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html)): served at `https://fxmusic.pages.dev/.well-known/security.txt` from [`apps/site/public/.well-known/security.txt`](../apps/site/public/.well-known/security.txt).
  - Its `Expires` is 2027-10-25T00:00:00Z. Before then, set a new date at most a year ahead. Update `Canonical` if the site moves.
  - The site build copies it to `apps/site/dist/.well-known/`. The deploy (2.8) must keep that folder when it puts the site together, as the [site's README](../apps/site/README.md#deploying-with-the-web-app) notes: a shell glob such as `dist/*` skips folders whose names start with a dot.
  - Cloudflare Pages serves `/.well-known/` files: other `pages.dev` projects serve theirs as `text/plain; charset=utf-8`, and `wrangler pages deploy` doesn't skip dot-folders (checked on 2026-10-26).
- **Secret scanning and push protection:** checked and found enabled on 2026-10-25 through the GitHub API (`secret_scanning` and `secret_scanning_push_protection` in the repository's `security_and_analysis` settings).
- **Private vulnerability reporting:** turned on 2026-10-26, and checked through the GitHub API the same day (`GET repos/Pratyay-ops/FXM/private-vulnerability-reporting` answers `"enabled": true`).

## Owner actions

| Action | Status |
|---|---|
| Turn on secret scanning and push protection | Done: found enabled on 2026-10-25 |
| Turn on private vulnerability reporting, where the README, the disclaimer page, the security policy and `security.txt` all send security reports | Done: turned on 2026-10-26, before the first release (see [Security](#security)) |
| A short legal consult before the public launch, with a lawyer in the owner's jurisdiction. SFLC.in is one option in India | Optional, the owner's call: FXM is mostly for personal use (owner, 2026-10-25) |
