import { isFxmError, type LyricLine, type Lyrics, type QueueItem } from '@fxm/core'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LocateFixed, MicVocal, RotateCcw } from 'lucide-react'
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { getPlayer, useCurrentItem, usePlayerEvent } from '../now-playing/playback'
import { scrollBehavior } from '../now-playing/scroll'
import { useSettingsStore } from '../settings/settings-store'
import { awaitsMatch, lyricsTrackFor } from './lyrics-source'
import { useActiveLyric } from './use-active-lyric'
import { lyricsQuery, useLyrics } from './use-lyrics'

/** How long the lyrics stop following the song after the user scrolls them or leaves them. */
const FOLLOW_PAUSE_MS = 4000

/** Keys that scroll the lyrics box. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/** Widths of the loading placeholder's lines; unique, so they double as keys. */
const SKELETON_LINES = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-3/5', 'w-4/5']

/**
 * The lyrics box: tall enough to read a verse. On phones it is clearly shorter than the screen,
 * and a swipe that reaches its top or bottom goes on to scroll the page. From 768px it fills the
 * column next to the artwork, down to the player bar, and keeps the wheel to itself. Lines fade
 * out at its edges instead of being cut, and the scroll padding keeps a focused line clear of
 * the fade.
 */
const BOX =
  'relative h-[min(26rem,50dvh)] scroll-py-14 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,#000_3rem,#000_calc(100%-3.5rem),transparent)] md:overscroll-contain'

/** From 768px: the room between the bars, less the tabs above and the credit below. */
const SYNCED_BOX = `${BOX} md:h-[max(20rem,calc(100dvh-var(--shell-top)-var(--shell-bottom)-8rem))]`

/** Plain lyrics also have a note above them. */
const PLAIN_BOX = `${BOX} md:h-[max(20rem,calc(100dvh-var(--shell-top)-var(--shell-bottom)-10rem))]`

/**
 * Looks up the next track's lyrics while the current one ends, so they show at once. Not for a
 * track the player has yet to match: what to look up depends on the match, found when it plays.
 */
function usePrefetchNextLyrics() {
  const queryClient = useQueryClient()
  usePlayerEvent('preload', ({ next }) => {
    const mode = useSettingsStore.getState().catalogMode
    if (awaitsMatch(next, mode)) return
    void queryClient.prefetchQuery(lyricsQuery(lyricsTrackFor(next), mode))
  })
}

/** Where the lyrics came from, with a link to the service. */
function Attribution({ lyrics }: { lyrics: Lyrics }) {
  const source =
    lyrics.source === 'lrclib' ? (
      <a
        href="https://lrclib.net"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline-offset-2 hover:text-text hover:underline"
      >
        LRCLIB
      </a>
    ) : (
      lyrics.source
    )
  return <p className="mt-3 text-xs text-text-muted">Lyrics from {source}</p>
}

/** A line's text; on the line being sung, the words sung so far stand out. */
function LineText({ line, word }: { line: LyricLine; word: number | undefined }): ReactNode {
  if (line.text.trim() === '') {
    return (
      <>
        <span aria-hidden="true">♪</span>
        <span className="sr-only">Instrumental</span>
      </>
    )
  }
  const { words } = line
  if (word === undefined || words === undefined || words.length === 0) return line.text
  // The line opts out of forced colors (to mark it), so its words name system colors.
  const sungClass = 'text-text forced-colors:text-[Highlight]'
  const comingClass = 'text-text-muted forced-colors:text-[CanvasText]'
  return words.map((sung, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a line's words never change order
    <span key={index} className={index <= word ? sungClass : comingClass}>
      {sung.text}
    </span>
  ))
}

/** Where ArrowUp, ArrowDown, Home or End moves the focus among `count` lines, if anywhere. */
function lineTarget(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'ArrowDown':
      return Math.min(count - 1, index + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}

/** Whether `element` got its focus from the keyboard (or a script after a key), not a click. */
function hasKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return false
  }
}

/** The line index a lyric button carries in `data-line`, or `undefined`. */
function lineIndexOf(target: EventTarget): number | undefined {
  if (!(target instanceof HTMLElement) || target.dataset.line === undefined) return undefined
  const index = Number(target.dataset.line)
  return Number.isInteger(index) ? index : undefined
}

interface LyricLineProps {
  index: number
  line: LyricLine
  /** Whether this is the line being sung. */
  current: boolean
  /** On the current line, the word being sung. */
  word: number | undefined
  /** Whether Tab stops here: the line in focus, or else the current line. */
  tabStop: boolean
  hintId: string
  register: (index: number, node: HTMLButtonElement | null) => void
  onSeek: (index: number) => void
}

/**
 * One line of synced lyrics: a button that plays the song from it. Memoized, so a new line or
 * word re-renders only the lines it changes.
 */
