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
import { APP_UPDATED_MESSAGE, isAppUpdatedError, reloadApp } from '../../../lib/app-update'
import { cn } from '../../../lib/cn'
import { reachSentence } from '../../connect/explain'
import { OnboardingLink } from '../onboarding'
import { type SourceAvailability, sourceLabel } from '../sources'
import { useSourcesSnapshot } from '../sources-context'

/**
 * What went wrong, for people, from a provider's `FxmError` code. Code that failed to download
 * while online (`AppUpdatedError`) says that FXM was updated.
 */
export function errorMessage(error: unknown, source: SourceId): string {
  const name = sourceLabel(source)
  if (isAppUpdatedError(error)) return APP_UPDATED_MESSAGE
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

/**
 * Whether trying again can help. It can't for a missing entity or an unreachable source, nor
 * for code that failed to download while online, which only a reload fetches (see
 * {@link ReloadButton}).
 */
export function canRetry(error: unknown): boolean {
  return (
    !isFxmError(error, 'NotFound') && !isFxmError(error, 'Unsupported') && !isAppUpdatedError(error)
  )
}

/** Reloads FXM, for an `AppUpdatedError`: the user's choice, since a reload stops the music. */
function ReloadButton({
  variant = 'primary',
  className,
}: {
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  return (
    <button type="button" onClick={reloadApp} className={buttonClasses({ variant, className })}>
      <RotateCcw aria-hidden="true" />
      Reload
    </button>
  )
}

/**
 * A compact error inside a section (a tab of results, a shelf), with "Try again". It can take
 * focus from a script, for when the control that led to it went away (see `useShowMore`).
 */
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
      tabIndex={-1}
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center',
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="size-5 shrink-0 text-danger" />
      <p className="flex-1 text-sm">{errorMessage(error, source)}</p>
      {isAppUpdatedError(error) && <ReloadButton variant="secondary" className="h-10" />}
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

/** The room above and below a {@link Notice}. */
const NOTICE_SPACING = {
  /** Inside a section, or where the way forward must show without scrolling on a phone. */
  compact: 'py-6 sm:py-10',
  normal: 'py-12',
  /** A page of its own with little else on it. */
  roomy: 'py-16 md:py-24',
} as const

/**
 * A centered message with an icon, a heading, a few words and a way forward. `headingLevel` 1
 * makes it a page of its own; 2 or 3 fits it inside a page or a section.
 */
export function Notice({
  icon: Icon,
  title,
  headingLevel,
  children,
  actions,
  spacing = 'normal',
}: {
  icon: LucideIcon
  title: string
  headingLevel: 1 | 2 | 3
  children: ReactNode
  actions?: ReactNode
  spacing?: keyof typeof NOTICE_SPACING
}) {
  const Heading = (['h1', 'h2', 'h3'] as const)[headingLevel - 1] ?? 'h2'
  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center px-2 text-center',
        NOTICE_SPACING[spacing],
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
 * Spotify can't be reached, Settings when Spotify is switched off. While FXM Connect is on the
 * page but has not answered yet (`detecting`), it says FXM is connecting instead of offering
 * the install: the source is most likely a moment away.
 *
 * - On a page (`kind` given, heading level 1): "This album is on YouTube Music" …
 * - On the search page (no `kind`, heading level 2): in place of the results and their tabs,
 *   which would all say the same, kept short so that its button shows without scrolling on a
 *   phone: "Search needs YouTube Music access" … With `alternatives`, the sources that work
 *   here, it also offers to search one of them instead: on a phone their chips may be out of
 *   view in the sideways scrolling row, and FXM Connect can't help on every device.
 */
export function SourceUnavailable({
  availability,
  source,
  kind,
  alternatives = [],
  onPickSource,
}: {
  availability: Exclude<SourceAvailability, { status: 'available' }>
  source: SourceId
  kind?: PageKindName
  /** The search page's other sources that can be used, offered in its place. */
  alternatives?: readonly SourceId[]
  /** Picks one of `alternatives`. */
  onPickSource?: (source: SourceId) => void
}) {
  const { detecting = false } = useSourcesSnapshot()
  const name = sourceLabel(source)
  const headingLevel = kind ? 1 : 2
  const onIt = kind ? `This ${kind} is on ${name}` : undefined
  const spacing = kind ? 'normal' : 'compact'
  const reach = <p>{reachSentence(name)}</p>
  if (
    detecting &&
    (availability.status === 'needs-youtube' || availability.status === 'spotify-unreachable')
  ) {
    return (
      <Notice
        icon={Plug}
        headingLevel={headingLevel}
        title="Connecting to FXM Connect…"
        spacing={spacing}
      >
        <p>FXM Connect is in this browser. It usually answers within a second or two.</p>
      </Notice>
    )
  }
  const instead =
    kind === undefined && onPickSource !== undefined
      ? alternatives.map((other) => (
          <button
            key={other}
            type="button"
            onClick={() => onPickSource(other)}
            className={buttonClasses({ variant: 'secondary' })}
          >
            <Search aria-hidden="true" />
            Search {sourceLabel(other)} instead
          </button>
        ))
      : []
  switch (availability.status) {
    case 'needs-youtube':
      return (
        <Notice
          icon={Plug}
          headingLevel={headingLevel}
          title={onIt ?? `Search needs ${name} access`}
          actions={
            <>
              <OnboardingLink />
              {instead}
            </>
          }
          spacing={spacing}
        >
          {reach}
          {kind && (
            <p>
              Without them, it tries Lite, an experimental tier that needs no install, but Lite
              isn't working in this browser right now.
            </p>
          )}
        </Notice>
      )
    case 'spotify-unreachable':
      return (
        <Notice
          icon={Plug}
          headingLevel={headingLevel}
          title={onIt ?? `Search needs ${name} access`}
          actions={<OnboardingLink />}
          spacing={spacing}
        >
          {reach}
        </Notice>
      )
    case 'spotify-off':
      return (
        <Notice
          icon={CircleSlash}
          headingLevel={headingLevel}
          spacing={spacing}
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
          spacing={spacing}
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
      spacing="roomy"
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
          {isAppUpdatedError(error) && <ReloadButton />}
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
