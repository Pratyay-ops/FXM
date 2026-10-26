import type { EntityId } from '@fxm/core'
import { noSkips, type ParsedImport, rowFromTrack } from '@fxm/sources/import'
import { catalogScenario, fakeYouTube } from '@fxm/sources/import/testing'
import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLibrary } from '../../db/repo'
import { setImportLockManager } from './locks'
import { importPath } from './paths'
import { resetImportRunner, startImports } from './runner'
import { type FakeServices, fakeLocks, fakeServices, renderWithServices } from './testing'

afterEach(() => {
  resetImportRunner()
  setImportLockManager(undefined)
})

/** Imports the scenario and waits until the import is done. */
async function importScenario(services: FakeServices, mix: Parameters<typeof catalogScenario>[0]) {
  const scenario = catalogScenario(mix)
  const parsed: ParsedImport = {
    kind: 'spotify',
    label: 'Road trip',
    collections: [{ name: 'Road trip', rows: scenario.tracks.map(rowFromTrack) }],
    plays: [],
    follows: [],
    skipped: noSkips(),
  }
  services.youtube = fakeYouTube({ catalog: scenario.catalog })
  const [id] = (await startImports(parsed, {}, 'music', services)).importIds
  await waitFor(async () =>
    expect((await getLibrary().getImport(id as string))?.status).toBe('done'),
  )
  return { id: id as string, scenario }
}

