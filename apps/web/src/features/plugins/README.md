# Plugins (`features/plugins`, stage 8.3)

Settings → Plugins, and the app's plugin runtime, on [`@fxm/plugins`](../../../../../packages/plugins/README.md). FXM ships no plugins and suggests none: the user adds one from an address or a file, after seeing what it may contact, and every update waits for their approval.

## What the user gets

| | |
|---|---|
| **Add from an address** | A dialog asks for the address of a manifest (`fxm-plugin.json`) or a plugin file, `https://` only. FXM downloads it through the platform (the address's host is a user host only while it downloads: on the web through the Lite tier's `userhost.html`, so the address must allow any origin and serve the file without a redirect), checks it, and shows the offer. A failure (404, unreachable, a wrong checksum, a plugin that needs a newer FXM) stays in the dialog |
| **Add from a file** | A file input for a plugin file (`.json`); a file that isn't one, or fails its checks, is explained in the app's toast |
| **The offer** | "Add Test Catalog?" or "Update Test Catalog to 1.1.0?": its version and author, its description, every address it can contact (new ones tagged "New" in an update, dropped ones listed), what it adds, its request budget and the FXM it needs, where it came from and its SHA-256, and the warning that it is code from its author, which learns what the user asks of it. An update that comes from another address than the installed version, or names another author, says so: another plugin can take an installed plugin's ID. Cancel is focused first; nothing is installed until "Add plugin" or "Update" |
| **The list** | Each plugin with its version, author, description, what it adds, the addresses it contacts and where it came from; a switch (off: no requests, no document, gone from the search page's sources), "Check for an update" for plugins added from an address, and Remove (confirmed). A plugin that can't run has no switch and says why, worded from its problem's code (`problemText`): a damaged stored copy ("remove it, or add it again"), or one that needs a newer FXM ("It needs FXM 9.0.0 or later, and this is FXM 1.0.0…"). Adding any version of it again repairs it |
| **F-Droid builds** | Plugins stay off, and nothing above shows, until the user answers `PLUGINS_CONSENT` ("Turn on plugins?", with the words F-Droid's policy requires) with "Turn on"; "Not now" leaves them off, with a "Turn on plugins…" button. Once on, "Plugins (bypasses F-Droid’s checks)" turns them off again: every plugin stops, and stays installed |
| **Desktop and Android apps** | "Plugins work in the web app for now. The desktop and Android apps get them in a later version." (see Pending) |

Confirmations ("Added Test Catalog", "Test Catalog 1.0.0 is up to date") show in the app's toast.

## How it works

- **`runtime.ts`**: the app's `PluginRegistry`, created on first use: plugins in the `fxm-plugins` IndexedDB database (`plugins-db.ts`, outside library backups, so restoring a backup never installs code), each run in a worker of a sandboxed evaluator document of its own (`isolatedSandboxes(() => createSandboxEvaluator())`; see `@fxm/plugins`' [Where plugins run](../../../../../packages/plugins/README.md#where-plugins-run)), request budgets in `localStorage`. `startPlugins()` (from `main.tsx`, after the first render) loads it and registers the catalog of every plugin that is on with `appSources`, keeping that in step as plugins change; it does nothing where plugins can't run or, in an F-Droid build, before the opt-in. `stopPlugins()` stops everything.
- **`user-hosts.ts`**: `getAppPlatform()` adds `pluginUserHosts` to the platform's user hosts, after the Spotify secret's that the composition root hands it (`setAppUserHosts`): the hosts of the plugins that are on and of a download in progress. The module is tiny, so the platform's chunk doesn't load the plugin system.
- **`distribution.ts`**: the build's distribution, from `VITE_FXM_DISTRIBUTION` (stage R.3's F-Droid build sets `fdroid`). A value `parseDistribution` doesn't know counts as `fdroid`, which asks first.
- **`plugins-store.ts`**: the F-Droid opt-in, under `fxm.plugins.v1`.
- **Tabs**: a tab that installs, updates, switches or removes a plugin announces it on the `fxm-plugins` `BroadcastChannel`; the others read the store again.
- **Audio**: the composition root (`app/services/index.ts`) calls `connectPluginAudio(lifecycle)`, which adds the resolver of every plugin that is on to the app's stream lifecycle (`addSource`, with 2.3's `fromAudioSource`) and takes it out when the plugin is switched off, updated or removed, so a plugin's songs play through its own `resolve`. `pluginRecommendations()` gives their radio.

| File | What |
|---|---|
| `plugins-settings.tsx` | The section: the opt-in, the explanation, the add buttons and the list |
| `plugin-dialogs.tsx` | The offer, the address dialog and the removal confirmation |
| `plugin-text.ts` | Words: operations, origins, checksums, failures |
| `runtime.ts`, `user-hosts.ts`, `distribution.ts`, `plugins-db.ts`, `plugins-store.ts` | Above |
| `testing.ts` | The runtime with an in-memory store, `inProcessSandboxes()` of `@fxm/plugins/testing` (in-process evaluators whose plugin workers run in fresh realms), a fake site and fresh sources, for tests |

## Pending

- **Matching and radio.** A plugin's `match` (audio for tracks of other sources) and `pluginRecommendations()` aren't used yet: the matching engine and the radio take their sources from the composition root, which would follow the plugin registry as it does for the lifecycle, calling them only as their `requestPolicy: 'explicit'` allows (for a track or a radio the user asked that plugin for).
- **Desktop and Android.** `pluginSupport` is `pending` there: the evaluator plugins of 1.11 open one document at a time, and the native networking reaches user hosts only after the user approves each in a native dialog. What wiring them takes is in `@fxm/plugins`' [Pending](../../../../../packages/plugins/README.md#pending): an evaluator owner shared with 1.11's rungs, the worker isolation checked in those webviews, native user-host fetches that refuse the user's own network, and asking `createDesktopUserHosts().approve` or `createAndroidHttp().approveHosts` about a plugin's hosts (and a download's) when it is added.
- **Safari.** Plugins don't run in Safari, whose engine starts no worker in the evaluator document: a plugin's calls fail with "Plugins can’t run in this browser" (see `@fxm/plugins`' [Pending](../../../../../packages/plugins/README.md#pending)). The section could say so before the user adds one, once there is a cheap check for it.
- **Names in the source switch.** The search page labels a plugin source by its ID (`sourceLabel`), not by the manifest's `name`.
