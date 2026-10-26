/**
 * The shell's notice about the connection: the upgrade prompt for an outdated FXM Connect, the
 * "isn't answering" prompt for a disabled or blocked one, and, on a first visit without FXM
 * Connect, what works here and how this device gets more.
 *
 * It floats above the bottom bars (above the mini player on phones, in the corner above the
 * player bar from 768 px), so it never pushes the page down when detection finishes after the
 * page painted; a spacer of its height at the end of the page keeps the last of it reachable.
 * The introduction shows on the tab pages (Home, Search, Library), the warnings on every page
 * except Now playing and the onboarding page, which says the same in place.
 *
 * @module
 */

import { MIN_CONNECT_VERSION } from '@fxm/platform'
import { Sparkles, TriangleAlert, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { type RouteHandle, useRouteHandle } from '../../components/layout/route-meta'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../lib/cn'
import { type ConnectionState, useConnection } from './connection'
import { currentDevice, type DeviceInfo } from './device'
import { howToGetMore } from './explain'
import { type Notice, noticeFor, removedOnPurpose, useNotices } from './notices'
import { type PanelTone, panelButtonClasses, panelIconClasses, panelToneClasses } from './ui'

/** What the notice reads: not the budget, which changes with every YouTube request. */
type NoticeInputs = Pick<
  ConnectionState,
  'phase' | 'platform' | 'capabilities' | 'connect' | 'lite'
>

interface NoticeCopy {
  readonly title: string
  readonly body: string
  readonly action: { readonly label: string; readonly to: string }
  readonly tone: PanelTone
}

/** The notice's words, for this device and what is released. */
export function noticeCopy(notice: Notice, state: NoticeInputs, device: DeviceInfo): NoticeCopy {
  const meanwhile =
    state.lite === 'passed' ? ' Meanwhile, FXM uses the experimental Lite tier.' : ''
  switch (notice.kind) {
    case 'outdated':
      return {
        title: 'Update FXM Connect',
        body: `${state.connect?.version === undefined ? 'This FXM Connect' : `FXM Connect ${state.connect.version}`} is too old for this version of FXM, which needs ${MIN_CONNECT_VERSION} or later.${meanwhile}`,
        action: { label: 'How to update', to: '/connect#update' },
        tone: 'warning',
      }
    case 'missing':
      return {
        title: "FXM Connect isn't answering",
        body: `It worked in this browser before, but it may now be turned off, removed or blocked.${meanwhile}`,
        action: { label: 'What to do', to: '/connect#missing' },
        tone: 'warning',
      }
    case 'intro':
      return state.lite === 'passed'
        ? {
            title: 'Try YouTube Music here without an install (experimental)',
            body: `This browser passed Lite's check. ${howToGetMore(device, 'spotify')}`,
            action: { label: 'See your options', to: '/connect' },
            tone: 'info',
          }
        : {
            title: 'This browser plays free music',
            body: `Internet Archive and Jamendo work here. ${howToGetMore(device, 'youtube-and-spotify')}`,
            action: { label: 'See your options', to: '/connect' },
            tone: 'info',
          }
  }
}

/**
 * Whether a notice shows on a page: never on the onboarding page (it says the same in place) or
 * on Now playing (it would cover the controls), and the introduction only on the tab pages.
 */
export function noticeShowsOn(
  notice: Notice,
  pathname: string,
  handle: RouteHandle | undefined,
): boolean {
  if (pathname === '/connect' || pathname === '/now-playing') return false
  return notice.kind !== 'intro' || handle?.tab === true
}

/** Puts keyboard focus on the page, where it goes when the notice it was in goes away. */
function focusPage(): void {
  document.getElementById('main')?.focus({ preventScroll: true })
}

/**
 * The CSS variable with the room the notice takes above the bottom bars (`0px` without one), so
 * other floating layers, such as the app's toast (`FeedbackToast`), can sit above it:
 * `bottom: calc(var(--shell-bottom) + var(--connect-notice-space, 0px) + 0.75rem)`. The notice
 * itself sits above the cards SponsorBlock stacks over the bars (`--shell-cards`).
 */
export const NOTICE_SPACE_VARIABLE = '--connect-notice-space'

/** The room between the notice and the page's end, or a layer above it, in pixels. */
const NOTICE_GAP = 16

/**
 * The notice's height while it shows, for the spacer at the end of the page, kept in
 * {@link NOTICE_SPACE_VARIABLE} too.
 */
function useHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (element === null) {
      setHeight(0)
      return
    }
    const measure = () => setHeight(element.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty(NOTICE_SPACE_VARIABLE, `${height > 0 ? height + NOTICE_GAP : 0}px`)
    return () => {
      root.removeProperty(NOTICE_SPACE_VARIABLE)
    }
  }, [height])
  return height
}

