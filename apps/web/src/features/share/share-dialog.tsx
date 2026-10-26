import { Check, Copy, Link, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { SegmentedControl, type SegmentedOption } from '../../components/ui/segmented-control'
import { EmbedPlayerView } from '../../embed/components/layouts'
import type { EmbedLayout, EmbedTheme } from '../../embed/target'
import { previewView } from '../../embed/view'
import { useMediaQuery } from '../../lib/use-media-query'
import { useSettingsStore } from '../settings/settings-store'
import { PREFERS_LIGHT_QUERY } from '../settings/theme'
import { embedCode, shareOrigin } from './embed-code'
import { type ShareRequest, useShareStore } from './share-store'

const LAYOUT_OPTIONS: readonly SegmentedOption<EmbedLayout>[] = [
  { value: 'card', label: 'Card' },
  { value: 'compact', label: 'Compact' },
]

const THEME_OPTIONS: readonly SegmentedOption<EmbedTheme>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const NOUNS = { track: 'song', album: 'album', playlist: 'playlist' } as const

/** What the copy buttons said last. */
type CopyState = { what: 'code' | 'link'; ok: boolean } | undefined

/** Copies `text`; `false` when the browser refuses (no clipboard, or no permission). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * The share dialog: the embed code of a track, album or playlist, with its layout and theme,
 * a preview of the player in that layout and theme, and buttons that copy the code or the
 * player's link, which stay in view at the bottom. The player plays in the app's catalog mode.
 */
export function ShareDialog({ request, onClose }: { request: ShareRequest; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const codeField = useRef<HTMLTextAreaElement>(null)
  const ids = { title: useId(), help: useId(), layout: useId(), theme: useId(), code: useId() }
  const mode = useSettingsStore((state) => state.catalogMode)
  const [layout, setLayout] = useState<EmbedLayout>('card')
  const [theme, setTheme] = useState<EmbedTheme>('auto')
  const [copied, setCopied] = useState<CopyState>(undefined)
  // `auto` follows each visitor's setting: the preview shows what this device's setting gives.
  const prefersLight = useMediaQuery(PREFERS_LIGHT_QUERY)
  const previewTheme = theme === 'auto' ? (prefersLight ? 'light' : 'dark') : theme
  // What the copy buttons said goes away with the code it was about.
  const changeLayout = (next: EmbedLayout) => {
    setLayout(next)
    setCopied(undefined)
  }
  const changeTheme = (next: EmbedTheme) => {
    setTheme(next)
    setCopied(undefined)
  }
  const { target, info } = request
  const origin = shareOrigin(window.location.origin)
  const code = useMemo(
    () => embedCode(target, { layout, theme, mode }, info.title, origin),
    [target, layout, theme, mode, info.title, origin],
  )
  const view = useMemo(
    () => previewView(target, layout, info, origin),
    [target, layout, info, origin],
  )
  const noun = NOUNS[target.kind]

  useEffect(() => {
    // Modal: focus moves in, the rest of the app is inert, and Escape closes it. There is no
    // close() on cleanup: React's StrictMode runs the cleanup and the effect again at once, and
    // the close event a close() queues would end the dialog it had just reopened. Unmounting
    // takes the dialog out of the top layer without one.
    const element = dialog.current
    if (element !== null && !element.open) element.showModal()
  }, [])

  async function copy(what: 'code' | 'link') {
    const ok = await copyText(what === 'code' ? code.html : code.url)
    if (!ok && what === 'code') codeField.current?.select()
    setCopied({ what, ok })
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={ids.title}
      aria-describedby={ids.help}
      // Only a dialog that is closed now: never a close event left over from an earlier close.
      onClose={(event) => {
        if (!event.currentTarget.open) onClose()
      }}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/60"
    >
      <div className="space-y-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={ids.title} className="text-xl font-bold tracking-tight">
              Share this {noun}
            </h2>
            <p id={ids.help} className="mt-1 text-sm text-text-muted">
              Put a player for "{info.title}" on your website: copy the code into your page.
            </p>
          </div>
          <IconButton label="Close" icon={<X />} onClick={() => dialog.current?.close()} />
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <div className="space-y-2">
            <p id={ids.layout} className="text-sm font-semibold">
              Layout
            </p>
            <SegmentedControl
              label="Layout"
              labelledBy={ids.layout}
              value={layout}
              options={LAYOUT_OPTIONS}
              onChange={changeLayout}
              size="sm"
            />
          </div>
          <div className="space-y-2">
            <p id={ids.theme} className="text-sm font-semibold">
              Theme
            </p>
            <SegmentedControl
              label="Theme"
              labelledBy={ids.theme}
              value={theme}
              options={THEME_OPTIONS}
              onChange={changeTheme}
              size="sm"
            />
          </div>
        </div>

        {/* The preview only shows: the visitor's player is the copied code. */}
        <div
          aria-hidden="true"
          inert
          data-testid="embed-preview"
          data-theme={previewTheme}
          className="overflow-hidden rounded-xl border border-border"
          style={{ height: code.height }}
        >
          <EmbedPlayerView view={view} as="div" />
        </div>

        <div className="space-y-2">
          <label htmlFor={ids.code} className="text-sm font-semibold">
            Embed code
          </label>
          <textarea
            ref={codeField}
            id={ids.code}
            readOnly
            rows={4}
            value={code.html}
            onFocus={(event) => event.currentTarget.select()}
            className="block w-full resize-none rounded-lg border border-border-strong bg-elevated p-3 font-mono text-xs break-all text-text"
          />
          <p className="text-xs text-text-muted">
            {theme === 'auto' && "Auto follows each visitor's light or dark setting. "}
            {mode === 'all' && 'It plays in Music + Video mode, like your app. '}
            Visitors play YouTube Music through the experimental Lite tier, which needs no install,
            where their browser allows it: FXM Connect isn't used inside other sites.
          </p>
          <p className="text-xs text-text-muted">
            Once your page shows the player, each visitor's browser loads the {noun}'s details and
            cover art from its source, such as YouTube, even before they press play. That source
            then sees their IP address, so mention it in your site's privacy notice.
          </p>
        </div>
      </div>

      {/* The copy buttons stay in view while the rest scrolls. */}
      <div className="sticky bottom-0 border-t border-border bg-surface px-5 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void copy('code')} className={buttonClasses()}>
            {copied?.what === 'code' && copied.ok ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            Copy embed code
          </button>
          <button
            type="button"
            onClick={() => void copy('link')}
            className={buttonClasses({ variant: 'secondary' })}
          >
            <Link aria-hidden="true" />
            Copy player link
          </button>
          <p role="status" className="text-sm text-text-muted">
            {copied === undefined
              ? ''
              : copied.ok
                ? copied.what === 'code'
                  ? 'Embed code copied'
                  : 'Player link copied'
                : copied.what === 'code'
                  ? 'Copying was blocked: the code is selected, press Ctrl+C or ⌘C'
                  : 'Copying was blocked: copy the link from the code'}
          </p>
        </div>
      </div>
    </dialog>
  )
}

/** The app's one share dialog, open while the share store holds a request. */
export function ShareDialogHost() {
  const request = useShareStore((state) => state.request)
  const close = useShareStore((state) => state.close)
  if (request === undefined) return null
  return <ShareDialog key={request.target.id} request={request} onClose={close} />
}
