import { Switch } from '../queue/switch'
import { autoMatchOffered, useMatchingStore } from './matching-store'

/** What Auto does. */
const AUTO_DESCRIPTION =
  'Plays the song FXM matched to a track from another service without asking, when FXM is sure it is the same recording. Otherwise matches are best guesses that play after a tap.'

/**
 * The Auto setting, for Settings → Playback: shown only while the matching config makes the
 * Auto band available (stage 1.12's report), which this release's doesn't, so it renders nothing.
 */
export function AutoMatchSetting() {
  const enabled = useMatchingStore((state) => state.autoMatch)
  const setEnabled = useMatchingStore((state) => state.setAutoMatch)
  if (!autoMatchOffered()) return null
  return (
    <div className="p-4 sm:p-5">
      <Switch
        label="Play sure matches automatically"
        description={AUTO_DESCRIPTION}
        checked={enabled}
        onChange={setEnabled}
      />
    </div>
  )
}
