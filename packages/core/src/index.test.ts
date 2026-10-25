import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_TAGLINE } from './index'

describe('@fxm/core', () => {
  it('exports the product name and tagline', () => {
    expect(APP_NAME).toBe('FXM')
    expect(APP_TAGLINE).toBe('Free Cross-platform Media')
  })
})