export function ConnectNotice() {
  const state = useConnection(
    useShallow(
      ({ phase, platform, capabilities, connect, lite }): NoticeInputs => ({
        phase,
        platform,
        capabilities,
        lite,
        ...(connect === undefined ? {} : { connect }),
      }),
    ),
  )
  const dismissed = useNotices((store) => store.dismissed)
  const dismiss = useNotices((store) => store.dismiss)
  const { pathname } = useLocation()
  const handle = useRouteHandle()
  const device = useMemo(currentDevice, [])
  const titleId = useId()
  const [box, setBox] = useState<HTMLElement | null>(null)
  const height = useHeight(box)

  const notice = noticeFor(state)
  const shown =
    notice !== undefined &&
    !dismissed.includes(notice.id) &&
    noticeShowsOn(notice, pathname, handle)
  const copy = shown ? noticeCopy(notice, state, device) : undefined
  const Icon = copy?.tone === 'warning' ? TriangleAlert : Sparkles

  return (
    <>
      {/* Room at the end of the page, so the floating notice never hides the last of it. */}
      {copy !== undefined && <div aria-hidden="true" style={{ height: height + NOTICE_GAP }} />}
      {/* Always in the page, so screen readers announce a notice when it appears. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-safe bottom-[calc(var(--shell-bottom)+var(--shell-cards,0px)+0.25rem)] z-30 px-2 md:right-[calc(var(--safe-right)+var(--spacing-gutter))] md:bottom-[calc(var(--shell-bottom)+var(--shell-cards,0px)+1rem)] md:left-auto md:w-96 md:px-0"
      >
        {copy !== undefined && notice !== undefined && (
          <section
            ref={setBox}
            aria-labelledby={titleId}
            className="pointer-events-auto rounded-xl bg-surface shadow-lg transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0"
          >
            <div
              className={cn(
                'flex gap-3 rounded-xl border p-3 sm:p-4',
                panelToneClasses(copy.tone),
                copy.tone === 'warning' && 'border-l-4',
              )}
            >
              <Icon
                aria-hidden="true"
                className={cn('mt-0.5 size-5 shrink-0', panelIconClasses(copy.tone))}
              />
              <div className="min-w-0 flex-1">
                {/* Not a heading: it isn't part of the page's outline. */}
                <p id={titleId} className="font-bold text-balance">
                  {copy.title}
                </p>
                <p className="mt-1 text-sm text-text-muted">{copy.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link
                    to={copy.action.to}
                    className={copy.tone === 'warning' ? buttonClasses() : panelButtonClasses}
                  >
                    {copy.action.label}
                  </Link>
                  {notice.kind === 'missing' && (
                    <button
                      type="button"
                      className={buttonClasses({ variant: 'ghost' })}
                      onClick={() => {
                        focusPage()
                        removedOnPurpose()
                      }}
                    >
                      I removed it
                    </button>
                  )}
                </div>
              </div>
              <IconButton
                label="Dismiss"
                icon={<X />}
                size="sm"
                className="-mt-1 -mr-1"
                onClick={() => {
                  focusPage()
                  dismiss(notice.id)
                }}
              />
            </div>
          </section>
        )}
      </div>
    </>
  )
}