const LyricLineButton = memo(function LyricLineButton({
  index,
  line,
  current,
  word,
  tabStop,
  hintId,
  register,
  onSeek,
}: LyricLineProps) {
  return (
    <li>
      <button
        ref={(node) => {
          register(index, node)
        }}
        type="button"
        data-line={index}
        tabIndex={tabStop ? 0 : -1}
        aria-current={current ? 'true' : undefined}
        aria-describedby={hintId}
        onClick={() => onSeek(index)}
        className={cn(
          // A tint marks the line under the pointer, so it never looks like the sung one.
          'block w-full rounded-md px-2 py-1.5 text-left text-2xl font-bold tracking-tight transition-colors duration-200 hover:bg-text/5 md:text-3xl',
          // Forced colors paint every line alike: mark the sung one in Highlight.
          current
            ? 'text-text forced-colors:text-[Highlight] forced-colors:forced-color-adjust-none'
            : 'text-text-muted/75',
        )}
      >
        <LineText line={line} word={word} />
      </button>
    </li>
  )
})

/**
 * Synced lyrics: the line being sung is highlighted and kept in view, and selecting a line plays
 * the song from there. The lines are one Tab stop: the arrow keys, Home and End move between
 * them. Scrolling the lyrics stops the following for a few seconds, and so does keyboard focus
 * on a line, until it leaves the lyrics.
 */
function SyncedLyrics({ lyrics }: { lyrics: Lyrics }) {
  const active = useActiveLyric(lyrics)
  const box = useRef<HTMLDivElement>(null)
  const lines = useRef<(HTMLButtonElement | null)[]>([])
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Focus that "Current line" moves to the line, which must not stop the following.
  const followFocus = useRef(false)
  // Stopped by looking around (a wheel, a swipe, the scroll keys) or by focus that left.
  const [paused, setPaused] = useState(false)
  // Stopped while the keyboard is on a line, so that line stays in view.
  const [keyboardInside, setKeyboardInside] = useState(false)
  // The line in focus: it is the Tab stop while focus is in the lyrics.
  const [focused, setFocused] = useState<number>()
  const following = !paused && !keyboardInside
  const hintId = useId()
  const count = lyrics.lines.length
  const current = Math.max(0, active.line)
  const tabStop = focused !== undefined && focused < count ? focused : current

  useEffect(() => {
    if (!following) return
    const container = box.current
    const target = lines.current[current]
    if (container === null || target === null || target === undefined) return
    // A third of the way down, so the lines to come show below it.
    const top = target.offsetTop + target.offsetHeight / 2 - container.clientHeight / 3
    container.scrollTo?.({ top: Math.max(0, top), behavior: scrollBehavior() })
  }, [current, following])

  const pause = useCallback(() => {
    clearTimeout(resumeTimer.current)
    setPaused(true)
    resumeTimer.current = setTimeout(() => setPaused(false), FOLLOW_PAUSE_MS)
  }, [])

  // Looking around the lyrics (a wheel, a swipe, the scroll keys) pauses the following.
  useEffect(() => {
    const container = box.current
    if (container === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) pause()
    }
    container.addEventListener('wheel', pause, { passive: true })
    container.addEventListener('touchmove', pause, { passive: true })
    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('wheel', pause)
      container.removeEventListener('touchmove', pause)
      container.removeEventListener('keydown', onKeyDown)
      clearTimeout(resumeTimer.current)
    }
  }, [pause])

  const register = useCallback((index: number, node: HTMLButtonElement | null) => {
    lines.current[index] = node
  }, [])

  const seek = useCallback(
    (index: number) => {
      getPlayer().seek(lyrics.lines[index]?.timeMs ?? 0)
      clearTimeout(resumeTimer.current)
      setPaused(false)
    },
    [lyrics],
  )

  /** "Current line": follows the song again. */
  const follow = (event: MouseEvent<HTMLButtonElement>) => {
    clearTimeout(resumeTimer.current)
    setPaused(false)
    setKeyboardInside(false)
    // The button goes away: its focus moves to the sung line, without stopping the following.
    if (document.activeElement !== event.currentTarget) return
    followFocus.current = true
    lines.current[current]?.focus({ preventScroll: true })
    followFocus.current = false
  }

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const index = lineIndexOf(event.target)
    const target = index === undefined ? undefined : lineTarget(event.key, index, count)
    if (target === undefined) return
    event.preventDefault()
    lines.current[target]?.focus()
  }

  const onFocus = (event: FocusEvent<HTMLOListElement>) => {
    const index = lineIndexOf(event.target)
    if (index !== undefined) setFocused(index)
    if (followFocus.current || !hasKeyboardFocus(event.target)) return
    clearTimeout(resumeTimer.current)
    setKeyboardInside(true)
  }

  const onBlur = (event: FocusEvent<HTMLOListElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return
    }
    // Focus left the lyrics: Tab comes back to the sung line, and the following resumes soon.
    setFocused(undefined)
    if (!keyboardInside) return
    setKeyboardInside(false)
    pause()
  }

  return (
    <div>
      <p id={hintId} className="sr-only">
        Plays the song from this line.
      </p>
      <div className="relative">
        <div ref={box} className={cn(SYNCED_BOX, 'px-1 pt-16 pb-48 scrollbar-thin')}>
          <ol className="space-y-1" onKeyDown={onKeyDown} onFocus={onFocus} onBlur={onBlur}>
            {lyrics.lines.map((line, index) => (
              <LyricLineButton
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines never change order
                key={index}
                index={index}
                line={line}
                current={index === active.line}
                word={index === active.line ? active.word : undefined}
                tabStop={index === tabStop}
                hintId={hintId}
                register={register}
                onSeek={seek}
              />
            ))}
          </ol>
        </div>
        {!following && (
          <button
            type="button"
            onClick={follow}
            className={buttonClasses({
              variant: 'secondary',
              className: 'absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg',
            })}
          >
            <LocateFixed aria-hidden="true" />
            Current line
          </button>
        )}
      </div>
      <Attribution lyrics={lyrics} />
    </div>
  )
}

