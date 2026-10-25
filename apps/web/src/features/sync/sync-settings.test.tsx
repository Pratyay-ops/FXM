import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { testRepo, track } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { createMemoryBaseStore } from './base-store'
import {
  confirmConnect,
  prepareConnect,
  resetSyncEnvironment,
  setSyncEnvironment,
} from './controller'
import { createSyncGist } from './engine'
import { MANIFEST_FILE } from './gist-format'
import { createGitHubClient } from './github'
import { conflictCopyOf } from './merge'
import { SYNC_STORAGE_KEY, useSyncStore } from './sync-store'
import { createFakeGitHub, type FakeGitHub } from './testing/fake-github'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'
const NEW_TOKEN = 'github_pat_22ABCDEFG0123456789_zyxwvutsrqponmlkjihgfedcba'

let github: FakeGitHub

beforeEach(() => {
  github = createFakeGitHub({
    [TOKEN]: { login: 'octo' },
    [NEW_TOKEN]: { login: 'octo' },
    ghp_0123456789abcdefghijABCDEFGHIJ012345: { login: 'octo', scopes: ['gist', 'repo'] },
    github_pat_33OTHER0123456789_abcdefghijklmnopqrstuvwxyz: { login: 'someone' },
  })
  const bases = createMemoryBaseStore()
  setSyncEnvironment({ fetch: github.fetch, bases: () => bases })
})

afterEach(() => {
  resetSyncEnvironment()
  useSyncStore.setState(useSyncStore.getInitialState(), true)
})

const section = async () => {
  const heading = await screen.findByRole('heading', { name: 'Sync' })
  return within(heading.closest('section') as HTMLElement)
}

async function openSetup(user: UserEvent) {
  await user.click(await (await section()).findByRole('button', { name: 'Set up sync' }))
  return within(await screen.findByRole('dialog', { name: 'Sync with GitHub' }))
}

async function pasteToken(user: UserEvent, dialog: ReturnType<typeof within>, token = TOKEN) {
  await user.click(dialog.getByLabelText('2. Paste the token'))
  await user.paste(token)
  await user.click(dialog.getByRole('button', { name: 'Continue' }))
}

/** Sync set up with a new gist, outside the UI. */
async function connected() {
  await confirmConnect(await prepareConnect({ token: TOKEN }))
}

