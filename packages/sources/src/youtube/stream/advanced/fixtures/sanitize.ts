/**
 * Sanitizing recorded `/player` answers of the experimental rungs before they become fixtures.
 * `../../fixtures/sanitize.ts` (stage 1.4) keeps what the direct rungs read and scrubs every
 * stream URL; these rungs also read each format's `signatureCipher` and `lastModified`, the SABR
 * URL and the ustreamer config, so this adds them back, scrubbed:
 *
 * - a `signatureCipher`'s URL is scrubbed like any stream URL, its `n` becomes `fxm-n-<itag>`
 *   and its scrambled signature {@link FAKE_SIGNATURE};
 * - the SABR URL is scrubbed the same way, keeping `sabr=1`, with `n` set to `fxm-n-sabr`;
 * - the ustreamer config becomes {@link FAKE_USTREAMER_CONFIG}.
 *
 * @module
 */

import { FIXTURE_HOST, sanitizePlayerResponse, sanitizeStreamUrl } from '../../fixtures/sanitize'

/** The scrambled signature of every fixture format. */
export const FAKE_SIGNATURE = 'fxmScrambledSignature.0123456789'

/** The ustreamer config of every fixture: base64 of a few made-up bytes. */
export const FAKE_USTREAMER_CONFIG = 'CgdmeG1maXh0'

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

/** A stream URL scrubbed, with `n` (when it has one) set to `n`. */
function scrubbed(url: string, n: string): string {
  const clean = new URL(sanitizeStreamUrl(url))
  if (clean.searchParams.has('n')) clean.searchParams.set('n', n)
  if (clean.searchParams.has('sabr')) clean.searchParams.set('sabr', '1')
  return clean.href
}

/** A `signatureCipher` scrubbed (see the module notes). */
export function sanitizeSignatureCipher(cipher: string, itag: unknown): string {
  const params = new URLSearchParams(cipher)
  const url = params.get('url')
  const clean = new URLSearchParams()
  if (params.has('s')) clean.set('s', FAKE_SIGNATURE)
  if (params.has('sp')) clean.set('sp', params.get('sp') ?? 'sig')
  if (url !== null) clean.set('url', scrubbed(url, `fxm-n-${String(itag)}`))
  return clean.toString()
}

/** Adds the scrubbed cipher and `lastModified` of `original`'s formats to `clean`'s. */
function restoreFormats(clean: unknown, original: unknown): unknown[] | undefined {
  if (!Array.isArray(clean)) return undefined
  const originals = Array.isArray(original) ? original.map(asObject) : []
  return clean.map((value) => {
    const format = asObject(value)
    if (format === undefined) return value
    const source = originals.find((entry) => entry?.itag === format.itag)
    if (source === undefined) return format
    const cipher = source.signatureCipher ?? source.cipher
    return {
      ...format,
      ...(typeof source.lastModified === 'string' ? { lastModified: source.lastModified } : {}),
      ...(typeof cipher === 'string'
        ? { signatureCipher: sanitizeSignatureCipher(cipher, format.itag) }
        : {}),
    }
  })
}

/** A sanitized copy of a recorded `/player` answer of an experimental rung. */
export function sanitizeAdvancedResponse(json: unknown): unknown {
  const original = asObject(json) ?? {}
  const clean = asObject(sanitizePlayerResponse(json)) ?? {}
  const streaming = asObject(original.streamingData)
  const cleanStreaming = asObject(clean.streamingData)
  if (streaming !== undefined && cleanStreaming !== undefined) {
    const formats = restoreFormats(cleanStreaming.formats, streaming.formats)
    const adaptive = restoreFormats(cleanStreaming.adaptiveFormats, streaming.adaptiveFormats)
    if (formats !== undefined) cleanStreaming.formats = formats
    if (adaptive !== undefined) cleanStreaming.adaptiveFormats = adaptive
    if (typeof streaming.serverAbrStreamingUrl === 'string') {
      cleanStreaming.serverAbrStreamingUrl = scrubbed(streaming.serverAbrStreamingUrl, 'fxm-n-sabr')
    }
  }
  const config = asObject(
    asObject(asObject(original.playerConfig)?.mediaCommonConfig)?.mediaUstreamerRequestConfig,
  )
  if (typeof config?.videoPlaybackUstreamerConfig === 'string') {
    clean.playerConfig = {
      mediaCommonConfig: {
        mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: FAKE_USTREAMER_CONFIG },
      },
    }
  }
  return clean
}

export { FIXTURE_HOST }
