import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { setupTestPlayback } from '../now-playing/testing'
import { appActions, createMediaActionsStore } from '../search/actions'
import { useAudioEffectsStore } from './effects-store'
import { equalizerActions, wireEqualizerActions } from './equalizer-actions'
import { formatMinutes, sleepStatus } from './sound-dialog'
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

  it('starts and cancels a sleep timer', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('button', { name: '30 min' }))
    expect(useAudioEffectsStore.getState().sleepTimer).toMatchObject({ minutes: 30 })
    expect(within(dialog).getByText(/Pauses in (29:5\d|30:00)/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '30 min' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(dialog).getByRole('button', { name: 'End of track' }))
    expect(useAudioEffectsStore.getState().sleepTimer).toEqual({ endOfTrack: true })
    expect(within(dialog).getByText('Pauses after this track')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Off' }))
    expect(useAudioEffectsStore.getState().sleepTimer).toBeUndefined()
  })

  it('changes the speed, which the player bar then shows', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('button', { name: '1.5×' }))
    expect(useAudioEffectsStore.getState().effects.playbackRate).toBe(1.5)
    expect(within(dialog).getByRole('heading', { name: 'Speed: 1.5×' })).toBeInTheDocument()
  })

  it('switches the equalizer and volume normalization', async () => {
    setupTestPlayback()
    const { user, dialog } = await openSound()
    await user.click(within(dialog).getByRole('switch', { name: 'Equalizer' }))
    expect(useAudioEffectsStore.getState().effects.equalizer.enabled).toBe(true)
    await user.click(within(dialog).getByRole('switch', { name: 'Normalize volume' }))
    expect(useAudioEffectsStore.getState().effects.loudness.enabled).toBe(false)
  })

  it('links to Settings and closes', async () => {
    setupTestPlayback()
    const { user, dialog, router } = await openSound()
    await user.click(within(dialog).getByRole('link', { name: 'More in Settings' }))
    expect(useSoundDialogStore.getState().open).toBe(false)
    expect(router.state.location.hash).toBe('#sound')
  })
})

describe('the track menus’ Equalizer', () => {
  it('opens the Sound dialog', () => {
    const store = createMediaActionsStore()
    wireEqualizerActions(store)
    expect(store.get().equalizer).toBe(equalizerActions)
    store.get().equalizer?.open()
    expect(useSoundDialogStore.getState().open).toBe(true)
    expect(appActions.get().equalizer).toBeUndefined()
  })
})

describe('helpers', () => {
  it('formats minutes and the timer', () => {
    expect(formatMinutes(15)).toBe('15 min')
    expect(formatMinutes(60)).toBe('1 h')
    expect(formatMinutes(90)).toBe('1 h 30 min')
    expect(sleepStatus(undefined, 0)).toBe('Off')
    expect(sleepStatus({ endsAt: 65_000, minutes: 1 }, 0)).toBe('Pauses in 1:05')
  })
})
