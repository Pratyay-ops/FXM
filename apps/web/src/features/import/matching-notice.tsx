import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { MatchingAvailability } from './services'

/**
 * Where the landing page explains FXM Connect and the apps. It is served from the same origin
 * as the web app (which lives under `/app/`); the desktop and Android apps reach YouTube Music
 * themselves and never show these links.
 */
export const CONNECT_URL = '/#get-web'
export const DESKTOP_URL = '/#get-desktop'
export const ANDROID_URL = '/#get-android'

const LINK = 'font-semibold text-accent underline underline-offset-2 hover:no-underline'

/** "Get FXM Connect", as a link to the landing page's steps. */
export function ConnectLink({ children = 'Get FXM Connect' }: { children?: string }) {
  return (
    <a href={CONNECT_URL} className={LINK}>
      {children}
    </a>
  )
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
            <p className="text-text-muted">
              FXM finds each imported song on YouTube Music. To let it,{' '}
              <ConnectLink>add FXM Connect</ConnectLink> to this browser, or use the{' '}
              <a href={DESKTOP_URL} className={LINK}>
                desktop
              </a>{' '}
              or{' '}
              <a href={ANDROID_URL} className={LINK}>
                Android app
              </a>
              , then resume. {kept}
            </p>
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
