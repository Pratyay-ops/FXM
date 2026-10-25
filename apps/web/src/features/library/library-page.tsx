import { LibraryBig, Search } from 'lucide-react'
import { Link } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { PageTitle } from '../../components/ui/page'

export function LibraryPage() {
  return (
    <div className="space-y-6 pt-2 md:pt-4">
      <PageTitle hideOnPhone>Your library</PageTitle>
      <EmptyState
        icon={LibraryBig}
        title="Your library is empty"
        description="Songs you like, playlists you make and artists you follow will live here, saved on this device. No account needed."
        action={
          <Link to="/search" className={buttonClasses()}>
            <Search aria-hidden="true" />
            Find something to play
          </Link>
        }
        className="rounded-2xl border border-dashed border-border md:py-24"
      />
    </div>
  )
}