describe('Settings › Sync', { timeout: 30_000 }, () => {
  it('sets sync up with a new secret gist', async () => {
    await getLibrary().createPlaylist({ name: 'Mix' })
    const { user } = renderApp('/settings')
    const dialog = await openSetup(user)
    expect(dialog.getByRole('link', { name: /Create it on GitHub/ })).toHaveAttribute(
      'href',
      expect.stringContaining('gists=write'),
    )

    await pasteToken(user, dialog)
    expect(await dialog.findByText(/Signed in to GitHub as/)).toHaveTextContent('@octo')
    expect(dialog.getByText(/no sync gist on this account yet/)).toBeInTheDocument()
    expect(dialog.getByText('1 playlist · 0 liked songs · 0 follows · 0 plays')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Create the gist and turn on sync' }))

    expect(await (await section()).findByText(/On, with the gist of/)).toHaveTextContent('@octo')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(github.gists.size).toBe(1)
    const [gist] = github.gists.values()
    expect(gist?.public).toBe(false)
    expect([...(gist?.files.values() ?? [])].join()).not.toContain(TOKEN)
    expect(useSyncStore.getState()).toMatchObject({ login: 'octo', gistId: gist?.id })
  })

  it('joins the account’s sync gist and merges this device’s library into it', async () => {
    const other = testRepo()
    await other.createPlaylist({ name: 'From the other device' })
    await createSyncGist({
      repo: other,
      github: createGitHubClient({ token: TOKEN, fetch: github.fetch }),
      bases: createMemoryBaseStore(),
      login: 'octo',
      appSettings: { read: () => ({}), apply: () => {} },
    })
    await getLibrary().createPlaylist({ name: 'Made here' })
    const { user } = renderApp('/settings')
    const dialog = await openSetup(user)
    await pasteToken(user, dialog)

    expect(await dialog.findByText('Your sync gist')).toBeInTheDocument()
    expect(dialog.getByText('On this device')).toBeInTheDocument()
    expect(dialog.getByText(/merges the two and removes nothing/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Merge and turn on sync' }))

    await (await section()).findByText(/On, with the gist of/)
    const names = (await getLibrary().getPlaylistList()).items.map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['From the other device', 'Made here']))
  })

  it('joins a pasted gist when the token can’t list secret gists', async () => {
    const other = testRepo()
    await other.like(track(1))
    const { gistId } = await createSyncGist({
      repo: other,
      github: createGitHubClient({ token: TOKEN, fetch: github.fetch }),
      bases: createMemoryBaseStore(),
      login: 'octo',
      appSettings: { read: () => ({}), apply: () => {} },
    })
    github.listsSecretGists = false
    const { user } = renderApp('/settings')
    const dialog = await openSetup(user)
    await user.click(dialog.getByText('Already syncing on another device?'))
    await user.click(dialog.getByLabelText('Gist link (optional)'))
    await user.paste(`https://gist.github.com/octo/${gistId}`)
    await pasteToken(user, dialog)

    expect(await dialog.findByText(/Your synced library comes to this device/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Turn on sync' }))
    await (await section()).findByText(/On, with the gist of/)
    expect(await getLibrary().isLiked(track(1).id)).toBe(true)
  })

  it('refuses a token that can do more than sync, or one GitHub rejects', async () => {
    const { user } = renderApp('/settings')
    const dialog = await openSetup(user)
    await pasteToken(user, dialog, 'ghp_0123456789abcdefghijABCDEFGHIJ012345')
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      /can do more than FXM needs \(repo\)/,
    )

    await user.clear(dialog.getByLabelText('2. Paste the token'))
    await pasteToken(user, dialog, 'github_pat_99UNKNOWN0123456789_abcdefghijklmnopqrstuvwxyz')
    expect(await dialog.findByRole('alert')).toHaveTextContent(/didn’t accept that token/)

    await user.clear(dialog.getByLabelText('2. Paste the token'))
    await pasteToken(user, dialog, 'not a token')
    expect(await dialog.findByRole('alert')).toHaveTextContent(/doesn’t look like a GitHub token/)
    expect(localStorage.getItem(SYNC_STORAGE_KEY) ?? '').not.toContain('ghp_')
    expect(github.gists.size).toBe(0)
  })

  it('syncs on demand, and turns off on this device without touching the gist', async () => {
    await connected()
    useSyncStore.setState({ auto: false })
    const { user } = renderApp('/settings')
    const sync = await section()
    expect(sync.getByText(/Last synced just now/)).toBeInTheDocument()

    await getLibrary().like(track(5))
    const writes = github.writes().length
    await user.click(sync.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(github.writes().length).toBe(writes + 1))

    await user.click(sync.getByRole('button', { name: 'Turn off sync' }))
    const confirm = within(
      await screen.findByRole('dialog', { name: 'Turn off sync on this device?' }),
    )
    await user.click(confirm.getByRole('button', { name: 'Turn off sync' }))
    expect(await sync.findByRole('button', { name: 'Set up sync' })).toBeInTheDocument()
    expect(localStorage.getItem(SYNC_STORAGE_KEY) ?? '').not.toContain(TOKEN)
    expect(github.gists.size).toBe(1)
  })

  it('lets the user choose between two versions of a playlist', async () => {
    const library = getLibrary()
    const mix = await library.createPlaylist({ name: 'Mix', tracks: [track(1)] })
    await connected()
    useSyncStore.setState({ auto: false })
    const record = (await library.getPlaylistView(mix))?.playlist
    if (record === undefined) throw new Error('missing')
    await library.db.playlists.put(
      conflictCopyOf({ ...record, name: 'Party', trackIds: [track(2).id] }),
    )
    const { user } = renderApp('/settings')
    const sync = await section()

    expect(await sync.findByText('Playlists with two versions')).toBeInTheDocument()
    expect(sync.getByRole('link', { name: 'Party (other version)' })).toBeInTheDocument()
    await user.click(sync.getByRole('button', { name: 'Keep the other version' }))

    await waitFor(() =>
      expect(sync.queryByText('Playlists with two versions')).not.toBeInTheDocument(),
    )
    expect((await library.getPlaylistView(mix))?.playlist).toMatchObject({
      name: 'Party',
      trackIds: [track(2).id],
    })
  })

  it('shows what sync kept, and deletes it on request', async () => {
    const library = getLibrary()
    const mix = await library.createPlaylist({ name: 'Mix' })
    await connected()
    useSyncStore.setState({
      auto: false,
      notices: [{ id: 'n1', kind: 'kept-here', playlistId: mix, name: 'Mix', at: 1 }],
    })
    const { user } = renderApp('/settings')
    const sync = await section()
    expect(
      await sync.findByText(/was deleted on another device, but you changed it here/),
    ).toBeInTheDocument()
    await user.click(sync.getByRole('button', { name: 'Delete it' }))
    await waitFor(() => expect(useSyncStore.getState().notices).toEqual([]))
    expect(await library.getPlaylistView(mix)).toBeUndefined()
  })

  it('asks for a new token when GitHub stops accepting the old one', async () => {
    await connected()
    useSyncStore.setState({ auto: false })
    const { user } = renderApp('/settings')
    const sync = await section()
    github.failNext('GET', '/gists/', 401, { message: 'Bad credentials' })
    await user.click(sync.getByRole('button', { name: 'Sync now' }))
    expect(await sync.findByRole('alert')).toHaveTextContent(/no longer accepts your token/)

    await user.click(sync.getByRole('button', { name: 'Paste a new token' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Paste a new token' }))
    await user.click(dialog.getByLabelText('New token'))
    await user.paste('github_pat_33OTHER0123456789_abcdefghijklmnopqrstuvwxyz')
    await user.click(dialog.getByRole('button', { name: 'Save and sync' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent(/belongs to @someone/)

    await user.clear(dialog.getByLabelText('New token'))
    await user.paste(NEW_TOKEN)
    await user.click(dialog.getByRole('button', { name: 'Save and sync' }))
    await waitFor(() => expect(sync.queryByRole('alert')).not.toBeInTheDocument())
    expect(useSyncStore.getState().token).toBe(NEW_TOKEN)
  })

  it('rewrites a gist that was changed outside FXM', async () => {
    await getLibrary().like(track(1))
    await connected()
    useSyncStore.setState({ auto: false })
    const gistId = useSyncStore.getState().gistId ?? ''
    const manifest = JSON.parse(github.gists.get(gistId)?.files.get(MANIFEST_FILE) ?? '{}')
    github.editGist(gistId, {
      [MANIFEST_FILE]: JSON.stringify({ ...manifest, revision: 'abcdefabcdefabcd' }),
      [manifest.parts[0].file]: 'garbage',
    })
    const { user } = renderApp('/settings')
    const sync = await section()
    await user.click(sync.getByRole('button', { name: 'Sync now' }))
    expect(await sync.findByRole('alert')).toHaveTextContent(/changed outside FXM/)

    await user.click(sync.getByRole('button', { name: 'Rewrite the gist from this device' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Rewrite the gist?' }))
    await user.click(dialog.getByRole('button', { name: 'Rewrite the gist' }))
    await waitFor(() => expect(sync.queryByRole('alert')).not.toBeInTheDocument())
    await user.click(sync.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(useSyncStore.getState().syncing).toBe(false))
    expect(useSyncStore.getState().problem).toBeUndefined()
  })

  it('switches automatic sync off and on', async () => {
    await connected()
    useSyncStore.setState({ auto: true })
    const { user } = renderApp('/settings')
    const toggle = (await section()).getByRole('switch', { name: 'Sync automatically' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(useSyncStore.getState().auto).toBe(false)
  })

  it('offers to set sync up again when the gist is gone', async () => {
    await connected()
    useSyncStore.setState({ auto: false })
    github.gists.clear()
    const { user } = renderApp('/settings')
    const sync = await section()
    await user.click(sync.getByRole('button', { name: 'Sync now' }))
    expect(await sync.findByRole('alert')).toHaveTextContent(/gone from GitHub/)
    await user.click(sync.getByRole('button', { name: 'Set up sync again' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Sync with GitHub' }))
    // The token is filled in already.
    await user.click(dialog.getByRole('button', { name: 'Continue' }))
    await user.click(
      await dialog.findByRole('button', { name: 'Create the gist and turn on sync' }),
    )
    await waitFor(() => expect(sync.queryByRole('alert')).not.toBeInTheDocument())
    expect(github.gists.size).toBe(1)
  })
})
