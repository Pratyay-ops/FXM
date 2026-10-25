import { FxmError } from '@fxm/core'
import { testStream, testTrack } from '@fxm/player/testing'
import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestPlayback, spotifyTrack, testCandidate } from './testing'

/** The track column of Now playing (the player bar repeats some controls). */
const trackRegion = () => within(screen.getByRole('region', { name: 'Track' }))

/** Renders Now playing and waits for its lazily loaded page. */
async function renderNowPlaying(path = '/now-playing') {
  const rendered = renderApp(path)
  await screen.findByRole('heading', { level: 1, name: 'Now playing' })
  return rendered
}

describe('now playing', () => {
  it('says nothing is playing, with the controls off, while the queue is empty', async () => {
    setupTestPlayback()
    await renderNowPlaying()

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Nothing playing' }),
    ).toBeInTheDocument()
    expect(trackRegion().getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(trackRegion().getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(trackRegion().getByRole('slider', { name: 'Seek' })).toBeDisabled()
  })

  it('shows the track that plays, with a stream badge that opens the stream details', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue([
      testTrack('Creep', { artists: [{ name: 'Radiohead' }, { name: 'Guest' }] }),
    ])
    const { user } = await renderNowPlaying()

    expect(await screen.findByRole('heading', { level: 2, name: 'Creep' })).toBeInTheDocument()
    expect(trackRegion().getByText('Radiohead, Guest')).toBeInTheDocument()
    expect(trackRegion().getByRole('button', { name: 'Pause' })).toBeEnabled()
    const badge = trackRegion().getByRole('button', { name: 'Opus · YouTube Music' })
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(trackRegion().getByText('Opus, 160 kbps')).not.toBeVisible()

    await user.click(badge)

    expect(badge).toHaveAttribute('aria-expanded', 'true')
    expect(trackRegion().getByText('Opus, 160 kbps')).toBeVisible()
    // The track plays its own audio: there is no other version to pick.
    expect(trackRegion().queryByText('Not the right version?')).not.toBeInTheDocument()
  })

  it('labels a video by its kind', async () => {
    const { player } = setupTestPlayback()
    // Music mode keeps an official video, to play as its song.
    await player.setQueue([testTrack('Video', { kind: 'music-video' })], { autoplay: false })
    await renderNowPlaying()

    expect(trackRegion().getByText('Official video · Video artist')).toBeInTheDocument()
  })

  it('shows how sure a match is, and switches to another version', async () => {
    const { player, policy, resolver } = setupTestPlayback()
    const track = spotifyTrack('Creep')
    const match = testCandidate('match', { title: 'Creep', confidence: 0.93 })
    const acoustic = testCandidate('acoustic', { title: 'Creep (Acoustic)', confidence: 0.71 })
    resolver.handler = (item) => ({
      stream: testStream(item.candidate?.ref ?? 'none'),
      candidate: item.candidate ?? match,
    })
    policy.alternativesOf.set(track.id, [match, acoustic])
    await player.setQueue([track])
    const { user } = await renderNowPlaying()

    expect(await trackRegion().findByText('Matched from Spotify · 0.93')).toBeInTheDocument()
    await user.click(trackRegion().getByRole('button', { name: 'Not the right version?' }))

    const dialog = await screen.findByRole('dialog', { name: 'Choose the right version' })
    expect(within(dialog).getByRole('heading', { name: 'Current version' })).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: /^Use this/ })).toHaveLength(1)
    expect(
      within(dialog).getByRole('link', { name: 'Search for another version' }),
    ).toHaveAttribute('href', '/search?q=Creep+artist+Creep')

    await user.click(within(dialog).getByRole('button', { name: /Creep \(Acoustic\)/ }))

    expect(dialog).not.toHaveAttribute('open')
    await expect.poll(() => resolver.log).toEqual(['Creep:play#0', 'Creep:replace#0'])
    expect(player.getState().queue.items[0]?.candidate).toBe(acoustic)
    expect(policy.pins).toEqual([{ track, candidate: acoustic }])
    expect(await trackRegion().findByText('Matched from Spotify · 0.71')).toBeInTheDocument()
  })

  it('says when no other version is known, and offers a search', async () => {
    const { player, resolver } = setupTestPlayback()
    const track = spotifyTrack('Creep')
    resolver.handler = () => ({ stream: testStream('x'), candidate: testCandidate('match') })
    await player.setQueue([track])
    const { user } = await renderNowPlaying()

    await user.click(await trackRegion().findByRole('button', { name: 'Not the right version?' }))

    const dialog = await screen.findByRole('dialog', { name: 'Choose the right version' })
    expect(await within(dialog).findByText(/No other versions found/)).toBeInTheDocument()
  })

  it('asks whether a best guess is right, and approves it', async () => {
    const { player, policy } = setupTestPlayback()
    const track = spotifyTrack('Creep')
    const guess = testCandidate('guess', { confidence: 0.72 })
    await player.setQueue([track], { autoplay: false })
    act(() => policy.reportNeedsReview(track, guess))
    const { user } = await renderNowPlaying()

    expect(await trackRegion().findByText('Is this the right version?')).toBeInTheDocument()
    await user.click(trackRegion().getByRole('button', { name: 'It’s right' }))

    expect(trackRegion().queryByText('Is this the right version?')).not.toBeInTheDocument()
    expect(policy.pins).toEqual([{ track, candidate: guess }])
    expect(player.getState().queue.items[0]?.candidate).toBe(guess)
  })

  it('says why playback stopped, and tries again', async () => {
    const { player, resolver } = setupTestPlayback()
    resolver.handler = () => {
      throw new FxmError('Unsupported', 'No route to the source')
    }
    await player.setQueue([testTrack('Creep')])
    const { user } = await renderNowPlaying()

    const alert = await trackRegion().findByRole('alert')
    expect(alert).toHaveTextContent('This song can’t play here')

    resolver.handler = (item) => ({ stream: testStream(item.track.title) })
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    await expect.poll(() => player.getState().status).toBe('playing')
    expect(trackRegion().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names the track that couldn’t play', async () => {
    const { player, resolver } = setupTestPlayback()
    resolver.handler = () => {
      throw new FxmError('NotFound', 'Gone')
    }
    await player.setQueue([testTrack('Creep')])
    await renderNowPlaying()

    expect(await trackRegion().findByRole('alert')).toHaveTextContent('Couldn’t play “Creep”')
  })

  it('switches between the lyrics and the queue', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue([testTrack('Creep')], { autoplay: false })
    const { user, router } = await renderNowPlaying()

    await user.click(await screen.findByRole('tab', { name: 'Queue' }))

    expect(router.state.location.search).toBe('?tab=queue')
    expect(screen.getByRole('heading', { name: 'Next up' })).toBeInTheDocument()
  })
})
