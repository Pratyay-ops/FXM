import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { EmbedPlayerView } from './components/layouts'
import type { EmbedActions } from './components/parts'
import type { EmbedController } from './controller'
import { EMBED_HEIGHTS, type EmbedLayout } from './target'
import { embedView } from './view'

/** Keeps the document title in step with what plays: "Title · FXM player". */
function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title === undefined ? 'FXM player' : `${title} · FXM player`
  }, [title])
}

/**
 * The embed: the player for the controller's content, in the address's layout. In another
 * site's iframe it fills the frame, with a hairline edge so a light player stands out on a
 * white page. Opened as a page of its own (a shared player link), it sits centred at the size
 * its layout is designed for, on the page's background.
 */
export function EmbedApp({
  controller,
  layout,
  origin,
  standalone = false,
}: {
  controller: EmbedController
  layout: EmbedLayout
  /** The embed's own origin, for its links. */
  origin: string
  /** Whether the player is the top-level page rather than a frame. */
  standalone?: boolean
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  const view = useMemo(
    () =>
      embedView(state, {
        layout,
        target: controller.target,
        origin,
        attribution: controller.attributionOf,
      }),
    [state, layout, controller, origin],
  )
  const actions = useMemo<EmbedActions>(
    () => ({
      play: (index) => controller.play(index),
      toggle: () => controller.toggle(),
      next: () => controller.next(),
      previous: () => controller.previous(),
      seek: (ms) => controller.seek(ms),
      retry: () => controller.retry(),
    }),
    [controller],
  )
  useDocumentTitle(view.title)
  if (!standalone) {
    return (
      <EmbedPlayerView
        view={view}
        actions={actions}
        className="rounded-[12px] ring-1 ring-border ring-inset"
      />
    )
  }
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-4">
      <div
        data-testid="embed-box"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border shadow-lg"
        style={{ height: EMBED_HEIGHTS[layout][controller.target.kind] }}
      >
        <EmbedPlayerView view={view} actions={actions} />
      </div>
    </div>
  )
}

/** What an address that names no embed shows. */
export function InvalidEmbed({ origin }: { origin: string }) {
  useDocumentTitle(undefined)
  return (
    <main
      aria-label="FXM player"
      className="flex h-full items-center justify-center gap-3 bg-surface p-3 text-center text-sm text-text-muted"
    >
      <p>
        This player link isn't valid.{' '}
        <a
          href={new URL('/app/', origin).href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-text underline underline-offset-2"
        >
          Open FXM
        </a>
      </p>
    </main>
  )
}
