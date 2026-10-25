# FXM

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Pratyay-ops/FXM)

**FXM (Free Cross-platform Media)** is a free, open-source music player for the web, desktop and Android. It is in early development.

- **Play practically any song** from YouTube Music, ad-free, streamed straight to your device. There are two modes:
  - **Music:** only songs (from the YouTube Music catalog, Internet Archive, Jamendo and your own files), with clean album audio.
  - **Music + Video:** also any YouTube video (covers, live sets, remixes), played as music.
- **Spotify built in, switchable.** Search, related artists and song radio from Spotify's catalog. Connect your account to sync your recommendations, liked songs and playlists (read-only: FXM never changes your Spotify account). Turn it off any time.
- **Made for you.** A home feed, daily mixes and endless radio, computed on your device from YouTube Music radio, Spotify, Last.fm and ListenBrainz.
- **Download any track** as Original, FLAC, ALAC, WAV, MP3, AAC or Opus, with tags and cover art. You get real lossless audio where the source has it (Internet Archive, Jamendo), and conversions are labelled honestly.
- **No servers, no accounts, no tracking.** Everything runs on your device. The web app uses the small **FXM Connect** browser extension to reach music services from your own browser. Without it, an experimental no-install mode (Lite) can search and play YouTube Music in some browsers, for as long as YouTube allows it (no Spotify or downloads there), alongside free music from Internet Archive and Jamendo. The desktop app (macOS, Windows and Linux) and the Android app don't need the extension.

Inspired by [Bloomee](https://github.com/HemantKArya/BloomeeTunes) and [Spotube](https://github.com/KRTirtho/spotube). FXM is not affiliated with YouTube, Google or Spotify.

## Where it will run

| | |
|---|---|
| Web page | `https://fxm-music.pages.dev/` |
| Web app (installable PWA), with the FXM Connect extension or in the experimental Lite mode | `https://fxm-music.pages.dev/app/` |
| Desktop app (macOS, Windows, Linux) | GitHub Releases |
| Android app (APK) | GitHub Releases |
| Embeddable mini-player | `https://fxm-music.pages.dev/embed/…` |

## Docs

- [Architecture](docs/ARCHITECTURE.md): how FXM works and why
- [Roadmap](docs/PLAN.md): milestones and stages, with status
- [Workflow](docs/WORKFLOW.md): branches, worktrees, releases, parallel agents, commit rules
- [Development](docs/DEVELOPMENT.md): setup, where tools are installed, removing everything

## Legal

FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google or Spotify, and it hosts no music. You are responsible for following the terms of the services you use with FXM and the laws where you live. Send notices and takedown requests through the [issue tracker](https://github.com/Pratyay-ops/FXM/issues), and report security problems privately as the [security policy](.github/SECURITY.md) explains. [docs/LEGAL.md](docs/LEGAL.md) and the site's [disclaimer page](https://fxm-music.pages.dev/disclaimer) have the details.

## License

[Apache-2.0](LICENSE)
