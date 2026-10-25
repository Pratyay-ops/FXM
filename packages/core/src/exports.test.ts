import { describe, expect, it } from 'vitest'
import * as core from './index'

describe('the @fxm/core entry point', () => {
  it.each([
    ['ids', ['SOURCE_IDS', 'ENTITY_KINDS', 'formatId', 'parseId', 'isEntityId', 'isSourceId']],
    ['mode', ['CATALOG_MODES', 'CATALOG_MODE_LABELS', 'modePolicy', 'applyModeFilter']],
    ['mode helpers', ['DEFAULT_CATALOG_MODE', 'isVideoKind', 'isCatalogMode']],
    ['quality', ['QUALITY_TIERS', 'tierOf', 'isLosslessCodec', 'compareTiers']],
    ['downloads', ['DOWNLOAD_FORMATS', 'describeConversion', 'containerExtension']],
    ['preferences', ['DEFAULT_QUALITY_PREFS', 'MP3_BITRATES', 'LOSSY_TIER_THRESHOLDS']],
    ['text', ['normalizeText', 'splitTitle', 'stripPresentationNoise', 'extractVersionTags']],
    ['errors', ['FxmError', 'FXM_ERROR_CODES', 'isFxmError']],
  ])('re-exports the %s module', (_module, names) => {
    for (const name of names) expect(core).toHaveProperty(name)
  })

  it('keeps the product name and tagline', () => {
    expect(core.APP_NAME).toBe('FXM')
    expect(core.APP_TAGLINE).toBe('Free Cross-platform Media')
  })
})
