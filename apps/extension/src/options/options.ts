// Options page: version, allowed FXM origins, and the Spotify login toggle (storage.local).
import { DEV_BUILD, ORIGINS } from '../build-info.ts'
import { SPOTIFY_LOGIN_KEY } from '../config.ts'
import { readSpotifyLogin, writeSpotifyLogin } from '../settings.ts'
import { webExtApi } from '../webext.ts'

const api = webExtApi()

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const node = document.getElementById(id)
  if (!(node instanceof type)) throw new Error(`options.html is missing #${id}`)
  return node
}

const toggle = byId('spotify-login', HTMLInputElement)
const status = byId('status', HTMLElement)

function showStatus(text: string, error = false): void {
  status.textContent = text
  status.classList.toggle('error', error)
}

byId('version', HTMLElement).textContent = api.runtime.getManifest().version
byId('dev-badge', HTMLElement).hidden = !DEV_BUILD

const list = byId('origins', HTMLUListElement)
for (const origin of ORIGINS) {
  const item = document.createElement('li')
  const code = document.createElement('code')
  code.textContent = origin
  item.append(code)
  list.append(item)
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked
  try {
    await writeSpotifyLogin(api.storage.local, enabled)
    showStatus(
      enabled
        ? 'Saved. FXM can now use your Spotify login from this browser.'
        : 'Saved. FXM can no longer use your Spotify login.',
    )
  } catch {
    toggle.checked = !enabled
    showStatus('Could not save the setting. Please try again.', true)
  }
})

// Keep the checkbox in sync when the setting changes in another options tab.
api.storage.onChanged.addListener((changes, area) => {
  const change = changes[SPOTIFY_LOGIN_KEY]
  if (area === 'local' && change) toggle.checked = change.newValue === true
})

readSpotifyLogin(api.storage.local)
  .then((enabled) => {
    toggle.checked = enabled
  })
  .catch(() => showStatus('Could not read the setting.', true))
  .finally(() => {
    toggle.disabled = false
  })
