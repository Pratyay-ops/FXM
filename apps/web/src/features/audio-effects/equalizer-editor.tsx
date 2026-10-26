import {
  EQUALIZER_BANDS_HZ,
  EQUALIZER_GAIN_STEP_DB,
  EQUALIZER_MAX_GAIN_DB,
  EQUALIZER_MIN_GAIN_DB,
  EQUALIZER_PRESETS,
  type EqualizerPresetId,
  equalizerResponseDb,
  logFrequencies,
} from '@fxm/core'
import { RotateCcw } from 'lucide-react'
import { useId, useMemo } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { RangeSlider } from '../../components/ui/range-slider'
import { cn } from '../../lib/cn'
import { SettingSelect } from '../settings/setting-select'
import { useAudioEffectsStore } from './effects-store'
import { formatBand, formatGain } from './status'

/** The frequencies the curve is drawn at. */
const CURVE_FREQUENCIES = logFrequencies(96)

const CURVE_WIDTH = 300
const CURVE_HEIGHT = 96

/** The curve's points: 20 Hz to 20 kHz across, ±12 dB up and down. */
function curvePath(gainsDb: readonly number[]): string {
  const response = equalizerResponseDb(gainsDb, CURVE_FREQUENCIES)
  const middle = CURVE_HEIGHT / 2
  const scale = (middle - 4) / EQUALIZER_MAX_GAIN_DB
  return response
    .map((db, index) => {
      const x = (index / (response.length - 1)) * CURVE_WIDTH
      const clamped = Math.max(EQUALIZER_MIN_GAIN_DB, Math.min(EQUALIZER_MAX_GAIN_DB, db))
      const y = middle - clamped * scale
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** The equalizer's curve, as the filters play it: decoration, the sliders carry the values. */
export function EqualizerCurve({
  gainsDb,
  enabled,
  className,
}: {
  gainsDb: readonly number[]
  enabled: boolean
  className?: string
}) {
  const path = useMemo(() => curvePath(gainsDb), [gainsDb])
  return (
    <svg
      viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn('h-24 w-full rounded-lg bg-elevated', className)}
    >
      <line
        x1="0"
        x2={CURVE_WIDTH}
        y1={CURVE_HEIGHT / 2}
        y2={CURVE_HEIGHT / 2}
        className="stroke-border-strong"
        strokeDasharray="4 4"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path}
        fill="none"
        strokeWidth="2.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className={enabled ? 'stroke-accent' : 'stroke-text-muted'}
      />
    </svg>
  )
}

type PresetChoice = EqualizerPresetId | 'custom'

const PRESET_OPTIONS: readonly { value: PresetChoice; label: string }[] = EQUALIZER_PRESETS.map(
  (preset) => ({ value: preset.id, label: preset.label }),
)

/**
 * The equalizer's bands and presets: a preset menu, the curve, one slider per band (−12 to
 * +12 dB in half decibels) and a reset. Moving a band switches the equalizer on, as picking a
 * preset does.
 */
export function EqualizerEditor({ className }: { className?: string }) {
  const equalizer = useAudioEffectsStore((state) => state.effects.equalizer)
  const setGain = useAudioEffectsStore((state) => state.setEqualizerGain)
  const setEnabled = useAudioEffectsStore((state) => state.setEqualizerEnabled)
  const applyPreset = useAudioEffectsStore((state) => state.applyEqualizerPreset)
  const presetLabelId = useId()
  const options =
    equalizer.preset === 'custom'
      ? [...PRESET_OPTIONS, { value: 'custom' as const, label: 'Custom' }]
      : PRESET_OPTIONS
  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id={presetLabelId} className="text-sm font-semibold">
          Preset
        </p>
        <SettingSelect<PresetChoice>
          labelledBy={presetLabelId}
          value={equalizer.preset}
          options={options}
          onChange={(value) => {
            if (value !== 'custom') applyPreset(value)
          }}
          className="min-w-44"
        />
      </div>
      <EqualizerCurve gainsDb={equalizer.gainsDb} enabled={equalizer.enabled} />
      <ul className="space-y-1.5">
        {EQUALIZER_BANDS_HZ.map((frequency, band) => {
          const gain = equalizer.gainsDb[band] ?? 0
          const name = formatBand(frequency)
          return (
            <li
              key={frequency}
              className="grid grid-cols-[4rem_minmax(0,1fr)_4rem] items-center gap-3"
            >
              <span className="text-sm text-text-muted tabular-nums">{name}</span>
              <RangeSlider
                label={`${name} band`}
                min={EQUALIZER_MIN_GAIN_DB}
                max={EQUALIZER_MAX_GAIN_DB}
                step={EQUALIZER_GAIN_STEP_DB}
                value={gain}
                valueText={formatGain(gain)}
                onValueChange={(value) => {
                  setGain(band, value)
                  if (!equalizer.enabled) setEnabled(true)
                }}
              />
              <span className="text-right text-sm tabular-nums">{formatGain(gain)}</span>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        className={buttonClasses({ variant: 'secondary', className: 'h-10 px-4' })}
        onClick={() => applyPreset('flat')}
        disabled={equalizer.preset === 'flat'}
      >
        <RotateCcw aria-hidden="true" />
        Reset to flat
      </button>
    </div>
  )
}
