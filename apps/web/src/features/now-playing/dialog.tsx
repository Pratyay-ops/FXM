import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'

export interface DialogProps {
  /** Whether the dialog is open. Its content renders only while it is. */
  open: boolean
  /** The dialog's heading, also its accessible name. */
  title: string
  /** A line under the title, also the accessible description. */
  description?: ReactNode
  /** Called when the dialog closes itself: Escape, the close button, or a tap outside it. */
  onClose: () => void
  children: ReactNode
  /** Actions along the bottom, e.g. the main button. */
  footer?: ReactNode
  className?: string
}

/**
 * A modal dialog on the native `<dialog>` element, which traps focus, makes the page behind it
 * inert, closes on Escape and gives focus back to where it was. A bottom sheet on phones, a
 * centred card from 768px.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useLayoutEffect(() => {
    const dialog = ref.current
    // A click on the dialog element itself is a click on the backdrop around the card. (The
    // keyboard closes it with Escape.)
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) dialog?.close()
    }
    dialog?.addEventListener('click', onClick)
    return () => {
      dialog?.removeEventListener('click', onClick)
      // Unmounted while open: close it while it is still in the page, so focus goes back.
      if (dialog?.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onClose={onClose}
      className={cn(
        'm-auto max-h-[85dvh] w-[min(34rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-2xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/60 open:flex open:flex-col max-md:mb-0 max-md:w-full max-md:rounded-b-none max-md:pb-safe',
        className,
      )}
    >
      {open && (
        <>
          <div className="flex items-start gap-3 px-5 pt-5 pb-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-bold tracking-tight">
                {title}
              </h2>
              {description !== undefined && (
                <p id={descriptionId} className="mt-1 text-sm text-text-muted">
                  {description}
                </p>
              )}
            </div>
            <IconButton
              label="Close"
              icon={<X />}
              size="sm"
              className="-mt-1 -mr-2"
              onClick={() => ref.current?.close()}
            />
          </div>
          {/* px-5 and py-1 leave room for focus rings, which the scroll box would clip. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-1">{children}</div>
          {footer !== undefined && (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-5 py-4">
              {footer}
            </div>
          )}
        </>
      )}
    </dialog>
  )
}
