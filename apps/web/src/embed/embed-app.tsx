import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { EmbedPlayerView } from './components/layouts'
import type { EmbedActions } from './components/parts'
import type { EmbedController } from './controller'
import type { EmbedLayout } from './target'
import { embedView } from './view'

/** Keeps the document title in step with what plays: "Title · FXM player". */
function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title === undefined ? 'FXM player' : `${title} · FXM player`
  }, [title])
}

/** The embed: the player for the controller's content, in the address's layout. */
export function EmbedApp({
  controller,
  layout,
  origin,
}: {
  controller: EmbedController
  layout: EmbedLayout
  /** The embed's own origin, for its links. */
  origin: string
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
  return <EmbedPlayerView view={view} actions={actions} />
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