describe('ImportDetailPage', () => {
  it('shows the match report, and confirms or skips guesses', async () => {
    const services = fakeServices({ autoMatch: () => false })
    const { id, scenario } = await importScenario(services, [
      ['isrc', 2],
      ['no-length', 1],
      ['missing', 1],
    ])
    const { user } = renderWithServices(importPath(id), services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Road trip' })).toBeInTheDocument()
    const totals = (await screen.findByText('Best guesses', { selector: 'dt' })).closest(
      'dl',
    ) as HTMLElement
    expect(within(totals).getByText('Matched', { selector: 'dt' }).nextSibling).toHaveTextContent(
      '0',
    )
    expect(
      within(totals).getByText('Best guesses', { selector: 'dt' }).nextSibling,
    ).toHaveTextContent('3')
    expect(within(totals).getByText('Not found', { selector: 'dt' }).nextSibling).toHaveTextContent(
      '1',
    )
    expect(screen.getByText(/2 songs found by ISRC/u)).toBeInTheDocument()

    const tab = screen.getByRole('tab', { name: 'To review (4)' })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    const first = scenario.tracks[0]
    const firstTitle = first?.title ?? ''
    await user.click(screen.getByRole('button', { name: `Use the chosen song for ${firstTitle}` }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `Skip ${firstTitle}` })).toBeNull(),
    )
    expect(
      await getLibrary().getConfirmedMatch(first?.id as EntityId<'track'>, 'music'),
    ).toMatchObject({
      ref: scenario.expected[0]?.ref,
    })
    const missing = scenario.tracks[3]?.title ?? ''
    expect(screen.getAllByText('Nothing close enough was found.')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: `Skip ${missing}` }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `Skip ${missing}` })).toBeNull(),
    )
    expect(await screen.findByRole('tab', { name: 'To review (2)' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'All songs (4)' }))
    const all = screen.getByRole('tabpanel')
    expect(within(all).getByText('Confirmed')).toBeInTheDocument()
    expect(within(all).getByText('Skipped')).toBeInTheDocument()
  })

  it('confirms every likely match in one tap while Auto matching is off', async () => {
    const services = fakeServices({ autoMatch: () => false })
    const { id } = await importScenario(services, [
      ['isrc', 3],
      ['no-length', 1],
    ])
    const { user } = renderWithServices(importPath(id), services)
    await user.click(await screen.findByRole('button', { name: 'Confirm 3 likely matches' }))
    expect(await screen.findByText('Confirmed 3 matches')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /likely match/u })).not.toBeInTheDocument(),
    )
    expect(await getLibrary().getImport(id)).toMatchObject({ matched: 3, needsReview: 1 })
  })

  it('saves the match report as CSV', async () => {
    const services = fakeServices()
    const { id } = await importScenario(services, [['isrc', 2]])
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob)
      return 'blob:report'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { user } = renderWithServices(importPath(id), services)
    await user.click(await screen.findByRole('button', { name: 'Match report (CSV)' }))
    expect(clicks).toHaveBeenCalledOnce()
    const text = await created[0]?.text()
    expect(text?.split('\r\n')[0]).toMatch(/^Position,Title,Artists/u)
    expect(text?.trim().split('\r\n')).toHaveLength(3)
  })

  it('says when the import no longer exists', async () => {
    renderWithServices(importPath('missing'), fakeServices())
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Import not found' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All imports' })).toHaveAttribute('href', '/import')
  })

  it('names each song to review, and keeps a decision in place with Undo', async () => {
    const services = fakeServices({ autoMatch: () => false })
    const { id, scenario } = await importScenario(services, [
      ['isrc', 2],
      ['no-length', 1],
    ])
    const { user } = renderWithServices(importPath(id), services)
    expect(await screen.findByRole('heading', { level: 2, name: 'Match report' })).toBeVisible()
    const [first, second] = scenario.tracks
    const firstTitle = first?.title ?? ''
    expect(screen.getByRole('heading', { level: 3, name: `1. ${firstTitle}` })).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: `Likely the right song for “${firstTitle}”` }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: `Use the chosen song for ${firstTitle}` }))
    const undo = await screen.findByRole('button', { name: `Undo: ${firstTitle}` })
    expect(screen.getByText(`· Using “${firstTitle}”`)).toBeInTheDocument()
    expect(await screen.findByText(`Using “${firstTitle}” for “${firstTitle}”`)).toBeInTheDocument()
    // On to the next song.
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 3, name: `2. ${second?.title ?? ''}` }),
      ).toHaveFocus(),
    )
    expect(
      await getLibrary().getConfirmedMatch(first?.id as EntityId<'track'>, 'music'),
    ).toBeDefined()

    await user.click(undo)
    const back = await screen.findByRole('heading', { level: 3, name: `1. ${firstTitle}` })
    await waitFor(() => expect(back).toHaveFocus())
    expect(
      await getLibrary().getConfirmedMatch(first?.id as EntityId<'track'>, 'music'),
    ).toBeUndefined()
  })

  it('changes a decision from All songs', async () => {
    const services = fakeServices({ autoMatch: () => false })
    const { id, scenario } = await importScenario(services, [['isrc', 2]])
    const { user } = renderWithServices(importPath(id), services)
    const title = scenario.tracks[0]?.title ?? ''
    await user.click(await screen.findByRole('button', { name: `Skip ${title}` }))
    await screen.findByRole('button', { name: `Undo: ${title}` })
    await user.click(screen.getByRole('tab', { name: 'All songs (2)' }))
    await user.click(await screen.findByRole('button', { name: `Change the song for ${title}` }))
    expect(await screen.findByRole('tab', { name: 'To review (2)' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      await screen.findByRole('button', { name: `Use the chosen song for ${title}` }),
    ).toBeEnabled()
  })

  it('only shows an import another tab is running', async () => {
    const services = fakeServices({ autoMatch: () => false })
    const { id, scenario } = await importScenario(services, [['isrc', 1]])
    await getLibrary().updateImport(id, { status: 'running' })
    setImportLockManager(fakeLocks([id]), 20)
    renderWithServices(importPath(id), services)
    expect(
      await screen.findByText(/Another tab or window is running this import/u),
    ).toBeInTheDocument()
    expect(screen.getByText('Importing in another tab or window')).toBeInTheDocument()
    const title = scenario.tracks[0]?.title ?? ''
    // The review list loads after the notice, so wait for its button.
    expect(
      await screen.findByRole('button', { name: `Use the chosen song for ${title}` }),
    ).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^Resume|^Pause/u })).toBeNull()
  })
})
