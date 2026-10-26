import { act, screen, waitFor, within } from '@testing-library/react'
import { Dexie, type ObservabilitySet, RangeSet } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AFFINITY_MODEL_SETTING } from '../../db/affinity'
import { getLibrary } from '../../db/repo'
import { testRepo, track } from '../../test/library-fixtures'
import { renderApp } from '../../test/render'
import { NOTICE_SPACE_VARIABLE } from '../connect/connect-notice'
import { usePwaStore } from '../pwa/pwa-store'
import { TOAST_SPACE_PROPERTY } from '../pwa/update-toast'
import { showFeedback } from '../search/feedback'
import { useSettingsStore } from '../settings/settings-store'
import { CARDS_HEIGHT_PROPERTY } from '../sponsorblock/sponsorblock-notices'
import { SYNC_TOAST_SPACE_PROPERTY } from './agent'
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

/**
 * Sets sync up with a playlist that another device renamed and synced, while this one renamed it
 * too: the next sync keeps both versions, and the agent's toast says so.
 */
async function renamedOnTwoDevices() {
  const library = getLibrary()
  const mix = await library.createPlaylist({ name: 'Mix' })
  await confirmConnect(await prepareConnect({ token: TOKEN }))
  const gistId = useSyncStore.getState().gistId ?? ''
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
}

/** A custom property the toasts keep on <html>. */
const space = (property: string) => document.documentElement.style.getPropertyValue(property)

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

  it('syncs a change of the synced app settings like an edit', async () => {
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    const reads = gistReads().length
    renderApp('/library')
    await waitFor(() => expect(gistReads().length).toBeGreaterThan(reads))
    await waitFor(() => expect(useSyncStore.getState().syncing).toBe(false))

    const writes = github.writes().length
    useSettingsStore.getState().setTheme('light')
    await waitFor(() => expect(github.writes().length).toBe(writes + 1))
    const gist = github.gists.get(useSyncStore.getState().gistId ?? '')
    expect(gist?.files.get('fxm-library-sync.json')).toContain('"theme":"light"')
  })

  it('stops by itself after a failure only the user can fix, and says so', async () => {
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    github.failNext('GET', '/gists/', 401, { message: 'Bad credentials' })
    renderApp('/library')
    await waitFor(() => expect(useSyncStore.getState().problem?.code).toBe('unauthorized'))
    expect(await screen.findByText(/Sync stopped until you check it/)).toBeInTheDocument()
    const requests = github.requests.length
    await getLibrary().like(track(3))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(github.requests.length).toBe(requests)
  })

  it('stops at once when the gist was made public', async () => {
    await confirmConnect(await prepareConnect({ token: TOKEN }))
    const gist = github.gists.get(useSyncStore.getState().gistId ?? '')
    if (gist !== undefined) gist.public = true
    const writes = github.writes().length
    renderApp('/library')
    expect(await screen.findByText(/Your sync gist is public, so sync stopped/)).toBeInTheDocument()
    await getLibrary().like(track(3))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(github.writes().length).toBe(writes)
  })

  it('says so when a sync kept two versions of a playlist', async () => {
    await renamedOnTwoDevices()
    const { user, router } = renderApp('/library')
    const status = await screen.findByText(/Sync kept two versions of “Theirs”/)
    await user.click(within(status).getByRole('link', { name: 'Review' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(await screen.findByText('Playlists with two versions')).toBeInTheDocument()
  })

  it('stacks its toast with the app’s other toasts above the player, none over another', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(56)
    await renamedOnTwoDevices()
    const { user } = renderApp('/library')
    act(() => usePwaStore.setState({ updateReady: true }))
    const status = await screen.findByText(/Sync kept two versions of “Theirs”/)
    act(() => showFeedback('Added to queue'))

    // Placement is CSS. SponsorBlock's cards, the FXM Connect notice and the update toast sit
    // above the player, each keeping room for what shows above it; this toast rises by that room
    // and keeps room of its own, by which the app's confirmations rise in turn.
    const region = status.closest('[role="status"]')
    for (const below of [
      '--shell-bottom',
      CARDS_HEIGHT_PROPERTY,
      NOTICE_SPACE_VARIABLE,
      TOAST_SPACE_PROPERTY,
    ]) {
      expect(region?.className).toContain(`var(${below}`)
    }
    expect(space(TOAST_SPACE_PROPERTY)).toBe('calc(56px + 0.5rem)')
    expect(space(SYNC_TOAST_SPACE_PROPERTY)).toBe('calc(56px + 0.5rem)')
    const confirmation = screen.getByText('Added to queue').closest('[role="status"]')
    expect(confirmation).not.toBe(region)
    for (const below of [NOTICE_SPACE_VARIABLE, TOAST_SPACE_PROPERTY, SYNC_TOAST_SPACE_PROPERTY]) {
      expect(confirmation?.className).toContain(`var(${below},0px)`)
    }

    // Gone, it keeps no room.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Sync kept two versions/)).not.toBeInTheDocument()
    expect(space(SYNC_TOAST_SPACE_PROPERTY)).toBe('')
  })
})

describe('changeKindOf', () => {
  /** Changed keys, as Dexie reports them. */
  const keys = () => new RangeSet('youtube:track:video0001')

  it('tells edits from background changes of the library', () => {
    expect(changeKindOf({ 'idb://fxm/likes/': keys() })).toBe('edit')
    expect(changeKindOf({ 'idb://fxm/history/playedAt': new RangeSet(1000) })).toBe('background')
    expect(
      changeKindOf({ 'idb://fxm/history/': new RangeSet(7), 'idb://fxm/playlists/': keys() }),
    ).toBe('edit')
    expect(changeKindOf({ 'idb://fxm/importProgress/': keys() })).toBeUndefined()
    expect(changeKindOf({ 'idb://fxm-sync/bases/': keys() })).toBeUndefined()
    // A write that changed nothing, such as a modify that matched no row, names no keys.
    expect(changeKindOf({ 'idb://fxm/likes/': new RangeSet() })).toBeUndefined()
  })

  it('counts only the reserved settings that sync', () => {
    expect(changeKindOf({ 'idb://fxm/settings/': new RangeSet('sync.shared') })).toBe('edit')
    expect(changeKindOf({ 'idb://fxm/settings/:dels': new RangeSet('sync.shared') })).toBe('edit')
    // The library's own settings stay on the device, like the affinity it rebuilds.
    expect(
      changeKindOf({
        'idb://fxm/settings/': new RangeSet(AFFINITY_MODEL_SETTING),
        'idb://fxm/affinity/': new RangeSet('artist|band'),
      }),
    ).toBeUndefined()
    // Clearing the table removes the synced ones too.
    expect(changeKindOf({ 'idb://fxm/settings/': new RangeSet(-Infinity, [[]]) })).toBe('edit')
  })

  it('finds nothing to sync when the library rebuilds the affinity', async () => {
    const library = getLibrary()
    await library.like(track(1))
    const parts: ObservabilitySet[] = []
    const listen = (changed: ObservabilitySet) => {
      parts.push(changed)
    }
    Dexie.on('storagemutated', listen)
    try {
      expect(await library.rebuildAffinity()).toBeGreaterThan(0)
      await waitFor(() => expect(parts.length).toBeGreaterThan(0))
      expect(parts.map((changed) => changeKindOf(changed))).toEqual(parts.map(() => undefined))
    } finally {
      Dexie.on.storagemutated.unsubscribe(listen)
    }
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
