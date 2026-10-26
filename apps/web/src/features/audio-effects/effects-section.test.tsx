import { testTrack } from '@fxm/player/testing'
import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../../test/render'
import { useConnection } from '../connect/connection'
import { setupTestPlayback } from '../now-playing/testing'
import { AUDIO_EFFECTS_STORAGE_KEY, useAudioEffectsStore } from './effects-store'

const stored = () => JSON.parse(localStorage.getItem(AUDIO_EFFECTS_STORAGE_KEY) ?? 'null')

async function soundSection() {
  const heading = await screen.findByRole('heading', { name: 'Sound' })
  return heading.closest('section') as HTMLElement
}

describe('Settings → Sound', () => {
  it('switches the equalizer on and saves it', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    const section = await soundSection()
    const equalizer = within(section).getByRole('switch', { name: 'Equalizer' })
    expect(equalizer).not.toBeChecked()
    await user.click(equalizer)
    expect(useAudioEffectsStore.getState().effects.equalizer.enabled).toBe(true)
    expect(stored()).toMatchObject({ state: { effects: { equalizer: { enabled: true } } } })
  })

  it('picks a preset and moves a band in the editor', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    const section = await soundSection()
    await user.click(within(section).getByText('Adjust the bands'))
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Preset' }), 'rock')
    expect(useAudioEffectsStore.getState().effects.equalizer.preset).toBe('rock')
    const band = within(section).getByRole('slider', { name: '1 kHz band' })
    expect(band).toHaveAttribute('aria-valuetext', '−0.5 dB')
    act(() => useAudioEffectsStore.getState().setEqualizerGain(5, 4))
    expect(band).toHaveAttribute('aria-valuetext', '+4 dB')
    expect(within(section).getByRole('combobox', { name: 'Preset' })).toHaveValue('custom')
  })

  it('says when the equalizer can’t process the track that plays', async () => {
    const { player, engine } = setupTestPlayback()
    renderApp('/settings')
    const section = await soundSection()
    act(() => useAudioEffectsStore.getState().setEqualizerEnabled(true))
    await act(() => player.setQueue([testTrack('Creep')]))
    act(() => {
      useConnection.setState({ platform: 'web' })
      engine.emit('effects', { equalizer: 'unavailable', loudness: 'off', loudnessGainDb: 0 })
    })
    expect(player.getState().effects.equalizer).toBe('unavailable')
    expect(within(section).getByText(/without FXM Connect/)).toBeInTheDocument()
  })

  it('normalizes volume to a level, by track or album', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    const section = await soundSection()
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Volume level' }), '-18')
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Normalize' }), 'album')
    expect(useAudioEffectsStore.getState().effects.loudness).toEqual({
      enabled: true,
      targetLufs: -18,
      mode: 'album',
    })
    await user.click(within(section).getByRole('switch', { name: 'Normalize volume' }))
    expect(useAudioEffectsStore.getState().effects.loudness.enabled).toBe(false)
    expect(within(section).queryByRole('combobox', { name: 'Volume level' })).toBeNull()
  })

  it('sets the crossfade and the speed', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    const section = await soundSection()
    const crossfade = within(section).getByRole('slider', { name: 'Crossfade' })
    expect(crossfade).toHaveAttribute('aria-valuetext', 'Off')
    act(() => useAudioEffectsStore.getState().setCrossfadeMs(6000))
    expect(crossfade).toHaveAttribute('aria-valuetext', '6 s')
    await user.click(within(section).getByRole('switch', { name: /Crossfade within albums/ }))
    expect(useAudioEffectsStore.getState().effects.crossfade.sameAlbum).toBe(true)
    await user.selectOptions(
      within(section).getByRole('combobox', { name: 'Playback speed' }),
      '1.25',
    )
    expect(useAudioEffectsStore.getState().effects.playbackRate).toBe(1.25)
  })

  it('says crossfade isn’t available with an engine without it', async () => {
    const { engine } = setupTestPlayback()
    Object.assign(engine, { crossfade: undefined })
    renderApp('/settings')
    const section = await soundSection()
    expect(within(section).getByRole('slider', { name: 'Crossfade' })).toBeDisabled()
    expect(within(section).getByText(/Not available here yet/)).toBeInTheDocument()
  })

  it('says crossfade isn’t available where the device doesn’t let FXM change the volume', async () => {
    const { engine } = setupTestPlayback()
    Object.assign(engine, { canSetVolume: () => false })
    renderApp('/settings')
    const section = await soundSection()
    expect(within(section).getByRole('slider', { name: 'Crossfade' })).toBeDisabled()
    expect(within(section).getByText(/doesn’t let FXM change the volume/)).toBeInTheDocument()
  })

  it('says what loudness does only while a track is loaded, without reading it out', async () => {
    const { player } = setupTestPlayback()
    renderApp('/settings')
    const section = await soundSection()
    // Nothing plays: no track to talk about.
    expect(within(section).queryByText(/doesn’t say how loud/)).toBeNull()
    await act(() => player.setQueue([testTrack('Creep')]))
    const note = within(section).getByText(/doesn’t say how loud/)
    expect(note.closest('[aria-live]')).toBeNull()
  })

  it('moves the focus to its heading when the page opens at #sound', async () => {
    setupTestPlayback()
    renderApp('/settings#sound')
    expect(await screen.findByRole('heading', { name: 'Sound' })).toHaveFocus()
  })

  it('fills the bands from 0 dB in the middle, muted while the equalizer is off', async () => {
    setupTestPlayback()
    const { user } = renderApp('/settings')
    const section = await soundSection()
    await user.click(within(section).getByText('Adjust the bands'))
    act(() => {
      useAudioEffectsStore.getState().setEqualizerEnabled(true)
      useAudioEffectsStore.getState().setEqualizerGain(0, -6)
    })
    const band = within(section).getByRole('slider', { name: '31 Hz band' })
    expect(band.style.getPropertyValue('--range-from')).toBe('25%')
    expect(band.style.getPropertyValue('--range-to')).toBe('50%')
    expect(band).toHaveClass('[--range-active:var(--color-accent)]')
    act(() => useAudioEffectsStore.getState().setEqualizerEnabled(false))
    expect(band).toHaveClass('[--range-active:var(--color-text-muted)]')
  })
})
