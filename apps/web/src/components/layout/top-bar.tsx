import { ArrowLeft, ChevronLeft, ChevronRight, Settings } from 'lucide-react'
import { Link, NavLink, useNavigate } from 'react-router'
import { InstallButton } from '../../features/pwa/install-button'
import { cn } from '../../lib/cn'
import { IconButton, iconButtonClasses } from '../ui/icon-button'
import { LogoMark, Wordmark } from '../ui/logo'
import type { RouteHandle } from './route-meta'
import { SearchField } from './search-field'
import { useHistoryNavigation } from './use-history-navigation'
import { useScrolled } from './use-scrolled'

function HistoryButtons() {
  const { canGoBack, canGoForward, goBack, goForward } = useHistoryNavigation()
  return (
    <div className="flex shrink-0 items-center gap-2">
      <IconButton
        label="Go back"
        icon={<ChevronLeft />}
        variant="solid"
        size="sm"
        disabled={!canGoBack}
        onClick={goBack}
      />
      <IconButton
        label="Go forward"
        icon={<ChevronRight />}
        variant="solid"
        size="sm"
        disabled={!canGoForward}
        onClick={goForward}
      />
    </div>
  )
}

/** Phone header: logo on the top-level tabs, a back button elsewhere, and the page title. */
function PhoneHeading({ handle }: { handle: RouteHandle | undefined }) {
  const navigate = useNavigate()
  const { canGoBack } = useHistoryNavigation()
  const isHome = handle?.title === 'Home'
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 md:hidden">
      {handle?.tab ? (
        <Link
          to="/"
          aria-label="FXM home"
          className="-ml-1.5 grid size-touch shrink-0 place-items-center rounded-full"
        >
          <LogoMark className="size-8" />
        </Link>
      ) : (
        <IconButton
          label="Back"
          icon={<ArrowLeft />}
          variant="plain"
          className="-ml-2.5"
          // Opened from a link or a new tab: "back" goes to Home instead of leaving FXM.
          onClick={() => (canGoBack ? navigate(-1) : navigate('/'))}
        />
      )}
      {isHome ? (
        <Wordmark className="ml-1" />
      ) : (
        <span className="ml-1 truncate text-lg font-bold">{handle?.title}</span>
      )}
    </div>
  )
}

/** Sticky top bar; it turns translucent with a border once the page scrolls. */
export function TopBar({ handle }: { handle: RouteHandle | undefined }) {
  const scrolled = useScrolled()
  return (
    <header
      className={cn(
        'sticky top-0 z-30 border-b pt-[var(--safe-top)] transition-colors duration-200',
        scrolled ? 'border-border bg-background/80 backdrop-blur-xl' : 'border-transparent',
      )}
    >
      {/* Same width and gutters as the page below, so both line up on wide screens. */}
      <div className="px-gutter">
        <div className="mx-auto flex h-14 w-full max-w-page items-center gap-2 md:h-topbar md:gap-4">
          <PhoneHeading handle={handle} />
          <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex lg:gap-4">
            <HistoryButtons />
            <SearchField shortcut className="w-full max-w-md" />
          </div>
          <InstallButton />
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) => iconButtonClasses({ highlighted: isActive })}
          >
            <Settings aria-hidden="true" />
          </NavLink>
        </div>
      </div>
    </header>
  )
}
