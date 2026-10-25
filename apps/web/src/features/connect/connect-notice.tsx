/**
 * The shell's notice about the connection, above every page except the onboarding page itself:
 * the upgrade prompt for an outdated FXM Connect, the "isn't answering" prompt for a disabled or
 * blocked one, and, on a first visit without FXM Connect, what works here and how to get more.
 *
 * @module
 */

import { MIN_CONNECT_VERSION } from '@fxm/platform'
import { Sparkles, TriangleAlert, X } from 'lucide-react'
import { useId } from 'react'
import { Link, useLocation } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { buttonClasses } from '../../components/ui/button'
import { IconButton } from '../../components/ui/icon-button'
import { type ConnectionState, forgetConnect, useConnection } from './connection'
import { type Notice, noticeFor, useNotices } from './notices'

/** What the notice reads: not the budget, which changes with every YouTube request. */
type NoticeInputs = Pick<
  ConnectionState,
  'phase' | 'platform' | 'capabilities' | 'connect' | 'lite'
>

interface NoticeCopy {
  readonly title: string
  readonly body: string
  readonly action: { readonly label: string; readonly to: string }
  readonly warning: boolean
}

function copyFor(notice: Notice, state: NoticeInputs): NoticeCopy {
  const lite = state.lite === 'passed'
  switch (notice.kind) {
    case 'outdated':
      return {
        title: 'Update FXM Connect',
        body: `${state.connect?.version === undefined ? 'This FXM Connect' : `FXM Connect ${state.connect.version}`} is too old for this version of FXM, which needs ${MIN_CONNECT_VERSION} or later.${
          lite ? ' Meanwhile, FXM uses the experimental Lite tier.' : ''
        }`,
        action: { label: 'How to update', to: '/connect#update' },
        warning: true,
      }
    case 'missing':
      return {
        title: "FXM Connect isn't answering",
        body: `It worked in this browser before, but it may now be turned off, removed or blocked. Turn it back on, or use the desktop app or the Android app, which need no extension.${
          lite ? ' Meanwhile, FXM uses the experimental Lite tier.' : ''
        }`,
        action: { label: 'What to do', to: '/connect#missing' },
        warning: true,
      }
    case 'intro':
      return lite
        ? {
            title: 'YouTube Music works here without an install',
            body: 'This browser passed the check for the experimental Lite tier. For Spotify, add the free FXM Connect extension or use one of the apps.',
            action: { label: 'See your options', to: '/connect' },
            warning: false,
          }
        : {
            title: 'This browser plays free music',
            body: 'Internet Archive and Jamendo work here. For YouTube Music and Spotify, add the free FXM Connect extension or use one of the apps.',
            action: { label: 'See your options', to: '/connect' },
            warning: false,
          }
  }
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
  const titleId = useId()
  const notice = noticeFor(state)
  if (notice === undefined || pathname === '/connect' || dismissed.includes(notice.id)) return null
  const copy = copyFor(notice, state)
  const Icon = copy.warning ? TriangleAlert : Sparkles

  return (
    <section
      aria-labelledby={titleId}
      className="mb-6 flex gap-3 rounded-xl border border-accent/40 bg-accent/8 p-4 sm:items-start sm:gap-4"
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        {/* Not a heading: the notice comes before the page's own <h1>. */}
        <p id={titleId} className="font-bold">
          {copy.title}
        </p>
        <p className="mt-1 text-sm text-text-muted">{copy.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={copy.action.to} className={buttonClasses()}>
            {copy.action.label}
          </Link>
          {notice.kind === 'missing' && (
            <button
              type="button"
              className={buttonClasses({ variant: 'ghost' })}
              onClick={forgetConnect}
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
        className="-mt-1.5 -mr-1.5"
        onClick={() => dismiss(notice.id)}
      />
    </section>
  )
}
