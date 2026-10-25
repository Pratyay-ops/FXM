import { isFxmError, type SourceId } from '@fxm/core'
import {
  CircleAlert,
  CircleSlash,
  type LucideIcon,
  Plug,
  RotateCcw,
  Search,
  SearchX,
  Settings,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { buttonClasses } from '../../../components/ui/button'
import { ErrorState } from '../../../components/ui/error-state'
import { cn } from '../../../lib/cn'
import { OnboardingLink } from '../onboarding'
import { type SourceAvailability, sourceLabel } from '../sources'

/** What went wrong, for people, from a provider's `FxmError` code. */
export function errorMessage(error: unknown, source: SourceId): string {
  const name = sourceLabel(source)
  if (!isFxmError(error)) return 'Something went wrong. Try again.'
  switch (error.code) {
    case 'RateLimited': {
      const seconds =
        error.retryAfterMs === undefined
          ? undefined
          : Math.max(1, Math.ceil(error.retryAfterMs / 1000))
      return seconds === undefined
        ? `Too many requests to ${name} for now. Try again in a minute.`
        : `Too many requests to ${name} for now. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
    }
    case 'BotCheck':
      return `${name} wants to check that you're not a bot. Try again later.`
    case 'Network':
      return `Couldn't reach ${name}. Check your connection, then try again.`
    case 'NotFound':
      return `${name} couldn't find it.`
    case 'Unavailable':
      return `This isn't available on ${name} right now.`
    case 'GeoBlocked':
      return `This isn't available in your region.`
    case 'AuthRequired':
      return `${name} needs you to log in again.`
    case 'Unsupported':
      return `FXM can't reach ${name} here.`
    case 'Parse':
      return `${name} sent something FXM doesn't understand. Try again later.`
    case 'Expired':
      return 'That took too long. Try again.'
  }
}

/** Whether trying again can help (it can't for a missing entity or an unreachable source). */
export function canRetry(error: unknown): boolean {
  return !isFxmError(error, 'NotFound') && !isFxmError(error, 'Unsupported')
}

/** A compact error inside a section (a tab of results, a shelf), with "Try again". */
export function InlineError({
  error,
  source,
  onRetry,
  className,
}: {
  error: unknown
  source: SourceId
  onRetry?: (() => void) | undefined
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center',
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="size-5 shrink-0 text-danger" />
      <p className="flex-1 text-sm">{errorMessage(error, source)}</p>
      {onRetry && canRetry(error) && (
        <button
          type="button"
          onClick={onRetry}
          className={buttonClasses({ variant: 'secondary', className: 'h-10' })}
        >
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  )
}

/**
 * A centered message with an icon, a heading, a few words and a way forward. `headingLevel` 1
 * makes it a page of its own; 3 fits it inside a section.
 */
export function Notice({
  icon: Icon,
  title,
  headingLevel,
  children,
  actions,
  className,
}: {
  icon: LucideIcon
  title: string
  headingLevel: 1 | 2 | 3
  children: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const Heading = (['h1', 'h2', 'h3'] as const)[headingLevel - 1] ?? 'h2'
  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center px-2 py-12 text-center',
        className,
      )}
    >
      <span className="grid size-16 place-items-center rounded-full bg-elevated text-text-muted">
        <Icon aria-hidden="true" className="size-7" strokeWidth={1.75} />
      </span>
      <Heading
        className={cn(
          'mt-5 font-bold tracking-tight text-balance',
          headingLevel === 1 ? 'text-2xl' : 'text-xl',
        )}
      >
        {title}
      </Heading>
      <div className="mt-2 space-y-2 text-sm text-text-muted">{children}</div>
      {actions && <div className="mt-6 flex flex-wrap justify-center gap-3">{actions}</div>}
    </div>
  )
}

function SearchMusicLink() {
  return (
    <Link to="/search" className={buttonClasses({ variant: 'secondary' })}>
      <Search aria-hidden="true" />
      Search music
    </Link>
  )
}

/** The entity kinds that have a page, as people say them. */
export type PageKindName = 'album' | 'artist' | 'playlist'

/**
 * Why a source can't be used, and the way forward: the onboarding entry point when YouTube or
 * Spotify can't be reached, Settings when Spotify is switched off.
 *
 * - On a page (`kind` given, heading level 1): "This album is on YouTube Music" …
 * - In search results (no `kind`, heading level 3): instead of empty results.
 */
export function SourceUnavailable({
  availability,
  source,
  kind,
}: {
  availability: Exclude<SourceAvailability, { status: 'available' }>
  source: SourceId
  kind?: PageKindName
}) {
  const name = sourceLabel(source)
  const headingLevel = kind ? 1 : 3
  const onIt = kind ? `This ${kind} is on ${name}` : undefined
  switch (availability.status) {
    case 'needs-youtube':
      return (
        <Notice
          icon={Plug}
          headingLevel={headingLevel}
          title={onIt ?? `Set up ${name}`}
          actions={<OnboardingLink />}
        >
          <p>
            FXM reaches {name} through the free FXM Connect browser extension, or through the
            desktop and Android apps.
          </p>
          <p>
            Without them, it tries Lite, an experimental mode that needs no install, but Lite isn't
            working in this browser right now.
          </p>
        </Notice>
      )
    case 'spotify-unreachable':
      return (
        <Notice
          icon={Plug}
          headingLevel={headingLevel}
          title={onIt ?? `Set up ${name}`}
          actions={<OnboardingLink />}
        >
          <p>
            FXM reaches {name} through the free FXM Connect browser extension, or through the
            desktop and Android apps.
          </p>
        </Notice>
      )
    case 'spotify-off':
      return (
        <Notice
          icon={CircleSlash}
          headingLevel={headingLevel}
          title={onIt ?? `${name} is switched off`}
          actions={
            <Link to="/settings" className={buttonClasses()}>
              <Settings aria-hidden="true" />
              Open Settings
            </Link>
          }
        >
          <p>{name} is switched off. Turn it on in Settings to search and open it again.</p>
        </Notice>
      )
    case 'missing':
      return (
        <Notice
          icon={CircleSlash}
          headingLevel={headingLevel}
          title={kind ? `This ${kind} can't be opened here` : `${name} isn't available`}
          actions={kind ? <SearchMusicLink /> : undefined}
        >
          <p>This version of FXM can't read {name} yet.</p>
        </Notice>
      )
  }
}

/** The page for an album, artist or playlist that doesn't exist, or a malformed link. */
export function EntityNotFound({ kind }: { kind: PageKindName }) {
  const title = `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)} not found`
  return (
    <Notice
      icon={SearchX}
      headingLevel={1}
      title={title}
      actions={<SearchMusicLink />}
      className="py-16 md:py-24"
    >
      <p>It may have been removed, or the link has a typo.</p>
    </Notice>
  )
}

/** The page for an album, artist or playlist that failed to load. */
export function EntityLoadError({
  kind,
  error,
  source,
  onRetry,
}: {
  kind: PageKindName
  error: unknown
  source: SourceId
  onRetry: () => void
}) {
  return (
    <ErrorState
      title={`Couldn't load this ${kind}`}
      message={errorMessage(error, source)}
      actions={
        <>
          {canRetry(error) && (
            <button type="button" className={buttonClasses()} onClick={onRetry}>
              <RotateCcw aria-hidden="true" />
              Try again
            </button>
          )}
          <SearchMusicLink />
        </>
      }
    />
  )
}
