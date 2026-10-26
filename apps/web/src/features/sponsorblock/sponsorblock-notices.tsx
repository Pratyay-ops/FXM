import { currentQueueItem } from '@fxm/core'
import { FastForward, Undo2, X } from 'lucide-react'
import {
  type FocusEvent,
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
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'
import { usePlayerState } from '../now-playing/playback'
import { useSettingsStore } from '../settings/settings-store'
import { type SkipNotice, type SkipPart, undoLastSkip, useSkipNoticeStore } from './skipping'
import {
  isOfferSession,
  startOfferSession,
  syncSponsorBlockAcrossTabs,
  useSponsorBlockStore,
} from './sponsorblock-store'

/**
 * How long a notice without an action stays: the skip of an outro, the answer to the offer. The
 * clock stops while the pointer or focus is on it. A notice with Undo stays while Undo works.
 */
export const SKIP_NOTICE_MS = 8000

/** Phones: below `md`, where Now playing has its own controls under the cover. */
export const PHONE_QUERY = '(width < 48rem)'

/** Windows too short for the offer between the bars: landscape phones, high zoom. */
export const SHORT_QUERY = '(height < 24rem)'

/** What the notice says for each part. */
const SKIPPED: Readonly<Record<SkipPart, string>> = {
  intro: 'Skipped the intro',
  outro: 'Skipped the outro',
  other: 'Skipped a non-music part',
}

/** What the confirmation says after the offer was answered. */
const ANSWERS = {
  on: { title: 'Skipping is on', text: 'You can turn it off in Settings.' },
  off: { title: 'Skipping stays off', text: 'You can turn it on in Settings.' },
} as const

/** The user's answer to the offer, confirmed for a few seconds. */
interface Answer {
  /** Tells answers apart. */
  id: number
  enabled: boolean
}

const answerText = ({ enabled }: Answer) => ANSWERS[enabled ? 'on' : 'off']

/** What screen readers hear for each card. */
const spoken = {
  skip: (notice: SkipNotice) => `${SKIPPED[notice.part]}: ${notice.title}.`,
  answer: (answer: Answer) => `${answerText(answer).title}. ${answerText(answer).text}`,
}

/**
 * Keeps keyboard focus from falling to the page's body when a card goes. `onFocus` notes where
 * focus came from as it enters the card; `handBack()` returns it there while it is still inside,
 * or else to the page's main content, without scrolling the page. The card does that by itself
 * when it unmounts with focus inside: replaced by a newer notice, or dismissed by a track change
 * or another tab.
 */
function useFocusReturn<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const origin = useRef<HTMLElement | null>(null)

  const onFocus = useCallback((event: FocusEvent<T>) => {
    const from = event.relatedTarget
    // Moving between the card's own buttons keeps where focus first came from.
    if (from instanceof Node && event.currentTarget.contains(from)) return
    origin.current = from instanceof HTMLElement ? from : null
  }, [])

  const handBack = useCallback(() => {
    const card = ref.current
    if (card === null || !card.contains(document.activeElement)) return
    const target = origin.current
    if (target?.isConnected && !card.contains(target)) {
      target.focus({ preventScroll: true })
      if (document.activeElement === target) return
    }
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [])

  // React runs this cleanup before it removes the card, while focus is still inside.
  useLayoutEffect(() => handBack, [handBack])

  return { ref, onFocus, handBack }
}

/**
 * Calls `close` once SKIP_NOTICE_MS have passed while `timed`, counting only while neither the
 * pointer nor focus is on the card: the clock stops when either arrives and starts again once
 * both have left. Returns the card's handlers.
 */
function useAutoClose(close: () => void, timed: boolean) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!timed || hovered || focused) return
    const timer = setTimeout(close, SKIP_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [close, timed, hovered, focused])

  return {
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
    },
  }
}

/** Where the skip notice shows: under Now playing's controls on phones, else above the bars. */
function useNoticePlacement(): 'inline' | 'stack' {
  const { pathname } = useLocation()
  const phone = useMediaQuery(PHONE_QUERY)
  return pathname === '/now-playing' && phone ? 'inline' : 'stack'
}

/**
 * Whether the offer shows: in Music + Video mode until the user chooses, in the first session
 * that shows it only, when the window has room for it, and not on Settings (which has the
 * switch) or Now playing (whose controls must stay clear).
 */
function useOfferVisible(): boolean {
  const { pathname } = useLocation()
  const catalogMode = useSettingsStore((state) => state.catalogMode)
  const offered = useSponsorBlockStore((state) => state.offered)
  const offerShown = useSponsorBlockStore((state) => state.offerShown)
  const short = useMediaQuery(SHORT_QUERY)
  if (catalogMode !== 'all' || offered || short) return false
  if (pathname === '/settings' || pathname === '/now-playing') return false
  return !offerShown || isOfferSession()
}

