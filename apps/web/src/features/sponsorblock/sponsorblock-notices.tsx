import { currentQueueItem } from '@fxm/core'
import { FastForward, Undo2, X } from 'lucide-react'
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { usePlayerState } from '../now-playing/playback'
import { useSettingsStore } from '../settings/settings-store'
import { type SkipNotice, undoLastSkip, useSkipNoticeStore } from './skipping'
import { syncSponsorBlockAcrossTabs, useSponsorBlockStore } from './sponsorblock-store'

/** How long a skip notice stays, unless the pointer or focus is on it. */
export const SKIP_NOTICE_MS = 8000

/**
 * The offer to turn SponsorBlock on, which the first Music + Video session shows until the user
 * answers it. Focus inside it moves to the page's main content once it is gone.
 */
function SponsorBlockOffer() {
  const titleId = useId()
  const setEnabled = useSponsorBlockStore((state) => state.setEnabled)
  const dismissOffer = useSponsorBlockStore((state) => state.dismissOffer)
  const card = useRef<HTMLElement>(null)

  const answer = (enable: boolean) => {
    const hadFocus = card.current?.contains(document.activeElement) ?? false
    if (enable) setEnabled(true)
    else dismissOffer()
    // The buttons leave with the card: don't strand keyboard focus on the page's body.
    if (hadFocus) document.getElementById('main')?.focus({ preventScroll: true })
  }

  return (
    <section
      ref={card}
      aria-labelledby={titleId}
      className="pointer-events-auto rounded-xl border border-border bg-surface p-4 shadow-xl transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0"
    >
      <div className="flex gap-3">
        {/* Phones need the width for the text. */}
        <FastForward
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-accent max-sm:hidden"
        />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-semibold">
            Skip the non-music parts of videos?
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            SponsorBlock’s community marks the intros, skits and outros of music videos. FXM never
            tells SponsorBlock which video you play. You can change this in Settings.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClasses()} onClick={() => answer(true)}>
              Turn on
            </button>
            <button
              type="button"
              className={buttonClasses({ variant: 'secondary' })}
              onClick={() => answer(false)}
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

/** "Skipped a non-music part", with "Undo" while the track it happened in still plays. */
function SkipNoticeCard({ notice }: { notice: SkipNotice }) {
  const dismiss = useSkipNoticeStore((state) => state.dismiss)
  const playingUid = usePlayerState((state) => currentQueueItem(state.queue)?.uid)
  const canUndo = !notice.toEnd && playingUid === notice.uid
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const stop = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const start = useCallback(() => {
    stop()
    timer.current = setTimeout(dismiss, SKIP_NOTICE_MS)
  }, [dismiss, stop])
  // Keyed by notice, so each new skip starts the clock again.
  useEffect(() => {
    start()
    return stop
  }, [start, stop])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only hold the clock while the pointer or focus is on the notice; its buttons are the controls
    <div
      className="pointer-events-auto flex min-h-14 items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pr-1.5 pl-4 shadow-xl transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0"
      onPointerEnter={stop}
      onPointerLeave={start}
      onFocus={stop}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) start()
      }}
    >
      <FastForward aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">Skipped a non-music part</span>
        <span className="block truncate text-text-muted">{notice.title}</span>
      </p>
      {canUndo && (
        <button
          type="button"
          className={buttonClasses({ variant: 'ghost', className: 'px-3 text-text' })}
          onClick={() => undoLastSkip()}
        >
          <Undo2 aria-hidden="true" />
          Undo
        </button>
      )}
      <IconButton label="Dismiss" icon={<X />} size="sm" onClick={dismiss} />
    </div>
  )
}

/**
 * SponsorBlock's place in the app shell, above the player bar or the mini player: the offer to
 * turn it on in Music + Video mode, until answered (not on Settings, which has the switch
 * itself), and the notice after each skip. Also keeps the setting in step with other tabs.
 */
export function SponsorBlockNotices() {
  const { pathname } = useLocation()
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const offered = useSponsorBlockStore((state) => state.offered)
  const notice = useSkipNoticeStore((state) => state.notice)
  const showOffer = catalogMode === 'all' && !offered && pathname !== '/settings'
  const stack = useRef<HTMLDivElement>(null)
  const covered = useCoveredHeight(stack, showOffer || notice !== undefined)

  useEffect(() => syncSponsorBlockAcrossTabs(), [])

  return (
    <>
      {/* Room at the end of the page, so its last content can scroll clear of the cards. */}
      {covered > 0 && <div aria-hidden="true" style={{ height: covered }} />}
      <div
        ref={stack}
        className="pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+0.75rem)] z-30 flex flex-col gap-2 px-gutter md:left-auto md:w-96 md:pr-4 md:pl-0"
      >
        <div role="status" aria-label="Skip notice">
          {notice !== undefined && <SkipNoticeCard key={notice.id} notice={notice} />}
        </div>
        {showOffer && <SponsorBlockOffer />}
      </div>
    </>
  )
}

/**
 * How much of the page the cards cover above the bars, in pixels, while `active`. Meanwhile the
 * page's `scroll-padding-bottom` grows by as much, so the browser scrolls keyboard focus clear
 * of them (WCAG 2.4.11), as it does for the bars (`--shell-bottom`).
 */
function useCoveredHeight(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || element === null) {
      setHeight(0)
      return
    }
    const root = document.documentElement
    const update = () => {
      // The cards, plus the gap between them and the bars.
      const covered = element.offsetHeight > 0 ? element.offsetHeight + 12 : 0
      setHeight(covered)
      root.style.scrollPaddingBottom =
        covered > 0 ? `calc(var(--shell-bottom) + ${covered}px + 0.5rem)` : ''
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      root.style.scrollPaddingBottom = ''
    }
  }, [ref, active])
  return height
}
