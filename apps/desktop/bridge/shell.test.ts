import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopShell,
  parseEnvironment,
  SHELL_COMMANDS,
  SHELL_EVENTS,
  type ShellBindings,
} from './shell'

/** Tauri's bindings, faked: `invoke` answers from `answers`, `listen` records handlers. */
function fakeTauri(answers: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: { payload: unknown }) => void>()
  const unlistened: string[] = []
  let releaseListen: (() => void) | undefined
  const listenGate = { hold: false }
  const bindings: ShellBindings = {
    invoke: vi.fn(async (command: string) => answers[command]) as ShellBindings['invoke'],
    listen: vi.fn(async (event, handler) => {
      if (listenGate.hold) await new Promise<void>((resolve) => (releaseListen = resolve))
      handlers.set(event, handler as (event: { payload: unknown }) => void)
      return () => {
        unlistened.push(event)
        handlers.delete(event)
      }
    }) as ShellBindings['listen'],
  }
  return {
    bindings,
    handlers,
    unlistened,
    listenGate,
    /** Lets a held `listen` finish. */
    releaseListen: () => releaseListen?.(),
    /** Emits `event` from "Rust". */
    emit: (event: string, payload: unknown) => handlers.get(event)?.({ payload }),
  }
}

/** Lets pending promise chains run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createDesktopShell', () => {
  it('tells the shell what plays, leaving out what the player does not know', async () => {
    const tauri = fakeTauri()
    const shell = createDesktopShell({ bindings: tauri.bindings })
    await shell.setNowPlaying({ playing: true, title: 'Creep', artist: 'Radiohead' })
    await shell.setNowPlaying({ playing: false })
    expect(tauri.bindings.invoke).toHaveBeenNthCalledWith(1, SHELL_COMMANDS.setNowPlaying, {
      now: { playing: true, title: 'Creep', artist: 'Radiohead' },
    })
    expect(tauri.bindings.invoke).toHaveBeenNthCalledWith(2, SHELL_COMMANDS.setNowPlaying, {
      now: { playing: false },
    })
  })

  it('asks where the app runs', async () => {
    const answer = { os: 'macos', osVersion: '15.5.0', webviewVersion: '620.2', tray: true }
    const shell = createDesktopShell({
      bindings: fakeTauri({ [SHELL_COMMANDS.environment]: answer }).bindings,
    })
    await expect(shell.environment()).resolves.toEqual(answer)
  })

  it('passes on valid media actions from the tray and nothing else', async () => {
    const tauri = fakeTauri()
    const shell = createDesktopShell({ bindings: tauri.bindings })
    const actions: string[] = []
    shell.onMediaAction((action) => actions.push(action))
    await flush()
    for (const payload of ['toggle', 'next', 'previous', 'stop', 42, null]) {
      tauri.emit(SHELL_EVENTS.mediaAction, payload)
    }
    expect(actions).toEqual(['toggle', 'next', 'previous'])
  })

  it('reports network changes, whatever their payload', async () => {
    const tauri = fakeTauri()
    const shell = createDesktopShell({ bindings: tauri.bindings })
    const changes = vi.fn()
    shell.onNetworkChange(changes)
    await flush()
    tauri.emit(SHELL_EVENTS.networkChange, null)
    expect(changes).toHaveBeenCalledOnce()
  })

  it('stops a subscription even before Tauri has registered it', async () => {
    const tauri = fakeTauri()
    tauri.listenGate.hold = true
    const shell = createDesktopShell({ bindings: tauri.bindings })
    const actions = vi.fn()
    const stop = shell.onMediaAction(actions)
    await flush()
    stop()
    tauri.releaseListen()
    await flush()
    expect(tauri.unlistened).toEqual([SHELL_EVENTS.mediaAction])
    tauri.emit(SHELL_EVENTS.mediaAction, 'toggle')
    expect(actions).not.toHaveBeenCalled()
  })

  it('stops a registered subscription', async () => {
    const tauri = fakeTauri()
    const shell = createDesktopShell({ bindings: tauri.bindings })
    const stop = shell.onNetworkChange(() => {})
    await flush()
    stop()
    stop()
    expect(tauri.unlistened).toEqual([SHELL_EVENTS.networkChange])
  })

  it('loads the bindings once, and again after a failed load', async () => {
    const tauri = fakeTauri()
    const load = vi
      .fn<() => Promise<ShellBindings>>()
      .mockRejectedValueOnce(new Error('not in Tauri'))
      .mockResolvedValue(tauri.bindings)
    const onError = vi.fn()
    const shell = createDesktopShell({ bindings: load, onError })
    await expect(shell.setNowPlaying({ playing: false })).rejects.toThrow('not in Tauri')
    await shell.setNowPlaying({ playing: false })
    await shell.environment()
    expect(load).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a subscription that fails', async () => {
    const onError = vi.fn()
    const shell = createDesktopShell({
      bindings: async () => {
        throw new Error('no runtime')
      },
      onError,
    })
    shell.onMediaAction(() => {})
    await flush()
    expect(onError).toHaveBeenCalledWith(new Error('no runtime'))
  })
})

describe('parseEnvironment', () => {
  it('keeps what is well formed and leaves out the rest', () => {
    expect(
      parseEnvironment({ os: 'linux', osVersion: '', webviewVersion: 2, tray: 'yes' }),
    ).toEqual({ os: 'linux', tray: false })
    expect(parseEnvironment(null)).toEqual({ os: 'unknown', tray: false })
    expect(
      parseEnvironment({ os: 'windows', webviewVersion: '142.0.3595.53', tray: true }),
    ).toEqual({ os: 'windows', webviewVersion: '142.0.3595.53', tray: true })
  })
})
