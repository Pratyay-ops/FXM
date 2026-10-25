import { isFxmError, type LyricLine, type Lyrics, type QueueItem } from '@fxm/core'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LocateFixed, MicVocal, RotateCcw } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { cn } from '../../lib/cn'
import { getPlayer, useCurrentItem, usePlayerEvent } from '../now-playing/playback'
import { useSettingsStore } from '../settings/settings-store'
import { lyricsTrackFor } from './lyrics-source'
import { useActiveLyric } from './use-active-lyric'
import { lyricsQuery, useLyrics } from './use-lyrics'

/** How long the lyrics stop following the song after the user scrolls them. */
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
 * The lyrics box: tall enough to read a verse, inside the viewport on every screen. From 768px
 * it fills the column next to the artwork. Lines fade out at its edges instead of being cut, and
 * the scroll padding keeps a focused line clear of the fade.
 */
const BOX =
  'relative h-[min(26rem,60dvh)] scroll-py-14 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,#000_3rem,#000_calc(100%-3.5rem),transparent)] md:h-[max(20rem,calc(100dvh-var(--shell-top)-var(--shell-bottom)-12rem))]'

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Looks up the next track's lyrics while the current one ends, so they show at once. */
function usePrefetchNextLyrics() {
  const queryClient = useQueryClient()
  usePlayerEvent('preload', ({ next }) => {
    const mode = useSettingsStore.getState().catalogMode
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

/**
 * Synced lyrics: the line being sung is highlighted and kept in view, and selecting a line plays
 * the song from there. Scrolling the lyrics stops the following for a few seconds.
 */
function SyncedLyrics({ lyrics }: { lyrics: Lyrics }) {
  const active = useActiveLyric(lyrics)
  const box = useRef<HTMLDivElement>(null)
  const lines = useRef<(HTMLButtonElement | null)[]>([])
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [following, setFollowing] = useState(true)
  const hintId = useId()

  useEffect(() => {
    if (!following) return
    const container = box.current
    const target = lines.current[Math.max(0, active.line)]
    if (container === null || target === null || target === undefined) return
    // A third of the way down, so the lines to come show below it.
    const top = target.offsetTop + target.offsetHeight / 2 - container.clientHeight / 3
    container.scrollTo?.({
      top: Math.max(0, top),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [active.line, following])

  // Looking around the lyrics (a wheel, a swipe, the scroll keys) pauses the following.
  useEffect(() => {
    const container = box.current
    if (container === null) return
    const pause = () => {
      clearTimeout(resumeTimer.current)
      setFollowing(false)
      resumeTimer.current = setTimeout(() => setFollowing(true), FOLLOW_PAUSE_MS)
    }
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [])

  const follow = () => {
    clearTimeout(resumeTimer.current)
    setFollowing(true)
  }

  return (
    <div>
      <p id={hintId} className="sr-only">
        Plays the song from this line.
      </p>
      <div className="relative">
        <div ref={box} className={cn(BOX, 'px-1 pt-16 pb-48 scrollbar-thin')}>
          <ol className="space-y-1">
            {lyrics.lines.map((line, index) => {
              const current = index === active.line
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines never change order
                <li key={index}>
                  <button
                    ref={(node) => {
                      lines.current[index] = node
                    }}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    aria-describedby={hintId}
                    onClick={() => {
                      getPlayer().seek(line.timeMs ?? 0)
                      follow()
                    }}
                    className={cn(
                      'block w-full rounded-md px-2 py-1.5 text-left text-2xl font-bold tracking-tight transition-colors duration-200 md:text-3xl',
                      // Forced colors paint every line alike: mark the sung one in Highlight.
                      current
                        ? 'text-text forced-colors:text-[Highlight] forced-colors:forced-color-adjust-none'
                        : 'text-text-muted hover:text-text',
                    )}
                  >
                    <LineText line={line} word={current ? active.word : undefined} />
                  </button>
                </li>
              )
            })}
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
      <div className={cn(BOX, 'px-2 py-12 scrollbar-thin')}>
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

/** The lyrics of what `item` plays, in every state of the lookup. */
function TrackLyrics({ item }: { item: QueueItem }) {
  const query = useLyrics(item)
  if (query.isPending) return <LyricsLoading />
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
  if (query.data === null || query.data.lines.length === 0) {
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
