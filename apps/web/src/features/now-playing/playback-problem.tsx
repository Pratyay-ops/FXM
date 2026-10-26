import { isFxmError } from '@fxm/core'
import type { PlayerError } from '@fxm/player'
import { CircleAlert, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { buttonClasses } from '../../components/ui/button'
import { connectOrApps } from '../connect/explain'
import { getPlayer, usePlayerState } from './playback'
import { isInView, isPhoneLayout, scrollBehavior } from './scroll'

/** Why playback stopped, as {@link describeProblem} puts it. */
export interface ProblemText {
  title: string
  text: string
}

/** What went wrong, in words, with what the user can do about it. */
export function describeProblem({ reason, error, item }: PlayerError): ProblemText {
  if (reason === 'circuit-open') {
    return {
      title: 'Playback stopped',
      text: 'Several songs in a row couldn’t play. Check your connection, then try again.',
    }
  }
  if (reason === 'action-required') {
    const code = isFxmError(error) ? error.code : undefined
    if (code === 'AuthRequired') {
      return { title: 'Sign-in needed', text: 'This song’s service wants you to sign in first.' }
    }
    if (code === 'BotCheck') {
      return {
        title: 'Playback paused by the source',
        text: 'The source wants to check that a person is listening. Wait a while, then try again.',
      }
    }
    return {
      title: 'This song can’t play here',
      text: `This browser can’t reach its source. ${connectOrApps()} can play more songs.`,
    }
  }
  return {
    title: `Couldn’t play “${item.track.title}”`,
    text: 'It may be unavailable right now. Try again, or pick another song.',
  }
}

/**
 * Why playback stopped, while it is stopped, with a way to try again: under the controls on
 * Now playing. Screen readers hear it from {@link PlaybackAnnouncer}. On phones, where the
 * lyrics and the queue sit under the track, it scrolls into view when it appears while the user
 * is down there, say after selecting a song in the queue that can't play.
 */
export function PlaybackProblem() {
  const problem = usePlayerState((state) => state.error)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = box.current
    if (problem === undefined || element === null || !isPhoneLayout() || isInView(element)) return
    element.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() })
  }, [problem])

  if (problem === undefined) return null
  const { title, text } = describeProblem(problem)
  return (
    <div ref={box} className="mt-4 flex gap-3 rounded-xl bg-danger/12 p-4">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="mt-1 text-sm text-text-muted">{text}</p>
        <button
          type="button"
          className={buttonClasses({ variant: 'secondary', className: 'mt-3 h-10 px-4' })}
          onClick={() => void getPlayer().play()}
        >
          <RotateCcw aria-hidden="true" />
          Try again
        </button>
      </div>
    </div>
  )
}

/**
 * Tells screen readers why playback stopped, once for each problem, on whatever page they are:
 * one polite live region for the whole app (the app layout renders it). The player bar and the
 * mini player show the problem as "Couldn’t play".
 */
export function PlaybackAnnouncer() {
  const problem = usePlayerState((state) => state.error)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (problem === undefined) {
      setMessage('')
      return
    }
    const { title, text } = describeProblem(problem)
    const next = `${title}. ${text}`
    // The same words again (the same song failed again): change the text, so it is read again.
    setMessage((previous) => (previous === next ? `${next} ` : next))
  }, [problem])

  return (
    <p aria-live="polite" className="sr-only">
      {message}
    </p>
  )
}
