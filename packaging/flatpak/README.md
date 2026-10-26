# Flatpak and Flathub

A Flatpak runs FXM's desktop app for Linux in Flatpak's sandbox, on a shared runtime that brings the webview and the media framework. This folder has what a Flatpak of FXM needs, and a checklist for Flathub, which FXM can't join as things stand ([Flathub](#flathub)). Nothing here submits anything.

| File | What it is |
|---|---|
| [`io.github.pratyay_ops.FXM.metainfo.xml`](io.github.pratyay_ops.FXM.metainfo.xml) | The app's AppStream metainfo: name, summary, description, links, licences, content rating, branding. Software centres such as GNOME Software and KDE Discover show it. `channels sync` writes it from `packaging/listing.ts` ([`appdata.ts`](appdata.ts)) |
| [`io.github.pratyay_ops.FXM.desktop`](io.github.pratyay_ops.FXM.desktop) | The desktop entry that puts FXM in the application menu, also written by `channels sync` |
| [`manifest.ts`](manifest.ts) | Writes a Flatpak manifest for a release that repackages its `.deb` files (stage 7.5) |

## A Flatpak of a release

For each release that has the desktop app, the channels workflow (`.github/workflows/channels.yml`) writes the manifest with the `.deb` files' checksums from the release's `SHA256SUMS`, next to the files it installs: the metainfo naming that release, the desktop entry, the icon (`apps/desktop/assets/icon.svg`) and the licence. They are in the workflow run's artifact `channels-vX.Y.Z`. By hand: `scripts/run.sh pnpm --filter @fxm/packaging --silent channels flatpak <x.y.z> --sums SHA256SUMS --out <folder>`.

To build and install it on Linux, with Flathub's builder, the runtime from Flathub, and Flathub's shared modules at the commit the manifest names (`SHARED_MODULES` in [`manifest.ts`](manifest.ts)):

```sh
flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.flatpak.Builder org.gnome.Platform//51 org.gnome.Sdk//51
cd <the folder with io.github.pratyay_ops.FXM.yml>
git clone https://github.com/flathub/shared-modules.git
git -C shared-modules checkout 3d87a6632cf1e787b009e234b13a8ccfa6d15df8
flatpak run org.flatpak.Builder --user --install --force-clean build io.github.pratyay_ops.FXM.yml
flatpak run io.github.pratyay_ops.FXM
```

The shared modules build libayatana-appindicator, the library the app's tray icon loads at runtime: the GNOME runtime has none, and without one the tray code (`libappindicator-sys`, behind Tauri's `tray-icon` feature) panics, which would stop the app. Flathub's apps add the same repository as a git submodule.

The manifest has not been built on Linux yet: this stage ran on macOS, and the first release with the desktop app comes after it. Check playback (an Opus and an AAC song), the tray icon and closing to the tray, a second start bringing the first window back (single instance), media keys and the system's media controls, and Settings → About's third-party notices.

**Its updates.** The binary comes from the `.deb`, so FXM's own update check (stage 7.5) believes apt installed it, and its offer tells the user to install the new `.deb` with apt, which doesn't apply in a Flatpak. Build the Flatpak of the new release instead. A Flatpak that Flathub published would have to keep FXM's update check off, because Flathub updates it.

### The runtime

`org.gnome.Platform` 51, the newest on Flathub (GNOME 51 came out on 2026-09-16), on freedesktop-sdk 26.08:

