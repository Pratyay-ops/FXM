# FXM

[![Ask DeepWiki](https://img.shields.io/badge/Ask-DeepWiki-blue)](https://deepwiki.com/Pratyay-ops/FXM)

**FXM (Free Cross-platform Media)** is a free, open-source music player that runs in your browser, with desktop and Android apps on the way. FXM is in early development: anything marked (coming soon) is on its way.

- **Play practically any song** from YouTube Music, ad-free, streamed straight to your device. There are two modes:
  - **Music:** songs only, from any source: YouTube Music's clean album audio, free music from Internet Archive (Jamendo coming soon), and your own files.
  - **Music + Video:** also any YouTube video (covers, live sets, remixes), played as music.
- **Spotify built in, switchable.** Search Spotify's catalog, see related artists, and get its recommendations on your home feed. Song radio from Spotify's catalog (coming soon). Connect your account for a read-only sync of your recommendations, liked songs and playlists: FXM never changes your Spotify account. Turn Spotify off any time.
- **Your library, on your device.** Likes, playlists in an order you choose, your listening history and backups, plus your own music files, synced lyrics from LRCLIB, and scrobbling to Last.fm and ListenBrainz once you connect an account. If you turn on sync, a copy also goes to a secret gist on your own GitHub account, so your other devices can read it.
- **Made for you.** A home feed with quick picks and daily mixes, computed on your device from YouTube Music radio, Spotify, Last.fm and ListenBrainz, and endless radio (coming soon).
- **Download any track** for offline listening, as the file its source has: real lossless FLAC where the source has it (Internet Archive), Opus or AAC from YouTube Music (with FXM Connect in the browser). Converting to FLAC, ALAC, WAV, MP3, AAC or Opus, with tags, cover art and honest labels (coming soon).
- **No servers, no accounts, no tracking.** Everything runs on your device. In the browser, the small **FXM Connect** extension lets the web app reach YouTube Music and Spotify from your own browser; without it, the web app plays free music from Internet Archive, your own files, and YouTube Music in the experimental Lite tier where the browser allows it. The desktop app (macOS, Windows and Linux) and the Android app (both coming soon) won't need the extension.

Inspired by [Bloomee](https://github.com/HemantKArya/BloomeeTunes) and [Spotube](https://github.com/KRTirtho/spotube). FXM is not affiliated with YouTube, Google or Spotify.

## Where it runs

| | |
|---|---|
| Web page | `https://fxmusic.pages.dev/` |
| Web app, installable from the browser (with the FXM Connect extension for YouTube Music and Spotify) | `https://fxmusic.pages.dev/app/` |
| FXM Connect for Chrome, Edge, Brave and other Chromium browsers | GitHub Releases (zip) |
| FXM Connect for Firefox, signed by Mozilla (coming soon) | GitHub Releases (`.xpi`), and Firefox Add-ons once it is listed |
| Desktop app for macOS, Windows and Linux (coming soon) | GitHub Releases |
| Android app (coming soon) | GitHub Releases (APK) |
| Embeddable mini-player (coming soon) | `https://fxmusic.pages.dev/embed/…` |

## Docs

- [Architecture](docs/ARCHITECTURE.md): how FXM works and why
- [Roadmap](docs/PLAN.md): milestones and stages, with status
- [Workflow](docs/WORKFLOW.md): branches, worktrees, releases, parallel agents, commit rules
- [Development](docs/DEVELOPMENT.md): setup, where tools are installed, removing everything
- [Legal](docs/LEGAL.md): notices, trademark rules, the takedown playbook and the clean-room rule

## Legal

FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google or Spotify, and it hosts no music. You are responsible for following the terms of the services you use with FXM and the laws where you live. Send notices and takedown requests through the [issue tracker](https://github.com/Pratyay-ops/FXM/issues), and report security problems privately as the [security policy](.github/SECURITY.md) explains. [docs/LEGAL.md](docs/LEGAL.md) and the site's [disclaimer page](https://fxmusic.pages.dev/disclaimer) have the details.

## License

[Apache-2.0](LICENSE)
