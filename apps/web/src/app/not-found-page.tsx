import { House, Search } from 'lucide-react'
import { Link } from 'react-router'
import { buttonClasses } from '../components/ui/button'

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center md:py-24">
      <p
        aria-hidden="true"
        className="bg-linear-to-br from-accent to-accent-hover bg-clip-text text-8xl leading-none font-black tracking-tighter text-transparent"
      >
        404
      </p>
      <h1 className="mt-5 text-2xl font-bold tracking-tight">Page not found</h1>
      <p className="mt-2 text-text-muted">
        This page doesn't exist. It may have moved, or the link has a typo.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link to="/" className={buttonClasses()}>
          <House aria-hidden="true" />
          Go home
        </Link>
        <Link to="/search" className={buttonClasses({ variant: 'secondary' })}>
          <Search aria-hidden="true" />
          Search music
        </Link>
      </div>
    </div>
  )
}
