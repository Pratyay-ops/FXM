import { LOUDNESS_TARGETS, MAX_CROSSFADE_MS, PLAYBACK_RATE_PRESETS } from '@fxm/core'
import { useId } from 'react'
import { RangeSlider } from '../../components/ui/range-slider'
import { useConnection } from '../connect/connection'
import { usePlayer, usePlayerState } from '../now-playing/playback'
import { Switch } from '../queue/switch'
import { SettingSelect } from '../settings/setting-select'
import { SettingSwitch } from '../settings/setting-switch'
import { SettingRow, SettingsSection } from '../settings/settings-layout'
import { useAudioEffectsStore } from './effects-store'
import { EqualizerEditor } from './equalizer-editor'
import { equalizerNote, formatCrossfade, formatRate, loudnessNote } from './status'

const TARGET_OPTIONS = LOUDNESS_TARGETS.map((target) => ({
  value: String(target.lufs),
  label: `${target.label} (${target.lufs} LUFS)`,
}))

const MODE_OPTIONS = [
  { value: 'track', label: 'Each track' },
  { value: 'album', label: 'Whole albums' },
] as const

/** The speeds offered, with the current one if it is between them. */
function rateOptions(current: number) {
  const rates = PLAYBACK_RATE_PRESETS.includes(current)
    ? PLAYBACK_RATE_PRESETS
    : [...PLAYBACK_RATE_PRESETS, current].sort((a, b) => a - b)
  return rates.map((rate) => ({
    value: String(rate),
    label: rate === 1 ? 'Normal (1×)' : formatRate(rate),
  }))
}

/** What the effects do to the track that plays, and where the app runs. */
export function useEffectsNotes() {
  const status = usePlayerState((state) => state.effects)
  const platform = useConnection((state) => state.platform)
  const capabilities = useConnection((state) => state.capabilities)
  return {
    equalizer: equalizerNote(status, { platform, capabilities }),
    loudness: loudnessNote(status),
  }
}

/**
 * Settings → Sound (stage 8.1): the equalizer with its bands, loudness normalization, crossfade
 * and playback speed. Each row says what it does to the track that plays where that matters.
 */
