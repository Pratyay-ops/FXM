import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { IconButton } from '../../../components/ui/icon-button'
import { cn } from '../../../lib/cn'

export interface DialogProps {
  open: boolean
  /** Called when the dialog closes itself: Escape, the close button, a click on the backdrop. */
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
  /**
   * An `alertdialog`: it asks to confirm something that can't be undone. Put `data-autofocus` on
   * its least destructive button, so an extra Enter changes nothing.
   */
  alert?: boolean
  /**
   * Where focus goes when the dialog closes, when that isn't back where it was, e.g. the next
   * playlist after deleting one: the button that opened the dialog went with it. Return nothing
   * to put focus back where it was.
   */
  finalFocus?: () => HTMLElement | null | undefined
}

/**
 * A modal dialog on the native `<dialog>`: the browser keeps focus inside it, makes the page
 * behind it inert and closes it on Escape. Focus goes back to where it was when it closes, or
 * to `finalFocus`. The content mounts only while open, so forms start fresh every time.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  alert = false,
  finalFocus,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  // Whether the pointer went down on the backdrop: a text selection dragged out of the dialog
  // ends with a click on the backdrop too, and must not close it.
  const pressedBackdrop = useRef(false)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement as HTMLElement | null
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
      dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is the pointer twin of Escape, which <dialog> handles itself
    <dialog
      ref={ref}
      role={alert ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={() => {
        const preferred = finalFocus?.()
        const target = returnFocus.current
        returnFocus.current = null
        const active = document.activeElement
        if (preferred?.isConnected) {
          preferred.focus()
        } else if (
          // Back where it was, unless something else took focus meanwhile.
          target?.isConnected &&
          (!active || active === document.body || active === target)
        ) {
          target.focus()
        }
        onClose()
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // A click on the dialog element itself, outside its content, is on the backdrop.
        const fromBackdrop = pressedBackdrop.current
        pressedBackdrop.current = false
        if (fromBackdrop && event.target === event.currentTarget) onClose()
      }}
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/60 forced-colors:border-[CanvasText]',
        className,
      )}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="pt-1.5 text-xl font-bold tracking-tight">
              {title}
            </h2>
            <IconButton
              label="Close"
              icon={<X />}
              size="sm"
              className="-mt-0.5 -mr-2"
              onClick={onClose}
            />
          </div>
          {description && (
            <div id={descriptionId} className="mt-2 text-sm text-text-muted">
              {description}
            </div>
          )}
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  )
}

/** The row of buttons at the end of a dialog, primary action last. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>
}
