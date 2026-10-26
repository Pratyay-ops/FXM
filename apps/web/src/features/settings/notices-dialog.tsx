import { useRef, useState } from 'react'
import { ExternalLink, standaloneLinkClasses, textLinkClasses } from '../connect/ui'
import { Dialog } from '../now-playing/dialog'
import type { BundledNotices } from './bundled-notices'

/** What the dialog shows: the notices once read, or why they couldn't be. */
type Notices =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly text: string }
  | { readonly state: 'failed'; readonly reason: string }

/** A rejection's reason as a sentence: the shell rejects with its message as a string. */
function reasonOf(error: unknown): string {
  if (typeof error === 'string' && error !== '') return error
  if (error instanceof Error && error.message !== '') return error.message
  return 'FXM couldn’t read its third-party notices.'
}

export interface BundledNoticesButtonProps {
  /** Reads the notices the app carries (`bundledNotices()`). */
  readonly read: BundledNotices
  /** The notices on FXM's site, offered when the app has none of its own. */
  readonly siteHref: string
}

/**
 * Settings → About's "Third-party notices" in an app that carries its own (the desktop app): a
 * button that shows them in a dialog. They are read on first opening and kept, so opening them
 * again reads nothing; a read that failed is tried again on the next opening.
 */
export function BundledNoticesButton({ read, siteHref }: BundledNoticesButtonProps) {
  const [open, setOpen] = useState(false)
  const [notices, setNotices] = useState<Notices>({ state: 'loading' })
  // Only the latest read may show its result: one from an earlier opening can finish later.
  const reads = useRef(0)

  const show = () => {
    setOpen(true)
    if (notices.state === 'ready') return
    const id = ++reads.current
    setNotices({ state: 'loading' })
    read().then(
      (text) => {
        if (id === reads.current) setNotices({ state: 'ready', text })
      },
      (error: unknown) => {
        if (id === reads.current) setNotices({ state: 'failed', reason: reasonOf(error) })
      },
    )
  }

  return (
    <>
      <button type="button" className={standaloneLinkClasses} onClick={show}>
        Third-party notices
      </button>
      <Dialog
        open={open}
        title="Third-party notices"
        description="The open-source code in this app, from others, with its licences."
        onClose={() => setOpen(false)}
        className="md:w-[min(48rem,calc(100vw-2rem))]"
      >
        {notices.state === 'loading' && (
          <p role="status" className="py-2 text-sm text-text-muted">
            Loading the notices…
          </p>
        )}
        {notices.state === 'ready' && (
          <section
            aria-label="Third-party notices"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets the keyboard scroll the long text, as a pointer can
            tabIndex={0}
            className="rounded-md bg-elevated p-3"
          >
            <pre className="font-mono text-xs break-words whitespace-pre-wrap text-text">
              {notices.text}
            </pre>
          </section>
        )}
        {notices.state === 'failed' && (
          <div className="space-y-2 py-2 text-sm">
            <p role="alert">{notices.reason}</p>
            <p className="text-text-muted">
              The notices of the web app that FXM shows are also on FXM’s site:{' '}
              <ExternalLink href={siteHref} className={textLinkClasses}>
                third-party notices
              </ExternalLink>
              .
            </p>
          </div>
        )}
      </Dialog>
    </>
  )
}