/**
 * The offer to turn SponsorBlock on. Phones get the title, one sentence and the buttons; a short
 * window scrolls it between the bars. Answering hands keyboard focus back.
 */
function SponsorBlockOffer({ onAnswer }: { onAnswer: (enabled: boolean) => void }) {
  const titleId = useId()
  const textId = useId()
  const markOfferShown = useSponsorBlockStore((state) => state.markOfferShown)
  const { ref, onFocus, handBack } = useFocusReturn<HTMLElement>()

  // From now on this session shows the offer until it is answered, and later sessions don't.
  useEffect(() => {
    startOfferSession()
    markOfferShown()
  }, [markOfferShown])

  const answer = (enabled: boolean) => {
    handBack()
    onAnswer(enabled)
  }

  return (
    <section
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={textId}
      onFocus={onFocus}
      className="pointer-events-auto max-h-[calc(100dvh-var(--shell-top)-var(--shell-bottom)-1.5rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-3 shadow-xl transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0 sm:p-4"
    >
      <div className="flex gap-3">
        {/* Phones need the width for the text. */}
        <FastForward
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-accent max-sm:hidden"
        />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-semibold">
            Skip non-music parts of videos?
          </h2>
          <p id={textId} className="mt-0.5 text-sm text-text-muted">
            <span className="max-sm:hidden">
              SponsorBlock’s community marks the intros, skits and outros of music videos.{' '}
            </span>
            SponsorBlock never learns what you play.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2 sm:mt-3">
            <button type="button" className={buttonClasses()} onClick={() => answer(true)}>
              Turn on
            </button>
            <button
              type="button"
              className={buttonClasses({ variant: 'secondary' })}
              onClick={() => answer(false)}
            >
              No thanks
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

/** "Skipping is on" and where to change it, for a few seconds after the offer was answered. */
function AnswerNotice({ answer, onClose }: { answer: Answer; onClose: () => void }) {
  const { title, text } = answerText(answer)
  const hold = useAutoClose(onClose, true)
  return (
    <div
      // The announcer says the same to screen readers. The handlers only hold the clock.
      aria-hidden="true"
      className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-xl transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0"
      onPointerEnter={hold.onPointerEnter}
      onPointerLeave={hold.onPointerLeave}
    >
      <FastForward className="size-4 shrink-0 text-accent max-sm:hidden" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{title}.</span>{' '}
        <span className="text-text-muted">{text}</span>
      </p>
    </div>
  )
}

/**
 * The notice after a skip: what was skipped, in which track, and Undo while the skipper can
 * undo it. It stays as long as Undo works; a notice without Undo (an outro, which ended the
 * track) goes by itself. `inline` puts it in the page, under Now playing's controls on phones.
 * Undo and Dismiss hand keyboard focus back to where it came from.
 */
function SkipNoticeCard({ notice, inline = false }: { notice: SkipNotice; inline?: boolean }) {
  const dismiss = useSkipNoticeStore((state) => state.dismiss)
  const playingUid = usePlayerState((state) => currentQueueItem(state.queue)?.uid)
  const canUndo = notice.part !== 'outro' && playingUid === notice.uid
  const headingId = useId()
  const { ref, onFocus, handBack } = useFocusReturn<HTMLElement>()
  const hold = useAutoClose(dismiss, !canUndo)

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      className={cn(
        'flex min-h-14 items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pr-1.5 pl-4',
        inline
          ? 'mt-4'
          : 'pointer-events-auto shadow-xl transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0',
      )}
      onPointerEnter={hold.onPointerEnter}
      onPointerLeave={hold.onPointerLeave}
      onFocus={(event) => {
        onFocus(event)
        hold.onFocus()
      }}
      onBlur={hold.onBlur}
    >
      <FastForward aria-hidden="true" className="size-4 shrink-0 text-accent max-sm:hidden" />
      <p className="min-w-0 flex-1 text-sm">
        <span id={headingId} className="block font-semibold">
          {SKIPPED[notice.part]}
        </span>
        {/* Wraps rather than truncates: a long title must not widen Now playing's column. */}
        <span className="line-clamp-2 text-text-muted wrap-anywhere">{notice.title}</span>
      </p>
      {canUndo && (
        <button
          type="button"
          // `!`: buttonClasses' own padding and colour would win otherwise.
          className={buttonClasses({ variant: 'ghost', className: 'px-3! text-text!' })}
          onClick={() => {
            handBack()
            undoLastSkip()
          }}
        >
          <Undo2 aria-hidden="true" className="max-sm:hidden" />
          Undo
        </button>
      )}
      <IconButton
        label="Dismiss"
        icon={<X />}
        size="sm"
        onClick={() => {
          handBack()
          dismiss()
        }}
      />
    </section>
  )
}

/**
 * Says what the cards say, for screen readers, wherever the card itself shows: each new skip and
 * each answer is added to a polite live region, which speaks additions only.
 */
function Announcer({
  notice,
  answer,
}: {
  notice: SkipNotice | undefined
  answer: Answer | undefined
}) {
  return (
    <div role="status" aria-label="SponsorBlock" aria-atomic="false" className="sr-only">
      {notice !== undefined && <p key={`skip-${notice.id}`}>{spoken.skip(notice)}</p>}
      {answer !== undefined && <p key={`answer-${answer.id}`}>{spoken.answer(answer)}</p>}
    </div>
  )
}

/**
 * The skip notice on Now playing on phones, rendered under the player controls: there it covers
 * none of them, as a card above the bars would. Renders nothing anywhere else.
 */
export function InlineSkipNotice() {
  const notice = useSkipNoticeStore((state) => state.notice)
  const placement = useNoticePlacement()
  if (placement !== 'inline' || notice === undefined) return null
  // Keyed by notice, so each new skip is a new card.
  return <SkipNoticeCard key={notice.id} notice={notice} inline />
}

/**
 * SponsorBlock's place in the app shell, above the player bar or the mini player: the offer to
 * turn it on (see `useOfferVisible`), the confirmation of the answer, and the notice after each
 * skip (on Now playing on phones, `InlineSkipNotice` shows it instead). Screen readers hear them
 * through one live region. Also keeps the setting in step with other tabs.
 */
export function SponsorBlockNotices() {
  const notice = useSkipNoticeStore((state) => state.notice)
  const placement = useNoticePlacement()
  const showOffer = useOfferVisible()
  const setEnabled = useSponsorBlockStore((state) => state.setEnabled)
  const dismissOffer = useSponsorBlockStore((state) => state.dismissOffer)
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)
  const answers = useRef(0)
  const closeAnswer = useCallback(() => setAnswer(undefined), [])
  const stackNotice = placement === 'stack' ? notice : undefined
  const stack = useRef<HTMLDivElement>(null)
  const covered = useCoveredHeight(
    stack,
    showOffer || answer !== undefined || stackNotice !== undefined,
  )

  useEffect(() => syncSponsorBlockAcrossTabs(), [])

  const onAnswer = (enabled: boolean) => {
    if (enabled) setEnabled(true)
    else dismissOffer()
    answers.current += 1
    setAnswer({ id: answers.current, enabled })
  }

  return (
    <>
      <Announcer notice={notice} answer={answer} />
      {/* Room at the end of the page, so its last content can scroll clear of the cards. */}
      {covered > 0 && <div aria-hidden="true" style={{ height: covered }} />}
      <div
        ref={stack}
        className="pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+0.75rem)] z-30 flex flex-col gap-2 px-gutter md:left-auto md:w-96 md:pr-4 md:pl-0"
      >
        {/* Keyed, so each new skip or answer is a new card with its own clock. */}
        {stackNotice !== undefined && <SkipNoticeCard key={stackNotice.id} notice={stackNotice} />}
        {answer !== undefined && (
          <AnswerNotice key={answer.id} answer={answer} onClose={closeAnswer} />
        )}
        {showOffer && <SponsorBlockOffer onAnswer={onAnswer} />}
      </div>
    </>
  )
}

/**
 * The root's CSS variable with the height the cards cover above the bars, unset while they cover
 * none: the app's toast (`FeedbackToast`) rises by as much, so it never hides a card's buttons.
 */
export const CARDS_HEIGHT_PROPERTY = '--shell-cards'

/**
 * How much of the page the cards cover above the bars, in pixels, while `active`. Meanwhile the
 * page's `scroll-padding-bottom` grows by as much, so the browser scrolls keyboard focus clear
 * of them (WCAG 2.4.11), as it does for the bars (`--shell-bottom`), and so does the toast's
 * place (`CARDS_HEIGHT_PROPERTY`).
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
      if (covered > 0) root.style.setProperty(CARDS_HEIGHT_PROPERTY, `${covered}px`)
      else root.style.removeProperty(CARDS_HEIGHT_PROPERTY)
    }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      root.style.scrollPaddingBottom = ''
      root.style.removeProperty(CARDS_HEIGHT_PROPERTY)
    }
  }, [ref, active])
  return height
}
