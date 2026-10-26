import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_SONG_KEY, installConnectFakes, readFakeSongScenario } from './dev-fakes'
import { getSongResolver, setSongResolver, unavailableResolver } from './resolver'

afterEach(() => {
  sessionStorage.clear()
  setSongResolver(unavailableResolver)
})

describe('readFakeSongScenario', () => {
  it('takes the scenario from the URL and keeps it for the tab', () => {
    expect(readFakeSongScenario('?fake-song=capped')).toBe('capped')
    expect(sessionStorage.getItem(FAKE_SONG_KEY)).toBe('capped')
    expect(readFakeSongScenario('')).toBe('capped')
  })

  it('turns off with ?fake-song=off and ignores unknown scenarios', () => {
    readFakeSongScenario('?fake-song=plays')
    expect(readFakeSongScenario('?fake-song=off')).toBeUndefined()
    expect(readFakeSongScenario('')).toBeUndefined()
    expect(readFakeSongScenario('?fake-song=everything')).toBeUndefined()
  })

  it('still reads the URL when storage is blocked', () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    expect(readFakeSongScenario('?fake-song=fails', blocked)).toBe('fails')
    expect(readFakeSongScenario('', blocked)).toBeUndefined()
  })
})

describe('installConnectFakes', () => {
  it('plugs a fake resolver in only when the tab asked for one', () => {
    installConnectFakes()
    expect(getSongResolver()).toBe(unavailableResolver)

    sessionStorage.setItem(FAKE_SONG_KEY, 'plays')
    installConnectFakes()
    expect(getSongResolver()).not.toBe(unavailableResolver)
    expect(getSongResolver().hasFallback).toBe(true)
  })
})
