# Installing the FXM desktop app

The FXM desktop app is on [GitHub Releases](https://github.com/Pratyay-ops/FXM/releases/latest), for macOS, Windows and Linux. It is free and open source, has everything built in (no browser extension needed), and updates itself: it asks before it installs a new version.

FXM isn't signed with a certificate from Apple or Microsoft, which both charge for one, so macOS and Windows warn the first time you open it. This page says what you'll see and what to do. Each release lists checksums of its files and a record of the workflow that built them (see [Checking a download](#checking-a-download)).

## Which file

| Your computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `fxm-desktop-<version>-macos-arm64.dmg` |
| Mac with an Intel processor | `fxm-desktop-<version>-macos-x64.dmg` |
| Windows 10 or 11, 64-bit | `fxm-desktop-<version>-windows-x64-setup.exe`, or the `.msi` to install for every user of the PC |
| Debian, Ubuntu, Linux Mint, Pop!_OS and other Debian-based Linux | `fxm-desktop-<version>-linux-x64.deb` (`-linux-arm64.deb` on ARM) |
| Other Linux | `fxm-desktop-<version>-linux-x64.AppImage` (`-linux-arm64.AppImage` on ARM) |

Which Mac do you have? Apple menu → About This Mac: "Chip: Apple M…" is Apple silicon, "Processor: … Intel …" is Intel.

The `.app.tar.gz` files and `latest.json` are for the updater: you don't need them.

## macOS

For macOS 11 (Big Sur) or later.

1. Open the `.dmg` and drag FXM into Applications. Keep it there: the updater replaces the app where it is, and macOS runs an app opened from the disk image or from Downloads as a read-only copy.
2. Open FXM from Applications. macOS says it can't verify FXM: "Apple could not verify “FXM” is free of malware…". Click **Done**, not Move to Trash.
3. Open System Settings → Privacy & Security and scroll down to Security, where it says "“FXM” was blocked to protect your Mac". Click **Open Anyway**, and confirm with your password or Touch ID. The button is there for about an hour after you tried to open FXM.
4. macOS asks once more: click **Open Anyway**. From then on FXM opens like any other app, and its updates do too.

On macOS 14 (Sonoma) and earlier, Control-click FXM in Applications and choose **Open** instead.

**Why.** macOS opens an app from the internet without asking only when Apple has notarized it, and that takes a paid membership of Apple's developer program, which FXM doesn't join. FXM's Mac app is signed ad hoc instead: macOS can check that it is exactly the app that was built, not who built it.

If macOS says FXM "is damaged and can't be opened", the file was changed or broken on the way: download it again.

## Windows

For Windows 10 or 11, 64-bit (x64). FXM displays its window with WebView2, which comes with Windows; the installer fetches it if it is missing.

- **`-setup.exe`** installs FXM for your account, without administrator rights, with a Start menu entry. Take this one unless you need the other.
- **`.msi`** installs FXM for every user of the PC, with administrator rights.

**SmartScreen.** When you run the installer, Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**. Your browser may warn before that the file isn't commonly downloaded: keep it (in Edge: **…** → **Keep** → **Show more** → **Keep anyway**).

**Smart App Control.** Where Smart App Control is on (Windows 11), it blocks FXM outright, with no "Run anyway": it blocks apps that are unsigned and that Microsoft doesn't know yet, and FXM's Windows installers aren't signed for now. To use FXM, turn it off in Windows Security → App & browser control → Smart App Control settings. Since Windows 11's April 2026 update you can turn it back on there later (on some PCs a later update greys the switch out); before that update, turning it back on needed a reset of Windows. To keep it on, use FXM in your browser instead, at [fxmusic.pages.dev/app](https://fxmusic.pages.dev/app/) with the FXM Connect extension.

**Why.** Windows trusts an installer that is signed with a code-signing certificate, which costs money every year. FXM means to apply for the free signing that SignPath Foundation and OSSign offer open-source projects; until one of them accepts it, its Windows installers are unsigned.

Windows' media controls name FXM "Unknown app": a bug in WebView2, which owns the media session. The controls themselves work.

## Linux

**Debian, Ubuntu and their derivatives: the `.deb`.**

```sh
sudo apt install ./fxm-desktop-<version>-linux-x64.deb
```

apt also installs what FXM plays music with: GStreamer's base and good plugins, gst-libav for AAC, and an audio output. On Ubuntu, gst-libav comes from the universe component, which is on by default. To update itself, FXM installs the new `.deb` and asks for your password to do so.

**Other distributions: the AppImage.** Make it executable, then run it:

```sh
chmod +x fxm-desktop-<version>-linux-x64.AppImage
./fxm-desktop-<version>-linux-x64.AppImage
```

If it doesn't start, install FUSE 2 (the package `libfuse2`, called `libfuse2t64` on Ubuntu 24.04 and later), or run it with `--appimage-extract-and-run`. The AppImage brings its own GStreamer, which plays Opus, Vorbis, MP3 and FLAC but not AAC: its decoder comes from FFmpeg, which the AppImage leaves out. A song FXM can only get as AAC plays with the `.deb`, not with the AppImage. FXM updates the AppImage in place.

**The tray.** Closing FXM's window keeps the music playing, with FXM in the panel's tray, where the desktop shows tray icons: KDE Plasma, Cinnamon, XFCE and most others do, GNOME with its AppIndicator extension. Where none shows, closing the window quits FXM.

## Updates

FXM looks for a new version when it starts and once a day while it runs, in the latest release on GitHub. When there is one, it asks, while its window is in front: **Install and Restart** downloads the new version, checks its signature, installs it and opens FXM again, which stops the music; **Later** leaves it until the next check. FXM installs nothing that isn't signed with FXM's update key for that very version.

## Checking a download

Each release lists the SHA-256 checksum of every file in `SHA256SUMS`, and GitHub keeps a record (an attestation) that FXM's release workflow built them. In the folder you downloaded to:

```sh
sha256sum --check --ignore-missing SHA256SUMS   # on macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify <file> --repo Pratyay-ops/FXM \
  --cert-identity https://github.com/Pratyay-ops/FXM/.github/workflows/release.yml@refs/heads/main \
  --deny-self-hosted-runners
```

## Uninstalling

- **macOS:** drag FXM from Applications to the Trash. Its data stays in `~/Library/Application Support/io.github.pratyayops.fxm`, `~/Library/Caches/io.github.pratyayops.fxm` and `~/Library/WebKit/io.github.pratyayops.fxm`: delete those folders too to remove it.
- **Windows:** Settings → Apps → Installed apps → FXM → Uninstall.
- **Linux:** `sudo apt remove fxm`, or delete the AppImage. Its data is in `~/.config/io.github.pratyayops.fxm` and `~/.local/share/io.github.pratyayops.fxm`.
