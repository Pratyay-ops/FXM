import { testTrack } from '@fxm/player/testing'
import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestLyrics, setupTestPlayback } from '../now-playing/testing'
import { appActions, createMediaActionsStore } from '../search/actions'
import { useAudioEffectsStore } from './effects-store'
import { equalizerActions, wireEqualizerActions } from './equalizer-actions'
import { formatMinutes, sleepAnnouncement, sleepStatus, spokenMinutes } from './sound-dialog'
import { useSoundDialogStore } from './sound-dialog-store'

async function openSound() {
  const result = renderApp('/settings')
  await screen.findByRole('heading', { name: 'Settings' })
  act(() => useSoundDialogStore.getState().openDialog())
  const dialog = await screen.findByRole('dialog', { name: 'Sound' })
  return { ...result, dialog }
}

describe('the Sound dialog', () => {
  it('opens from the player bar', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    await user.click(await screen.findByRole('button', { name: 'Sound' }))
    expect(await screen.findByRole('dialog', { name: 'Sound' })).toBeInTheDocument()
  })

  it('starts, starts over and cancels a sleep timer', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    const thirty = within(dialog).getByRole('radio', { name: '30 min' })
    await user.click(thirty)
    const started = useAudioEffectsStore.getState().sleepTimer
    expect(started).toMatchObject({ minutes: 30 })
    expect(within(dialog).getByText(/Pauses in (29:5\d|30:00)/)).toBeInTheDocument()
    expect(thirty).toBeChecked()
    // Picked again: the timer starts over.
    await user.click(thirty)
    expect(useAudioEffectsStore.getState().sleepTimer).not.toBe(started)
    expect(useAudioEffectsStore.getState().sleepTimer).toMatchObject({ minutes: 30 })
    await user.click(within(dialog).getByRole('radio', { name: 'End of track' }))
    expect(useAudioEffectsStore.getState().sleepTimer).toEqual({ endOfTrack: true })
    expect(within(dialog).getByText('Pauses after this track')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'Off' }))
    expect(useAudioEffectsStore.getState().sleepTimer).toBeUndefined()
  })

  it('offers each choice as a radio group, whose arrow keys move and pick', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    const timer = within(dialog).getByRole('radiogroup', { name: 'Sleep timer' })
    const off = within(timer).getByRole('radio', { name: 'Off' })
    expect(off).toBeChecked()
    act(() => off.focus())
    await user.keyboard('{ArrowRight}')
    expect(within(timer).getByRole('radio', { name: '15 min' })).toHaveFocus()
    expect(useAudioEffectsStore.getState().sleepTimer).toMatchObject({ minutes: 15 })
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(within(timer).getByRole('radio', { name: 'End of track' })).toHaveFocus()
    expect(useAudioEffectsStore.getState().sleepTimer).toEqual({ endOfTrack: true })

    const speed = within(dialog).getByRole('radiogroup', { name: 'Speed: 1×' })
    expect(within(speed).getByRole('radio', { name: '1×' })).toBeChecked()
  })

  it('counts down without reading it out, and says each change once', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('radio', { name: '1 h 30 min' }))
    const countdown = within(dialog).getByRole('timer')
    expect(countdown).toHaveTextContent(/Pauses in 1:(29:5\d|30:00)/)
    expect(countdown).not.toHaveAttribute('aria-live')
    const live = dialog.querySelectorAll('[aria-live="polite"]')
    expect([...live].map((region) => region.textContent)).toEqual([
      'Sleep timer on: pauses in 1 hour 30 minutes',
    ])
  })

  it('changes the speed, which the player bar then shows', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('radio', { name: '1.5×' }))
    expect(useAudioEffectsStore.getState().effects.playbackRate).toBe(1.5)
    expect(within(dialog).getByRole('heading', { name: 'Speed: 1.5×' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Sound: 1.5× speed', hidden: true }),
    ).toBeInTheDocument()
  })

  it('switches the equalizer and volume normalization', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('switch', { name: 'Equalizer' }))
    expect(useAudioEffectsStore.getState().effects.equalizer.enabled).toBe(true)
    await user.click(within(dialog).getByRole('switch', { name: 'Normalize volume' }))
    expect(useAudioEffectsStore.getState().effects.loudness.enabled).toBe(false)
    // The bands wait behind their disclosure.
    expect(within(dialog).getByText('Adjust the bands').closest('details')).not.toHaveAttribute(
      'open',
    )
  })

  it('opens at the equalizer from the track menus, its switch focused, its bands shown', async () => {
    setupTestPlayback()
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })
    act(() => equalizerActions.open(testTrack('Creep')))
    const dialog = await screen.findByRole('dialog', { name: 'Sound' })
    expect(within(dialog).getByRole('switch', { name: 'Equalizer' })).toHaveFocus()
    expect(within(dialog).getByText('Adjust the bands').closest('details')).toHaveAttribute('open')
  })

  it('links to Settings, closes, and leaves the focus on Settings → Sound', async () => {
    setupTestPlayback()
    const { user, dialog, router } = await openSound()
    await user.click(within(dialog).getByRole('link', { name: 'More in Settings' }))
    expect(useSoundDialogStore.getState().open).toBe(false)
    expect(router.state.location.hash).toBe('#sound')
    expect(screen.getByRole('heading', { name: 'Sound' })).toHaveFocus()
  })
})

