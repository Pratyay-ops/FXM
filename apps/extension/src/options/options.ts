// Options page: version, allowed FXM origins and the Spotify login toggles. The toggles live in
// IndexedDB in the extension's own origin, out of content scripts' reach (see settings.ts). In
// Firefox, turning the login on also asks for Firefox's consent (see consent.ts). The
// development build's own parts (its badge and warning, and the localhost toggle) are only in
// its options.html: the release build drops them (data-dev, scripts/options-page.ts).
import { DEV_BUILD, ORIGINS } from '../build-info.ts'
import { loginConsent } from '../consent.ts'
import {
  DEFAULT_SETTINGS,
  indexedDbSettings,
  SETTINGS_CHANNEL,
  type Settings,
} from '../settings.ts'
import { webExtApi } from '../webext.ts'

const api = webExtApi()
const settings = indexedDbSettings(indexedDB)
const consent = loginConsent(api)
// Tells other open options pages that the settings changed.
const channel = new BroadcastChannel(SETTINGS_CHANNEL)

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const node = document.getElementById(id)
  if (!(node instanceof type)) throw new Error(`options.html is missing #${id}`)
  return node
}

const status = byId('status', HTMLElement)

function showStatus(text: string, error = false): void {
  status.textContent = text
  status.classList.toggle('error', error)
}

byId('version', HTMLElement).textContent = api.runtime.getManifest().version
byId('spotify-consent-help', HTMLElement).hidden = !consent.needed
byId('youtube-music-consent-help', HTMLElement).hidden = !consent.needed

const list = byId('origins', HTMLUListElement)
for (const origin of ORIGINS) {
  const item = document.createElement('li')
  const code = document.createElement('code')
  code.textContent = origin
  item.append(code)
  list.append(item)
}

/** A checkbox and the setting it holds. */
interface Toggle {
  input: HTMLInputElement
  key: keyof Settings
  /** What to announce once a change is saved. */
  saved: (on: boolean) => string
}

/**
 * Shows the development build's own parts of the page and returns its localhost toggle. Only the
 * development build calls it: the release build's page has none of these elements.
 */
function developmentParts(): Toggle[] {
  byId('dev-badge', HTMLElement).hidden = false
  byId('dev-warning', HTMLElement).hidden = false
  byId('localhost-login', HTMLElement).hidden = false
  return [
    {
      input: byId('spotify-login-localhost', HTMLInputElement),
      key: 'spotifyLoginLocalhost',
      saved: (on) =>
        on
          ? 'Saved. Localhost pages can now use your Spotify login.'
          : 'Saved. Localhost pages can no longer use your Spotify login.',
    },
  ]
}

const toggles: Toggle[] = [
  {
    input: byId('spotify-login', HTMLInputElement),
    key: 'spotifyLogin',
    saved: (on) =>
      on
        ? 'Saved. FXM can now use your Spotify login from this browser.'
        : 'Saved. FXM can no longer use your Spotify login.',
  },
  {
    input: byId('youtube-music-login', HTMLInputElement),
    key: 'youtubeMusicLogin',
    saved: (on) =>
      on
        ? 'Saved. FXM Connect can now read your YouTube Music library in this browser.'
        : 'Saved. FXM Connect can no longer read your YouTube Music library.',
  },
  ...(DEV_BUILD ? developmentParts() : []),
]

/** Firefox asks for consent before the login goes on. True where no consent is needed. */
async function consentFor(key: keyof Settings, enabled: boolean): Promise<boolean> {
  if (!enabled) return true
  try {
    if (key === 'youtubeMusicLogin') {
      // Cookies are an optional API permission, requested only in response to this user action.
      // Combine it with Firefox's authenticationInfo consent in the same permission request.
      return (
        (await api.permissions?.request({
          permissions: ['cookies'],
          ...(consent.needed ? { data_collection: ['authenticationInfo'] } : {}),
        })) === true
      )
    }
    if (key === 'spotifyLogin') {
      // Called directly from the click handler: Firefox only asks during the action that started it.
      return await consent.request()
    }
    return true
  } catch {
    return false
  }
}

for (const { input, key, saved } of toggles) {
  input.addEventListener('change', async () => {
    const enabled = input.checked
    if (!(await consentFor(key, enabled))) {
      input.checked = false
      showStatus(
        key === 'youtubeMusicLogin'
          ? "FXM Connect didn't get the required permission, so it can't read your YouTube Music library."
          : "Firefox didn't get your consent, so FXM can't use your Spotify login.",
        true,
      )
      return
    }
    try {
      await settings.write({ [key]: enabled })
      channel.postMessage('changed')
      showStatus(saved(enabled))
    } catch {
      input.checked = !enabled
      showStatus('Could not save the setting. Please try again.', true)
      return
    }
    if (key === 'youtubeMusicLogin' && !enabled) {
      await api.permissions?.remove({ permissions: ['cookies'] }).catch(() => {})
    }
    if (!enabled && (key === 'spotifyLogin' || key === 'youtubeMusicLogin')) {
      const latest = await settings.read().catch(() => DEFAULT_SETTINGS)
      if (!latest.spotifyLogin && !latest.youtubeMusicLogin) {
        await consent.release().catch(() => {})
      }
    }
  })
}

async function load(): Promise<void> {
  try {
    const current = await settings.read()
    // In Firefox the login is on only with the consent, which the user can withdraw elsewhere.
    const consented = await consent.granted().catch(() => false)
    const cookiesGranted = await api.permissions
      ?.contains({ permissions: ['cookies'] })
      .catch(() => false)
    for (const { input, key } of toggles) {
      input.checked =
        current[key] &&
        ((key !== 'spotifyLogin' && key !== 'youtubeMusicLogin') || consented) &&
        (key !== 'youtubeMusicLogin' || cookiesGranted === true)
    }
  } catch {
    showStatus('Could not read the settings.', true)
  } finally {
    for (const { input } of toggles) input.disabled = false
  }
}

// Another options page saved a change. The message carries no data: read the settings again.
channel.addEventListener('message', () => {
  void load()
})

void load()
