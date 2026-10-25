import { NavLink } from 'react-router'
import { cn } from '../../lib/cn'
import { PRIMARY_NAV } from './nav-items'

/** Phone tab bar (below 768px), padded above the home indicator. */
export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-safe bottom-0 z-40 border-t border-border bg-surface/90 pb-safe backdrop-blur-xl md:hidden"
    >
      <ul className="grid h-tabbar grid-cols-3">
        {PRIMARY_NAV.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.to} className="flex">
              <NavLink
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  cn(
                    'flex flex-1 flex-col items-center justify-center gap-1 text-2xs font-semibold transition-colors',
                    isActive ? 'text-text' : 'text-text-muted hover:text-text',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      aria-hidden="true"
                      className={cn('size-6', isActive && 'text-accent')}
                      strokeWidth={isActive ? 2.4 : 2}
                    />
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
