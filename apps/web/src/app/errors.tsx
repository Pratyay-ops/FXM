import { House, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isRouteErrorResponse, Link, useLocation, useNavigate, useRouteError } from 'react-router'
import { buttonClasses } from '../components/ui/button'
import { ErrorState } from '../components/ui/error-state'
import { NotFoundPage } from './not-found-page'

/** A lazily loaded page failed to download (offline, or a new deploy replaced it). */
export function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|module script failed|importing a module script|loading chunk/i.test(
      error.message,
    )
  )
}

function errorDetails(error: unknown): string | undefined {
  if (!import.meta.env.DEV) return undefined
  if (error instanceof Error) return error.stack ?? error.message
  return isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : String(error)
}

/**
 * errorElement for pages: the error replaces the page while the shell (navigation,
 * player) keeps working. "Try again" re-renders the route by replacing the current
 * history entry (a new location resets React Router's error boundary, also for
 * routes without loaders); when the page's code failed to download, it reloads.
 */
export function RouteError() {
  const error = useRouteError()
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />
  const chunkError = isChunkLoadError(error)
  const retry = () => {
    if (chunkError) window.location.reload()
    else navigate({ pathname, search, hash }, { replace: true, preventScrollReset: true })
  }

  return (
    <ErrorState
      title="Something went wrong"
      message={
        chunkError
          ? 'This page could not be loaded. Check your connection, then try again.'
          : 'This page ran into a problem. Trying again usually fixes it.'
      }
      details={errorDetails(error)}
      actions={
        <>
          <button type="button" className={buttonClasses()} onClick={retry}>
            <RotateCcw aria-hidden="true" />
            Try again
          </button>
          <Link to="/" className={buttonClasses({ variant: 'secondary' })}>
            <House aria-hidden="true" />
            Go home
          </Link>
        </>
      }
    />
  )
}

function FullPageError({ details }: { details?: string | undefined }) {
  return (
    <div className="grid min-h-dvh place-items-center px-gutter">
      <ErrorState
        title="FXM ran into a problem"
        message="Something unexpected happened. Reloading usually fixes it, and your settings are kept."
        details={details}
        actions={
          <>
            <button
              type="button"
              className={buttonClasses()}
              onClick={() => window.location.reload()}
            >
              <RotateCcw aria-hidden="true" />
              Try again
            </button>
            <a href={import.meta.env.BASE_URL} className={buttonClasses({ variant: 'secondary' })}>
              <House aria-hidden="true" />
              Go home
            </a>
          </>
        }
      />
    </div>
  )
}

/** errorElement of the root route: the shell itself failed, so render a full page. */
export function RootError() {
  return <FullPageError details={errorDetails(useRouteError())} />
}

/** Last line of defense around the providers and the router. */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; failed: boolean }
> {
  override state = { error: undefined as unknown, failed: false }

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('FXM crashed', error, info.componentStack)
  }

  override render() {
    if (this.state.failed) return <FullPageError details={errorDetails(this.state.error)} />
    return this.props.children
  }
}
