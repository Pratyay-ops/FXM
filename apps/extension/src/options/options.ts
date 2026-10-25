// Options page: version, allowed FXM origins and the Spotify login toggles. The toggles live in
// IndexedDB in the extension's own origin, out of content scripts' reach (see settings.ts).
import { DEV_BUILD, ORIGINS } from '../build-info.ts'
import { indexedDbSettings, SETTINGS_CHANNEL, type Settings } from '../settings.ts'
import { webExtApi } from '../webext.ts'

const api = webExtApi()
const settings = indexedDbSettings(indexedDB)
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
byId('dev-badge', HTMLElement).hidden = !DEV_BUILD
byId('dev-warning', HTMLElement).hidden = !DEV_BUILD
byId('localhost-login', HTMLElement).hidden = !DEV_BUILD

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
    input: byId('spotify-login-localhost', HTMLInputElement),
    key: 'spotifyLoginLocalhost',
    saved: (on) =>
      on
        ? 'Saved. Localhost pages can now use your Spotify login.'
        : 'Saved. Localhost pages can no longer use your Spotify login.',
  },
]

for (const { input, key, saved } of toggles) {
  input.addEventListener('change', async () => {
    const enabled = input.checked
    try {
      await settings.write({ [key]: enabled })
      channel.postMessage('changed')
      showStatus(saved(enabled))
    } catch {
      input.checked = !enabled
      showStatus('Could not save the setting. Please try again.', true)
    }
  })
}

async function load(): Promise<void> {
  try {
    const current = await settings.read()
    for (const { input, key } of toggles) input.checked = current[key]
  } catch {
    showStatus('Could not read the settings.', true)
  } finally {
    for (const { input, key } of toggles) {
      // The release build has no localhost pages, so its localhost toggle stays off.
      input.disabled = key === 'spotifyLoginLocalhost' && !DEV_BUILD
    }
  }
}

// Another options page saved a change. The message carries no data: read the settings again.
channel.addEventListener('message', () => {
  void load()
})

void load()
