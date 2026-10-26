/**
 * React hooks of the import pages: where imports stand as this tab sees them (its runner, and
 * the imports other tabs run), and whether imports can find songs here.
 *
 * @module
 */

import { useEffect, useMemo, useReducer, useState } from 'react'
import type { RunnerView } from './format'
import { importsHeldElsewhere } from './locks'
import { useImportRunner, watchConnection } from './runner'
import type { ImportServices, ImportServicesAccess, MatchingAvailability } from './services'

/** How often the pages ask which imports other tabs run, in milliseconds. */
const ELSEWHERE_POLL_MS = 3000

const NONE: ReadonlySet<string> = new Set()

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id))
}

/**
 * The imports another tab runs or records now, from their Web Locks, asked every few seconds
 * while `watch` is on (some import is `running` or `pending` by its record).
 */
export function useImportsElsewhere(watch: boolean): ReadonlySet<string> {
  const [held, setHeld] = useState<ReadonlySet<string>>(NONE)
  useEffect(() => {
    if (!watch) {
      setHeld(NONE)
      return
    }
    let live = true
    const check = () => {
      importsHeldElsewhere().then(
        (ids) => {
          if (live) setHeld((current) => (sameIds(current, ids) ? current : ids))
        },
        () => {},
      )
    }
    check()
    const timer = setInterval(check, ELSEWHERE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [watch])
  return held
}

/** What this tab knows about the imports beyond their records (see `shownStatus`). */
export function useRunnerView(watchElsewhere: boolean): RunnerView {
  const activeId = useImportRunner((runner) => runner.activeId)
  const queued = useImportRunner((runner) => runner.queued)
  const recording = useImportRunner((runner) => runner.recording)
  const elsewhere = useImportsElsewhere(watchElsewhere)
  return useMemo(
    () => ({ activeId, queued, recording, elsewhere }),
    [activeId, queued, recording, elsewhere],
  )
}

/**
 * Whether imports can find songs here, following the platform's capabilities; `undefined` until
 * the services exist. It creates them, which sends no request: they only reach the network once
 * an import runs or a link loads. Once they exist, the imports that paused while offline resume
 * when the connection is back.
 */
export function useMatchingAvailability(
  access: ImportServicesAccess,
): MatchingAvailability | undefined {
  const [services, setServices] = useState<ImportServices | undefined>(access.current)
  const [, refresh] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (services !== undefined) return
    let live = true
    access.get().then(
      (ready) => {
        if (live) setServices(ready)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [access, services])
  useEffect(() => services?.subscribeCapabilities(refresh), [services])
  useEffect(() => {
    if (services !== undefined) watchConnection(services)
  }, [services])
  return services?.matching()
}
