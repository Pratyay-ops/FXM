import { CODE_UPDATES_CONSENT } from '@fxm/platform'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { asksForYouTubeUpdates, YouTubeUpdatesSetting } from './youtube-updates-setting'
import {
  createYouTubeUpdatesStore,
  sanitizeYouTubeUpdates,
  YOUTUBE_UPDATES_STORAGE_KEY,
} from './youtube-updates-store'

/** The setting as an F-Droid build of the Android app shows it, with a store of its own. */
function renderFdroidSetting() {
  const store = createYouTubeUpdatesStore({ storage: () => undefined })
  const user = userEvent.setup()
  render(<YouTubeUpdatesSetting distribution="fdroid" environment="capacitor" store={store} />)
  return { store, user }
}

describe('the YouTube updates setting', () => {
  it('shows only in F-Droid builds of the apps that load code', () => {
    expect(asksForYouTubeUpdates('fdroid', 'capacitor')).toBe(true)
    expect(asksForYouTubeUpdates('fdroid', 'tauri')).toBe(true)
    expect(asksForYouTubeUpdates('fdroid', 'browser')).toBe(false)
    expect(asksForYouTubeUpdates('standard', 'capacitor')).toBe(false)
    const { container } = render(
      <YouTubeUpdatesSetting distribution="standard" environment="capacitor" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('asks first, with F-Droid’s words and two equal answers, neither chosen', () => {
    renderFdroidSetting()
    const optIn = screen.getByRole('group', { name: CODE_UPDATES_CONSENT.title })
    expect(optIn).toHaveTextContent(/you choose to bypass F-Droid’s checks/)
    expect(optIn).toHaveTextContent(/does not come from F-Droid/)
    expect(optIn).toHaveTextContent(/turn it off again at any time/)
    const accept = within(optIn).getByRole('button', { name: 'Turn on' })
    const decline = within(optIn).getByRole('button', { name: 'Not now' })
    // Declining is no harder than accepting: the same style, and focus on neither.
    expect(accept.className).toBe(decline.className)
    expect(document.activeElement).not.toBe(accept)
    expect(document.activeElement).not.toBe(decline)
  })

  it('turns the updates on, then off again from a switch that names F-Droid’s checks', async () => {
    const { store, user } = renderFdroidSetting()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(store.getState().optedIn).toBe(true)
    const toggle = screen.getByRole('switch', { name: CODE_UPDATES_CONSENT.setting })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/They come from FXM, not from F-Droid/)

    await user.click(toggle)
    expect(store.getState().optedIn).toBe(false)
    expect(screen.getByRole('group', { name: CODE_UPDATES_CONSENT.title })).toBeInTheDocument()
  })

  it('stays off after “Not now”, and offers the question again', async () => {
    const { store, user } = renderFdroidSetting()
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(store.getState().optedIn).toBe(false)
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    const again = screen.getByRole('button', { name: 'Turn on…' })
    expect(again).toHaveAccessibleDescription(/F-Droid’s next update brings newer code/)
    await user.click(again)
    expect(screen.getByRole('group', { name: CODE_UPDATES_CONSENT.title })).toBeInTheDocument()
  })

  it('keeps the answer, and trusts only `true` from storage', () => {
    const storage = new Map<string, string>()
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } as unknown as Storage
    createYouTubeUpdatesStore({ storage: () => fake })
      .getState()
      .setOptedIn(true)
    expect(JSON.parse(storage.get(YOUTUBE_UPDATES_STORAGE_KEY) ?? 'null')).toMatchObject({
      state: { optedIn: true },
    })
    expect(sanitizeYouTubeUpdates({ optedIn: 'yes' })).toEqual({ optedIn: false })
    expect(sanitizeYouTubeUpdates(null)).toEqual({ optedIn: false })
  })

  it('is not in the settings of the standard builds', async () => {
    renderApp('/settings')
    const sources = await screen.findByRole('region', { name: 'Sources' })
    expect(sources).not.toHaveTextContent(/YouTube fixes/)
  })
})
