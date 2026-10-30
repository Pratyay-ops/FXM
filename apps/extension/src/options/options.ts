// Options page: version, allowed FXM origins and the optional Spotify / YouTube Music account
// bridges. Settings live in extension-owned IndexedDB; cookie access is separately granted only
// when the user enables YouTube Music. Firefox asks for authentication-information consent.
import { DEV_BUILD, ORIGINS } from '../build-info.ts'
import { loginConsent } from '../consent.ts'
import { indexedDbSettings, SETTINGS_CHANNEL, type Settings } from '../settings.ts'
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
        ? 'Saved. FXM can now read your YouTube Music library from this browser.'
        : 'Saved. FXM can no longer read your YouTube Music library.',
  },
  ...(DEV_BUILD ? developmentParts() : []),
]

/**
 * Starts every required permission prompt synchronously inside the checkbox gesture. The YouTube
 * Music cookie permission is optional and separately revocable; Firefox's authenticationInfo
 * consent is shared by the two account bridges and is released only when both are off.
 */
function authorizeToggle(key: keyof Settings, enabled: boolean): Promise<boolean> {
  if (!enabled) return Promise.resolve(true)
  const needsConsent = key === 'spotifyLogin' || key === 'youtubeMusicLogin'
  const consentRequest = needsConsent ? consent.request() : Promise.resolve(true)
  const cookieRequest =
    key === 'youtubeMusicLogin'
      ? (api.permissions?.request({ permissions: ['cookies'] }) ?? Promise.resolve(false))
      : Promise.resolve(true)
  return Promise.all([consentRequest, cookieRequest]).then(([consented, cookies]) => consented && cookies)
}

for (const { input, key, saved } of toggles) {
  input.addEventListener('change', async () => {
    const enabled = input.checked
    if (!(await authorizeToggle(key, enabled))) {
      input.checked = false
      showStatus(
        key === 'youtubeMusicLogin'
          ? "FXM Connect needs the optional cookies permission and Firefox's authentication-information consent to read YouTube Music."
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
    if (key === 'spotifyLogin' || key === 'youtubeMusicLogin') {
      const current = await settings.read().catch(() => undefined)
      if (current && !current.spotifyLogin && !current.youtubeMusicLogin) {
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
    const hasCookies = await api.permissions?.contains({ permissions: ['cookies'] }).catch(() => false) ?? false
    for (const { input, key } of toggles) {
      const needsConsent = key === 'spotifyLogin' || key === 'youtubeMusicLogin'
      const hasRequiredPermissions =
        (key !== 'youtubeMusicLogin' || hasCookies) && (!needsConsent || consented)
      input.checked = current[key] && hasRequiredPermissions
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
