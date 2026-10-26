import { parseManifest, type StoredPlugin } from '@fxm/plugins'
import {
  TEST_CATALOG_HOST,
  TEST_MEDIA_HOST,
  TEST_PLUGIN_CODE,
  testPluginFile,
  testPluginManifest,
} from '@fxm/plugins/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { usePluginsSettingsStore } from './plugins-store'
import { resetPluginTestRuntime, setupPluginTestRuntime } from './testing'

const ADDRESS = 'https://plugins.example.org/test-catalog.fxmplugin.json'

afterEach(() => {
  resetPluginTestRuntime()
})

function stored(overrides: Partial<StoredPlugin> = {}): StoredPlugin {
  return {
    id: 'test-catalog',
    manifest: parseManifest(testPluginManifest()),
    code: TEST_PLUGIN_CODE,
    origin: { kind: 'url', url: ADDRESS },
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function pluginsSection() {
  return screen.findByRole('region', { name: 'Plugins' })
}

function pluginFile(text: string, name = 'test-catalog.fxmplugin.json') {
  return new File([text], name, { type: 'application/json' })
}

describe('Settings → Plugins', () => {
  it('starts with no plugins and offers adding one from an address or a file', async () => {
    setupPluginTestRuntime()
    renderApp('/settings')
    const section = await pluginsSection()
    expect(section).toHaveTextContent(/FXM comes with none and suggests none/)
    expect(within(section).getByRole('button', { name: 'Add from an address' })).toBeVisible()
    expect(within(section).getByRole('button', { name: 'Add from a file' })).toBeVisible()
    expect(within(section).queryByRole('list')).not.toBeInTheDocument()
  })

  it('adds a plugin from a file only after showing what it may contact', async () => {
    const { store, sources } = setupPluginTestRuntime()
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    await user.upload(within(section).getByTestId('plugin-file'), pluginFile(testPluginFile()))

    const dialog = await screen.findByRole('dialog', { name: 'Add Test Catalog?' })
    expect(dialog).toHaveTextContent('It can contact only these addresses:')
    expect(within(dialog).getByText(TEST_CATALOG_HOST)).toBeVisible()
    expect(within(dialog).getByText(TEST_MEDIA_HOST)).toBeVisible()
    // Only what this version of FXM uses counts as what it adds; the rest is named as unused.
    expect(dialog).toHaveTextContent(
      'It adds search, albums, artists, playlists and audio for its songs. It also offers search suggestions, song details, radio and audio for songs from other sources, which this version of FXM doesn’t use.',
    )
    expect(dialog).toHaveTextContent('At most 120 requests an hour. Needs FXM 0.1.0 or later.')
    expect(dialog).toHaveTextContent('From the file test-catalog.fxmplugin.json')
    expect(dialog).toHaveTextContent(/Add only plugins from people you trust/)
    // Nothing is installed before the user says so.
    expect(await store.list()).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Add plugin' }))

    expect(await within(section).findByText('Test Catalog 1.0.0')).toBeVisible()
    expect(within(section).getByRole('switch', { name: 'Test Catalog 1.0.0' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(await screen.findByText('Added Test Catalog')).toBeInTheDocument()
    expect(await store.list()).toHaveLength(1)
    expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(true)
  })

  it('installs nothing when the user cancels', async () => {
    const { store } = setupPluginTestRuntime()
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    await user.upload(within(section).getByTestId('plugin-file'), pluginFile(testPluginFile()))
    const dialog = await screen.findByRole('dialog', { name: 'Add Test Catalog?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await store.list()).toEqual([])
  })

  it('says why a file can’t be added', async () => {
    setupPluginTestRuntime()
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    const tampered = testPluginFile({}, `${TEST_PLUGIN_CODE}\n// changed`).replace(
      /"sha256": "[0-9a-f]+"/u,
      `"sha256": "${'0'.repeat(64)}"`,
    )
    await user.upload(within(section).getByTestId('plugin-file'), pluginFile(tampered))
    expect(
      await screen.findByText(/isn’t the code its manifest declares, so FXM won’t run it/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('adds a plugin from an address, and keeps a failure in the dialog', async () => {
    const { site } = setupPluginTestRuntime()
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    await user.click(within(section).getByRole('button', { name: 'Add from an address' }))
    const ask = await screen.findByRole('dialog', { name: 'Add a plugin from an address' })
    await user.type(within(ask).getByRole('textbox', { name: 'Address' }), ADDRESS)
    await user.click(within(ask).getByRole('button', { name: 'Continue' }))
    expect(await within(ask).findByRole('alert')).toHaveTextContent(
      /plugins\.example\.org answered 404 for the plugin\. Check the address/,
    )

    site.serve(ADDRESS, testPluginFile())
    await user.click(within(ask).getByRole('button', { name: 'Continue' }))
    const offer = await screen.findByRole('dialog', { name: 'Add Test Catalog?' })
    expect(offer).toHaveTextContent(`From ${ADDRESS}`)
    await user.click(within(offer).getByRole('button', { name: 'Add plugin' }))
    expect(await within(section).findByText(`From ${ADDRESS}.`)).toBeVisible()
  })

  it('checks for an update when asked, and installs it only once approved', async () => {
    const { site } = setupPluginTestRuntime({ initial: [stored()] })
    site.serve(ADDRESS, testPluginFile())
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    const check = await within(section).findByRole('button', {
      name: 'Check for an update of Test Catalog',
    })
    await user.click(check)
    expect(await screen.findByText('Test Catalog 1.0.0 is up to date')).toBeInTheDocument()

    const code = `${TEST_PLUGIN_CODE}\n// 1.1.0`
    site.serve(
      ADDRESS,
      testPluginFile({ version: '1.1.0', hosts: [TEST_CATALOG_HOST, 'images.example.org'] }, code),
    )
    await user.click(check)
    let dialog = await screen.findByRole('dialog', { name: 'Update Test Catalog to 1.1.0?' })
    expect(dialog).toHaveTextContent('Replaces version 1.0.0 · by FXM tests')
    expect(within(dialog).getByText('images.example.org').parentElement).toHaveTextContent('New')
    expect(dialog).toHaveTextContent(`No longer contacts ${TEST_MEDIA_HOST}.`)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(section).getByText('Test Catalog 1.0.0')).toBeVisible()

    await user.click(check)
    dialog = await screen.findByRole('dialog', { name: 'Update Test Catalog to 1.1.0?' })
    await user.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(await within(section).findByText('Test Catalog 1.1.0')).toBeVisible()
    expect(await screen.findByText('Updated Test Catalog to 1.1.0')).toBeInTheDocument()
  })

  it('warns when an update comes from another address or another author', async () => {
    const { site } = setupPluginTestRuntime({ initial: [stored()] })
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    await within(section).findByText('Test Catalog 1.0.0')
    const code = `${TEST_PLUGIN_CODE}\n// 2.0.0`
    await user.upload(
      within(section).getByTestId('plugin-file'),
      pluginFile(testPluginFile({ version: '2.0.0', author: 'Someone Else' }, code), 'new.json'),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Update Test Catalog to 2.0.0?' })
    expect(dialog).toHaveTextContent(
      `The installed version came from ${ADDRESS}, not from here. Make sure this update comes from the same author.`,
    )
    expect(dialog).toHaveTextContent(
      'The installed version is by FXM tests; this one is by Someone Else.',
    )
    expect(site.asked).toEqual([])
  })

  it('switches a plugin off and removes it', async () => {
    const { store, sources } = setupPluginTestRuntime({ initial: [stored()] })
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    const toggle = await within(section).findByRole('switch', { name: 'Test Catalog 1.0.0' })
    await waitFor(() =>
      expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(true),
    )
    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect((await store.list())[0]?.enabled).toBe(false)
    expect(sources.getSnapshot().providers.has('plugin.test-catalog')).toBe(false)

    await user.click(within(section).getByRole('button', { name: 'Remove Test Catalog' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Test Catalog?' })
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(section).queryByRole('list')).not.toBeInTheDocument())
    expect(await store.list()).toEqual([])
  })

  it('shows a stored copy that fails its checks, with no switch, so it can be removed', async () => {
    setupPluginTestRuntime({ initial: [stored({ code: `${TEST_PLUGIN_CODE} ` })] })
    renderApp('/settings')
    const section = await pluginsSection()
    expect(await within(section).findByText(/Its stored copy is damaged/)).toBeVisible()
    expect(within(section).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Remove Test Catalog' })).toBeVisible()
  })

  it('says which FXM a plugin needs when this one is too old to run it', async () => {
    const manifest = parseManifest(testPluginManifest({ minFxmVersion: '9.0.0' }))
    setupPluginTestRuntime({ initial: [stored({ manifest })], appVersion: '1.0.0' })
    renderApp('/settings')
    const section = await pluginsSection()
    expect(
      await within(section).findByText(
        'It needs FXM 9.0.0 or later, and this is FXM 1.0.0. Update FXM, or add a version of the plugin that runs on this one.',
      ),
    ).toBeVisible()
    expect(within(section).getByText('Test Catalog 1.0.0')).toBeVisible()
    expect(within(section).queryByRole('switch')).not.toBeInTheDocument()
  })

  it('in an F-Droid build, asks first with equal choices, and runs nothing until then', async () => {
    const { sources } = setupPluginTestRuntime({ initial: [stored()], distribution: 'fdroid' })
    const { user } = renderApp('/settings')
    const section = await pluginsSection()
    const optIn = within(section).getByRole('group', { name: 'Turn on plugins?' })
    expect(optIn).toHaveTextContent(/you choose to bypass F-Droid’s checks/)
    const accept = within(optIn).getByRole('button', { name: 'Turn on' })
    const decline = within(optIn).getByRole('button', { name: 'Not now' })
    expect(accept.className).toBe(decline.className)
    expect(within(section).queryByRole('button', { name: 'Add from a file' })).toBeNull()
    expect(sources.getSnapshot().providers.size).toBe(0)

    await user.click(decline)
    expect(within(section).getByText('Off.')).toBeVisible()
    expect(usePluginsSettingsStore.getState().optedIn).toBe(false)
    await user.click(within(section).getByRole('button', { name: 'Turn on plugins…' }))
    await user.click(within(section).getByRole('button', { name: 'Turn on' }))

    expect(usePluginsSettingsStore.getState().optedIn).toBe(true)
    expect(await within(section).findByText('Test Catalog 1.0.0')).toBeVisible()
    await waitFor(() => expect(sources.getSnapshot().providers.size).toBe(1))
    const setting = within(section).getByRole('switch', {
      name: 'Plugins (bypasses F-Droid’s checks)',
    })
    await user.click(setting)
    expect(usePluginsSettingsStore.getState().optedIn).toBe(false)
    expect(sources.getSnapshot().providers.size).toBe(0)
    expect(within(section).getByRole('group', { name: 'Turn on plugins?' })).toBeVisible()
  })

  it('says plugins come later in the desktop and Android apps', async () => {
    setupPluginTestRuntime({ environment: 'tauri' })
    renderApp('/settings')
    const section = await pluginsSection()
    expect(section).toHaveTextContent(
      'Plugins work in the web app for now. The desktop and Android apps get them in a later version.',
    )
    expect(within(section).queryByRole('button')).toBeNull()
  })
})