describe('the Sound buttons', () => {
  it('say what differs from normal, and show the speed', async () => {
    setupTestPlayback()
    renderApp('/settings')
    const button = await screen.findByRole('button', { name: 'Sound' })
    act(() => {
      useAudioEffectsStore.getState().setPlaybackRate(1.25)
      useAudioEffectsStore.getState().setEqualizerEnabled(true)
      useAudioEffectsStore.getState().sleepAtEndOfTrack()
    })
    expect(button).toHaveAccessibleName('Sound: 1.25× speed, equalizer on, sleep timer on')
    // The speed beside it is for the eye: the name says it.
    expect(screen.getByText('1.25×', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
  })

  it('show the speed on Now playing’s shortcut, in place of its label', async () => {
    const { player } = setupTestPlayback()
    setupTestLyrics()
    await player.setQueue([testTrack('Creep')], { autoplay: false })
    renderApp('/now-playing')
    const track = within(await screen.findByRole('region', { name: 'Track' }))
    expect(track.getByRole('button', { name: 'Sound' })).toHaveTextContent('Sound')
    act(() => useAudioEffectsStore.getState().setPlaybackRate(1.25))
    const shortcut = track.getByRole('button', { name: 'Sound: 1.25× speed' })
    expect(shortcut).toHaveTextContent('1.25×')
    expect(shortcut).not.toHaveTextContent('Sound')
  })

  it('show the speed in the mini player', async () => {
    const { player } = setupTestPlayback()
    await player.setQueue([testTrack('Creep')], { autoplay: false })
    renderApp('/settings')
    await screen.findByRole('heading', { name: 'Settings' })
    const open = 'Open now playing: Creep by Creep artist'
    // The mini player and the player bar both link to Now playing.
    expect(screen.getAllByRole('link', { name: open }).length).toBeGreaterThan(0)
    act(() => useAudioEffectsStore.getState().setPlaybackRate(0.75))
    expect(screen.getByRole('link', { name: `${open}. Speed 0.75×` })).toHaveTextContent('0.75×')
  })
})

describe('the track menus’ Equalizer', () => {
  it('opens the Sound dialog at the equalizer', () => {
    const store = createMediaActionsStore()
    wireEqualizerActions(store)
    expect(store.get().equalizer).toBe(equalizerActions)
    store.get().equalizer?.open(testTrack('Creep'))
    expect(useSoundDialogStore.getState()).toMatchObject({ open: true, section: 'equalizer' })
    expect(appActions.get().equalizer).toBeUndefined()
  })
})

describe('helpers', () => {
  it('formats minutes and the timer', () => {
    expect(formatMinutes(15)).toBe('15 min')
    expect(formatMinutes(60)).toBe('1 h')
    expect(formatMinutes(90)).toBe('1 h 30 min')
    expect(spokenMinutes(1)).toBe('1 minute')
    expect(spokenMinutes(45)).toBe('45 minutes')
    expect(spokenMinutes(60)).toBe('1 hour')
    expect(spokenMinutes(150)).toBe('2 hours 30 minutes')
    expect(sleepStatus(undefined, 0)).toBe('Off')
    expect(sleepStatus({ endsAt: 65_000, minutes: 1 }, 0)).toBe('Pauses in 1:05')
    expect(sleepAnnouncement(undefined)).toBe('Sleep timer off')
    expect(sleepAnnouncement({ endOfTrack: true })).toBe('Sleep timer on: pauses after this track')
    expect(sleepAnnouncement({ endsAt: 0, minutes: 30 })).toBe(
      'Sleep timer on: pauses in 30 minutes',
    )
  })
})
