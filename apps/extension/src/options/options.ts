// Options page: version, allowed FXM origins and the Spotify login toggle. The toggle lives in
// IndexedDB in the extension's own origin, out of content scripts' reach (see settings.ts).
import { DEV_BUILD, ORIGINS } from '../build-info.ts'
import { indexedDbSettings, SETTINGS_CHANNEL } from '../settings.ts'
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
    await settings.write({ spotifyLogin: enabled })
    channel.postMessage('changed')
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

async function load(): Promise<void> {
  try {
    toggle.checked = (await settings.read()).spotifyLogin
  } catch {
    showStatus('Could not read the setting.', true)
  } finally {
    toggle.disabled = false
  }
}

// Another options page saved a change. The message carries no data: read the settings again.
channel.addEventListener('message', () => {
  void load()
})

void load()
