import { Info } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '../../lib/cn'
import { RELEASED } from '../connect/config'
import { canAddConnect, currentDevice } from '../connect/device'
import { appsSentence, howToGetMore } from '../connect/explain'
import { ONBOARDING_URL } from '../search/onboarding'
import type { MatchingAvailability } from './services'

/**
 * Where FXM Connect's steps are: the app's own onboarding (stage 2.7), which also points to the
 * desktop and Android apps once they are out. The apps reach YouTube Music themselves and never
 * show these links.
 */
export const CONNECT_URL = ONBOARDING_URL

const LINK = 'font-semibold text-accent underline underline-offset-2 hover:no-underline'

/** "Get FXM Connect", as a link to the app's onboarding. */
export function ConnectLink({ children = 'Get FXM Connect' }: { children?: string }) {
  return (
    <Link to={CONNECT_URL} className={LINK}>
      {children}
    </Link>
  )
}

/** ", or use the desktop app", with the apps that are out (`RELEASED`), else nothing. */
function orTheApps(): string {
  if (RELEASED.desktop && RELEASED.android) return ', or use the desktop or Android app'
  if (RELEASED.desktop) return ', or use the desktop app'
  if (RELEASED.android) return ', or use the Android app'
  return ''
}

/**
 * Why imports can't find songs here, said once for every import: above the list, in the
 * preview before Start, and on a paused import's page. Nothing when they can.
 */
export function MatchingNotice({
  matching,
  where,
  className,
}: {
  matching: MatchingAvailability | undefined
  /** `preview`: before an import starts; `imports`: about the imports there are. */
  where: 'preview' | 'imports'
  className?: string
}) {
  if (matching === undefined || matching === 'ready') return null
  const device = currentDevice()
  const kept =
    where === 'preview'
      ? 'You can start the import now: the playlists go into your library at once, with every song a link names, and the rest follow once FXM can find them.'
      : 'Your imports keep their place, and nothing they found is lost.'
  return (
    <aside
      aria-label="Finding songs"
      className={cn(
        'flex gap-3 rounded-2xl border border-border bg-elevated p-4 text-sm forced-colors:border-[CanvasText]',
        className,
      )}
    >
      <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-muted" />
      <div className="min-w-0 space-y-1.5">
        {matching === 'needs-connect' ? (
          <>
            <p className="font-semibold">This browser can’t reach YouTube Music on its own</p>
            {canAddConnect(device) ? (
              <p className="text-text-muted">
                FXM finds each imported song on YouTube Music. To let it,{' '}
                <ConnectLink>add FXM Connect</ConnectLink> to this browser{orTheApps()}, then
                resume. {RELEASED.desktop && RELEASED.android ? '' : `${appsSentence()} `}
                {kept}
              </p>
            ) : (
              // A browser that can't add FXM Connect: what this device can do instead.
              <p className="text-text-muted">
                FXM finds each imported song on YouTube Music. {howToGetMore(device, 'youtube')}{' '}
                {kept}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="font-semibold">Finding songs isn’t available in this version yet</p>
            <p className="text-text-muted">
              FXM will find each imported song on YouTube Music once this version can search it.{' '}
              {kept}
            </p>
          </>
        )}
      </div>
    </aside>
  )
}
