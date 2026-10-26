import { describe, expect, it, vi } from 'vitest'
import { NOTICES_COMMAND, readThirdPartyNotices } from './notices'
import type { ShellInvoke } from './shell'

/** Tauri's `invoke`, faked: it answers the notices command with `answer`. */
function fakeInvoke(answer: () => Promise<unknown>) {
  return vi.fn(async (command: string) => {
    if (command !== NOTICES_COMMAND) throw new Error(`unexpected command ${command}`)
    return answer()
  }) as unknown as ShellInvoke & ReturnType<typeof vi.fn>
}

describe('readThirdPartyNotices', () => {
  it('reads the notices that the shell carries, with no arguments', async () => {
    const invoke = fakeInvoke(async () => 'FXM desktop app: third-party notices\n')
    await expect(readThirdPartyNotices({ invoke })).resolves.toBe(
      'FXM desktop app: third-party notices\n',
    )
    expect(invoke).toHaveBeenCalledWith(NOTICES_COMMAND)
  })

  it('loads Tauri’s bindings first when given a loader', async () => {
    const invoke = fakeInvoke(async () => 'notices')
    const load = vi.fn(async () => ({ invoke }))
    await expect(readThirdPartyNotices(load)).resolves.toBe('notices')
    expect(load).toHaveBeenCalledOnce()
  })

  it('passes on why the shell has none, such as a build without the file', async () => {
    const reason = 'This build of FXM carries no third-party notices file: release builds do.'
    const invoke = fakeInvoke(() => Promise.reject(reason))
    await expect(readThirdPartyNotices({ invoke })).rejects.toBe(reason)
  })

  it('refuses an answer that is no text', async () => {
    const invoke = fakeInvoke(async () => ({ notices: 'not like this' }))
    await expect(readThirdPartyNotices({ invoke })).rejects.toThrow(/no third-party notices/)
  })
})
