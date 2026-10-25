import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { testRepo, track } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { changeKindOf, reportMessage } from './auto-sync'
import { createMemoryBaseStore } from './base-store'
import {
  confirmConnect,
  prepareConnect,
  resetSyncEnvironment,
  setSyncEnvironment,
} from './controller'
import { syncLibrary } from './engine'
import { createGitHubClient } from './github'
import { useSyncStore } from './sync-store'
import { createFakeGitHub, type FakeGitHub } from './testing/fake-github'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

let github: FakeGitHub

beforeEach(() => {
  github = createFakeGitHub({ [TOKEN]: { login: 'octo' } })
  const bases = createMemoryBaseStore()
  setSyncEnvironment({
    fetch: github.fetch,
    bases: () => bases,
    schedule: {
      editDelayMs: 20,
      editMaxWaitMs: 100,
      backgroundDelayMs: 20,
      backgroundMaxWaitMs: 100,
      throttleMs: 0,
    },
  })
})

afterEach(() => {
  resetSyncEnvironment()
  useSyncStore.setState(useSyncStore.getInitialState(), true)
})

const gistReads = () =>
  github.requests.filter(
    (request) => request.method === 'GET' && request.path.startsWith('/gists/'),
  )

describe('SyncAgent', { timeout: 30_000 }, () => {
  it('does nothing while sync is off', async () => {
    renderApp('/library')
    await screen.findByRole('heading', { name: 'Your library' })
    await getLibrary().like(track(1))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(github.requests).toEqual([])
  })

  it('syncs when the app starts, and shortly after an edit', async () => {
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    const reads = gistReads().length
    renderApp('/library')
    await waitFor(() => expect(gistReads().length).toBeGreaterThan(reads))

    const writes = github.writes().length
    await getLibrary().like(track(3))
    await waitFor(() => expect(github.writes().length).toBe(writes + 1))
    expect(useSyncStore.getState().problem).toBeUndefined()
  })

  it('stops by itself after a failure only the user can fix', async () => {
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    github.failNext('GET', '/gists/', 401, { message: 'Bad credentials' })
    renderApp('/library')
    await waitFor(() => expect(useSyncStore.getState().problem?.code).toBe('unauthorized'))
    const requests = github.requests.length
    await getLibrary().like(track(3))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(github.requests.length).toBe(requests)
  })

  it('says so when a sync kept two versions of a playlist', async () => {
    const library = getLibrary()
    const mix = await library.createPlaylist({ name: 'Mix' })
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    const gistId = useSyncStore.getState().gistId ?? ''
    // Another device renames it and syncs; this one renames it too, before syncing.
    const other = {
      repo: testRepo(),
      github: createGitHubClient({ token: TOKEN, fetch: github.fetch }),
      bases: createMemoryBaseStore(),
      login: 'octo',
      appSettings: { read: () => ({}), apply: () => {} },
    }
    await syncLibrary(other, gistId)
    await other.repo.updatePlaylist(mix, { name: 'Theirs' })
    await syncLibrary(other, gistId)
    await library.updatePlaylist(mix, { name: 'Mine' })

    const { user, router } = renderApp('/library')
    const status = await screen.findByText(/Sync kept two versions of “Theirs”/)
    await user.click(within(status).getByRole('link', { name: 'Review' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(await screen.findByText('Playlists with two versions')).toBeInTheDocument()
  })
})

describe('changeKindOf', () => {
  it('tells edits from background changes of the library', () => {
    expect(changeKindOf({ 'idb://fxm/likes/': true } as never)).toBe('edit')
    expect(changeKindOf({ 'idb://fxm/history/playedAt': true } as never)).toBe('background')
    expect(
      changeKindOf({ 'idb://fxm/history/': true, 'idb://fxm/playlists/': true } as never),
    ).toBe('edit')
    expect(changeKindOf({ 'idb://fxm/importProgress/': true } as never)).toBeUndefined()
    expect(changeKindOf({ 'idb://fxm-sync/bases/': true } as never)).toBeUndefined()
  })
})

describe('reportMessage', () => {
  const report = {
    gistId: 'x',
    gistUrl: '',
    created: false,
    pulled: 0,
    pushed: false,
    skipped: 0,
    bytes: 0,
    deferred: false,
  }
  it('names one kept playlist, counts several, and stays quiet otherwise', () => {
    const copy = (name: string) => ({ originalId: 'a', copyId: 'b', name }) as never
    expect(reportMessage({ ...report, copies: [copy('Mix (other version)')], notices: [] })).toBe(
      'Sync kept two versions of “Mix”.',
    )
    expect(reportMessage({ ...report, copies: [copy('A'), copy('B')], notices: [] })).toBe(
      'Sync kept two versions of 2 playlists.',
    )
    expect(
      reportMessage({
        ...report,
        copies: [],
        notices: [{ kind: 'restored', playlistId: 'p', name: 'X' } as never],
      }),
    ).toBe('Sync kept a playlist that one device had deleted.')
    expect(reportMessage({ ...report, copies: [], notices: [] })).toBeUndefined()
  })
})