/** Lyrics without timing: shown as text, with a note that they won't follow the song. */
function PlainLyrics({ lyrics }: { lyrics: Lyrics }) {
  return (
    <div>
      <p className="mb-3 text-sm text-text-muted">These lyrics aren’t synced to the song.</p>
      <div className={cn(PLAIN_BOX, 'px-2 py-12 scrollbar-thin')}>
        <div className="text-xl font-bold tracking-tight md:text-2xl">
          {lyrics.lines.map((line, index) =>
            line.text === '' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines never change order
              <div key={index} aria-hidden="true" className="h-5" />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines never change order
              <p key={index} className="py-0.5">
                {line.text}
              </p>
            ),
          )}
        </div>
      </div>
      <Attribution lyrics={lyrics} />
    </div>
  )
}

function LyricsLoading() {
  return (
    <div role="status" className="space-y-5 pt-2">
      <span className="sr-only">Loading lyrics…</span>
      {SKELETON_LINES.map((width) => (
        <Skeleton key={width} className={cn('h-6 rounded-full md:h-7', width)} />
      ))}
    </div>
  )
}

function lyricsErrorMessage(error: Error): string {
  if (isFxmError(error, 'RateLimited'))
    return 'LRCLIB asked FXM to slow down. Try again in a minute.'
  if (isFxmError(error, 'Network')) {
    return 'LRCLIB couldn’t be reached. Check your connection, then try again.'
  }
  return 'Something went wrong while loading them. Trying again usually fixes it.'
}

function hasLines(lyrics: Lyrics | null | undefined): lyrics is Lyrics {
  return lyrics !== null && lyrics !== undefined && lyrics.lines.length > 0
}

/** The lyrics of what `item` plays, in every state of the lookup. */
function TrackLyrics({ item }: { item: QueueItem }) {
  const query = useLyrics(item)
  // While a changed lookup runs, lyrics found before stay; "no lyrics" waits for the answer.
  if (query.isPending || (query.isPlaceholderData && !hasLines(query.data))) {
    return <LyricsLoading />
  }
  if (query.isError) {
    return (
      <EmptyState
        icon={CircleAlert}
        title="Couldn’t load the lyrics"
        description={lyricsErrorMessage(query.error)}
        headingLevel={3}
        className="py-10"
        action={
          <button
            type="button"
            className={buttonClasses({ variant: 'secondary' })}
            onClick={() => void query.refetch()}
          >
            <RotateCcw aria-hidden="true" />
            Try again
          </button>
        }
      />
    )
  }
  if (!hasLines(query.data)) {
    return (
      <EmptyState
        icon={MicVocal}
        title="No lyrics for this song"
        description={`LRCLIB has no lyrics for “${item.track.title}” yet.`}
        headingLevel={3}
        className="py-10"
      />
    )
  }
  return query.data.synced ? (
    <SyncedLyrics lyrics={query.data} />
  ) : (
    <PlainLyrics lyrics={query.data} />
  )
}

/** The lyrics tab of Now playing: synced lyrics of the current track, with tap-to-seek. */
export function LyricsPanel() {
  const item = useCurrentItem()
  usePrefetchNextLyrics()
  if (item === undefined) {
    return (
      <EmptyState
        icon={MicVocal}
        title="Nothing playing"
        description="Lyrics show here while a song plays, and follow along with it."
        headingLevel={3}
        className="py-10"
      />
    )
  }
  return <TrackLyrics key={item.uid} item={item} />
}