export function AudioEffectsSection() {
  const effects = useAudioEffectsStore((state) => state.effects)
  const setEqualizerEnabled = useAudioEffectsStore((state) => state.setEqualizerEnabled)
  const setLoudness = useAudioEffectsStore((state) => state.setLoudness)
  const setCrossfadeMs = useAudioEffectsStore((state) => state.setCrossfadeMs)
  const setCrossfadeSameAlbum = useAudioEffectsStore((state) => state.setCrossfadeSameAlbum)
  const setPlaybackRate = useAudioEffectsStore((state) => state.setPlaybackRate)
  const player = usePlayer()
  const support = player.effectsSupport()
  const notes = useEffectsNotes()
  const ids = {
    equalizer: useId(),
    equalizerHelp: useId(),
    loudness: useId(),
    loudnessHelp: useId(),
    level: useId(),
    mode: useId(),
    crossfade: useId(),
    crossfadeHelp: useId(),
    speed: useId(),
    speedHelp: useId(),
  }
  const { equalizer, loudness, crossfade, playbackRate } = effects

  return (
    <SettingsSection title="Sound">
      <SettingRow
        label="Equalizer"
        labelId={ids.equalizer}
        help={
          <div id={ids.equalizerHelp} className="space-y-1 text-sm text-text-muted">
            <p>
              Ten bands from 31 Hz to 16 kHz. Boosts lower the overall level as much as they raise
              it, so loud songs don’t distort.
            </p>
            {equalizer.enabled && notes.equalizer !== undefined && <p>{notes.equalizer}</p>}
          </div>
        }
      >
        <SettingSwitch
          labelledBy={ids.equalizer}
          describedBy={ids.equalizerHelp}
          checked={equalizer.enabled}
          onChange={setEqualizerEnabled}
        />
      </SettingRow>
      <details className="group p-4 sm:p-5">
        <summary className="cursor-pointer text-sm font-semibold text-text-muted hover:text-text">
          Adjust the bands
        </summary>
        <EqualizerEditor className="mt-4" />
      </details>

      <SettingRow
        label="Normalize volume"
        labelId={ids.loudness}
        help={
          <div id={ids.loudnessHelp} className="space-y-1 text-sm text-text-muted">
            <p>
              Plays every track at about the same loudness, using what YouTube reports and the
              ReplayGain tags of your files. Quiet tracks get louder only where FXM can read their
              audio and knows their peaks.
            </p>
            {loudness.enabled && notes.loudness !== undefined && (
              <p aria-live="polite">{notes.loudness}</p>
            )}
          </div>
        }
      >
        <SettingSwitch
          labelledBy={ids.loudness}
          describedBy={ids.loudnessHelp}
          checked={loudness.enabled}
          onChange={(enabled) => setLoudness({ enabled })}
        />
      </SettingRow>
      {loudness.enabled && (
        <>
          <SettingRow label="Volume level" labelId={ids.level}>
            <SettingSelect
              labelledBy={ids.level}
              value={String(loudness.targetLufs)}
              options={TARGET_OPTIONS}
              onChange={(value) => setLoudness({ targetLufs: Number(value) })}
            />
          </SettingRow>
          <SettingRow
            label="Normalize"
            labelId={ids.mode}
            help={
              <p className="text-sm text-text-muted">
                Whole albums keep the differences between an album’s songs, where the files say how
                loud the album is.
              </p>
            }
          >
            <SettingSelect
              labelledBy={ids.mode}
              value={loudness.mode}
              options={MODE_OPTIONS}
              onChange={(mode) => setLoudness({ mode })}
            />
          </SettingRow>
        </>
      )}

      <SettingRow
        label="Crossfade"
        labelId={ids.crossfade}
        help={
          <p id={ids.crossfadeHelp} className="text-sm text-text-muted">
            {support.crossfade
              ? 'The next song fades in while the one that ends fades out. Only between songs that follow each other by themselves.'
              : 'Not available here yet: songs play one after the other without a gap.'}
          </p>
        }
      >
        <div className="flex min-w-56 items-center gap-3">
          <RangeSlider
            label="Crossfade"
            min={0}
            max={MAX_CROSSFADE_MS / 1000}
            step={1}
            value={crossfade.durationMs / 1000}
            valueText={formatCrossfade(crossfade.durationMs)}
            disabled={!support.crossfade}
            aria-describedby={ids.crossfadeHelp}
            onValueChange={(seconds) => setCrossfadeMs(seconds * 1000)}
          />
          <span className="w-10 text-right text-sm tabular-nums">
            {formatCrossfade(crossfade.durationMs)}
          </span>
        </div>
      </SettingRow>
      {support.crossfade && crossfade.durationMs > 0 && (
        <div className="p-4 sm:p-5">
          <Switch
            label="Crossfade within albums"
            description="Off keeps albums whose songs run into each other (live records, classical works, mixes) gapless."
            checked={crossfade.sameAlbum}
            onChange={setCrossfadeSameAlbum}
          />
        </div>
      )}

      <SettingRow
        label="Playback speed"
        labelId={ids.speed}
        help={
          <p id={ids.speedHelp} className="text-sm text-text-muted">
            Faster or slower without changing the pitch. The player shows the speed while it isn’t
            normal.
          </p>
        }
      >
        <SettingSelect
          labelledBy={ids.speed}
          describedBy={ids.speedHelp}
          value={String(playbackRate)}
          options={rateOptions(playbackRate)}
          disabled={!support.playbackRate}
          onChange={(value) => setPlaybackRate(Number(value))}
        />
      </SettingRow>
    </SettingsSection>
  )
}