- **WebKitGTK 4.1**, the GTK 3 webview Tauri uses on Linux: the GNOME 51 SDK builds it (`elements/sdk/webkit2gtk-4.1.bst` on gnome-build-meta's `gnome-51` branch, checked 2026-10-26).
- **GStreamer**, which WebKitGTK plays media with, with its base, good and libav plugins: Opus and Vorbis play out of the box. AAC and H.264 come from the runtime's `org.freedesktop.Platform.codecs-extra` extension, which Flatpak installs with the runtime: freedesktop-sdk 26.08 declares it without `no-autodownload` and puts its plugins on `GST_PLUGIN_SYSTEM_PATH` (`platform.bst`, read 2026-10-26).

### Permissions

Only what the app uses (`FINISH_ARGS` in [`manifest.ts`](manifest.ts)):

| Permission | Why |
|---|---|
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc`, `--device=dri` | The window, and the GPU for WebKitGTK |
| `--share=network` | FXM talks to the music services from the device itself |
| `--socket=pulseaudio` | Sound (PipeWire serves PulseAudio's socket too) |
| `--own-name=io.github.pratyayops.fxm.SingleInstance` | Tauri's single-instance plugin owns `<identifier>.SingleInstance` on the session bus, and the `.deb`'s app has the identifier `io.github.pratyayops.fxm`, outside the names Flatpak lets an app own by default (those under its own ID) |
| `--talk-name=org.kde.StatusNotifierWatcher` | The tray icon |
| `--own-name=org.mpris.MediaPlayer2.org.webkit.*` | The media controls: WebKitGTK names its MPRIS service after the app's application ID, which, when the app sets none (Tauri sets none by default), it makes from the executable's path: `org.webkit.app-<hash>` (WebKit's `ApplicationGLib.cpp` and `MediaSessionGLib.cpp`, read 2026-10-26) |

No files, devices or host access: downloads to disk (stage 7.4) will need the file chooser portal or `--filesystem=xdg-download` when they come.

### The ID

The Flatpak is `io.github.pratyay_ops.FXM`. Flathub derives the repository from an `io.github.` ID and checks it: `io.github.pratyay_ops.FXM` stands for `https://github.com/pratyay-ops/FXM`, an underscore replacing the dash, which IDs can't hold before their last part. The desktop app's own identifier, `io.github.pratyayops.fxm`, would stand for a GitHub account `pratyayops`, which didn't exist on 2026-10-26. A build from source could take the Flatpak ID as its Tauri identifier and set a GTK application ID (`app.enableGTKAppId`), and would then need neither of the two `--own-name` permissions.

## Flathub

**Not submitted, and blocked.** Flathub's [requirements](https://docs.flathub.org/docs/for-app-authors/requirements), read 2026-10-26, rule FXM's packaging out as it stands:

- **Its generative AI policy.** "Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction." So the manifest written here can never be submitted: a Flathub manifest would have to be written by a person, without AI tools. "Submitters must disclose any AI-generated code, documentation, packaging, or other material they know or reasonably believe is included in the application or its Flathub packaging", and "Reviewers may reject a submission, including without further review, based on the extent or role of generated material". FXM's code is written with AI tools. "AI tools or agents must not open or automate Flathub submission pull requests, or generate their commit messages, descriptions, review comments, or replies."
- **Building from source.** "All source available submissions must be built entirely from source code", and "Binary or precompiled files must not be present in the submission pull request". A manifest that repackages the release's `.deb`, like this one, isn't accepted for an open-source app.

### Checklist, if the owner decides to submit anyway

Everything below is the owner's, by hand: the manifest, the pull request and its text, and the replies to reviewers.

1. **Read the requirements and the AI policy again**, and expect a rejection over the generated code; disclose it as the policy asks.
2. **The ID**: `io.github.pratyay_ops.FXM` (at least four parts, lower case before the last one, an underscore for the dash). It verifies against the GitHub account `Pratyay-ops`.
3. **A manifest that builds from source**, written by hand: `org.gnome.Platform` and `org.gnome.Sdk` 51, the SDK extensions for Rust (`org.freedesktop.Sdk.Extension.rust-stable`) and Node.js 22, the source at the release's tag, and every dependency as an offline source, generated with Flatpak's builder tools: `flatpak-cargo-generator` for `apps/desktop/src-tauri/Cargo.lock` and `flatpak-node-generator pnpm` for `pnpm-lock.yaml` (it reads pnpm lockfiles; Flathub builds without the network). Generated source lists may sit in their own files ("Sub-manifests with sources must only be created when they are generated using an external tooling"). The build makes the web app (`pnpm --filter @fxm/web build:desktop`) and the Tauri binary, then installs the binary, the metainfo, the desktop entry and the icon under the ID. Keep Flathub's shared libayatana-appindicator module for the tray, with `shared-modules` as a git submodule.
4. **No self-update.** Build with FXM's update check off (stage 7.5's updater), since Flathub delivers updates.
5. **The metainfo**: this folder's file, plus a `<releases>` list (the copy `channels flatpak` writes has the newest release) and `<screenshots>` with images at stable URLs. Check it with `flatpak run --command=flatpak-builder-lint org.flatpak.Builder appstream io.github.pratyay_ops.FXM.metainfo.xml`. The listing text follows the trademark rules of `docs/LEGAL.md`: services named in plain words, with the non-affiliation notice.
6. **Permissions**: the table above, each justified in the pull request.
7. **Build and lint locally**: `flatpak run --command=flathub-build org.flatpak.Builder --install <manifest>`, `flatpak run io.github.pratyay_ops.FXM`, then `flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest <manifest>` and `… repo repo`.
8. **Submit**: fork [flathub/flathub](https://github.com/flathub/flathub) with "Copy the master branch only" unchecked, branch from `new-pr`, add the files, and open the pull request against `new-pr`, titled "Add io.github.pratyay_ops.FXM", with Flathub's template filled in by hand.
9. **After the merge**: Flathub creates `flathub/io.github.pratyay_ops.FXM` and invites the owner (2FA required); each release is then a pull request there.

## Sources

Read 2026-10-26: Flathub's [Requirements](https://docs.flathub.org/docs/for-app-authors/requirements) (including the Generative AI policy), [Submission](https://docs.flathub.org/docs/for-app-authors/submission), [MetaInfo guidelines](https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines/), [Runtimes](https://docs.flathub.org/docs/for-app-authors/runtimes) and [Linter](https://docs.flathub.org/docs/for-app-authors/linter); GNOME's [release calendar](https://release.gnome.org/calendar/); [gnome-build-meta](https://gitlab.gnome.org/GNOME/gnome-build-meta) (`gnome-51`); freedesktop-sdk 26.08's `platform.bst`; the README of [flatpak-builder-tools' Node generator](https://github.com/flatpak/flatpak-builder-tools/tree/master/node); Tauri's [Flathub guide](https://v2.tauri.app/distribute/flatpak/) and its `tauri-utils` resource-directory code (Linux looks next to the binary, in `../lib/<productName>`); WebKitGTK's `ApplicationGLib.cpp` and `MediaSessionGLib.cpp`.
