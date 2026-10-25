import { Heart, UserCheck, UserPlus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { buttonClasses } from '../ui/button'
import { IconButton } from '../ui/icon-button'

/**
 * The action row under a collection header: the play button (passed as children)
 * plus a save or follow toggle, which stays local until the library lands (2.6).
 */
export function CollectionActions({
  toggle,
  children,
}: {
  toggle: 'save' | 'follow'
  children: ReactNode
}) {
  const [on, setOn] = useState(false)
  return (
    <div className="flex items-center justify-center gap-3 sm:justify-start">
      {children}
      {toggle === 'save' ? (
        <IconButton
          label="Save to library"
          icon={<Heart fill={on ? 'currentColor' : 'none'} />}
          size="lg"
          pressed={on}
          onClick={() => setOn(!on)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOn(!on)}
          className={buttonClasses({
            variant: on ? 'secondary' : 'ghost',
            className: 'border border-border-strong',
          })}
        >
          {on ? <UserCheck aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
          {on ? 'Following' : 'Follow'}
        </button>
      )}
    </div>
  )
}
