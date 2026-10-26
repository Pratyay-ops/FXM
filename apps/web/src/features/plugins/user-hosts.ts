/**
 * The hosts plugins may reach, for the app's platform: `getAppPlatform()` adds
 * {@link pluginUserHosts} to its user hosts, after the Spotify secret's, and the platform reads
 * them on every request. So a plugin's requests to its own declared hosts, and the download of a
 * plugin from the address the user entered, go out as user-host requests (on the web through the
 * Lite tier's `userhost.html`: `GET` only, without headers). The plugin runtime (`runtime.ts`)
 * keeps the list current; this module stays tiny, so the platform's chunk doesn't load the plugin
 * system.
 *
 * @module
 */

let source: () => readonly string[] = () => []

/** The hosts the plugins that are on may contact, plus the host of a download in progress. */
export function pluginUserHosts(): readonly string[] {
  try {
    return source()
  } catch {
    return []
  }
}

/** Where {@link pluginUserHosts} reads the hosts from: the plugin registry's `hosts`. */
export function setPluginHostsSource(next: () => readonly string[]): void {
  source = next
}
