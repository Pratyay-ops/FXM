import { SegmentedControl, type SegmentedOption } from '../../components/ui/segmented-control'
import { connectOrApps } from '../connect/explain'
import { useSources, useSourcesSnapshot } from './sources-context'

type OnOff = 'on' | 'off'

const OPTIONS: readonly SegmentedOption<OnOff>[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

/** The Spotify on/off switch of Settings. On by default; it says nothing about reachability. */
export function SpotifySwitchControl({
  labelledBy,
  describedBy,
  className,
}: {
  labelledBy?: string | undefined
  describedBy?: string | undefined
  className?: string | undefined
}) {
  const sources = useSources()
  const { spotifyEnabled } = useSourcesSnapshot()
  return (
    <SegmentedControl
      label="Spotify"
      labelledBy={labelledBy}
      describedBy={describedBy}
      value={spotifyEnabled ? 'on' : 'off'}
      options={OPTIONS}
      onChange={(value) => sources.setSpotifyEnabled(value === 'on')}
      className={className}
    />
  )
}

/**
 * What the switch does here: whether Spotify is reachable decides the wording, and whether this
 * build can read it at all (the web app needs the sandbox documents of stage 1.10 for that).
 */
export function SpotifySwitchHelp({ id }: { id?: string }) {
  const { capabilities, spotifyEnabled, providers } = useSourcesSnapshot()
  const reachable = capabilities.spotify !== 'unreachable'
  const text = !spotifyEnabled
    ? "Off: FXM doesn't contact Spotify."
    : !reachable
      ? `On wherever FXM can reach Spotify: with ${connectOrApps()}. It can't from here.`
      : providers.has('spotify')
        ? 'Search and browse Spotify too. Its tracks play from matching songs on other sources, never from Spotify.'
        : "On, but this version of FXM can't read Spotify in a browser yet. That comes in a later update."
  return (
    <p id={id} aria-live="polite" className="text-sm text-text-muted">
      {text}
    </p>
  )
}
