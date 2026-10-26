import { APP_BASE } from '../../../../pwa/base'
import { ExternalLink, textLinkClasses } from '../../connect/ui'

/** The site's third-party notices, as FXM's own site serves them. */
const PUBLIC_NOTICES_URL = 'https://fxmusic.pages.dev/third-party-notices.txt'

/**
 * Where the third-party notices are: at the root of the deploy that serves the web app (its
 * `/app/` build), else on FXM's own site. They name every part of the ffmpeg core with its
 * licence, its source and how to replace it (tools/ffmpeg-wasm).
 */
export function noticesUrl(base: string = import.meta.env.BASE_URL): string {
  return base === APP_BASE ? '/third-party-notices.txt' : PUBLIC_NOTICES_URL
}

/**
 * The credit for the ffmpeg core, in a sentence: the LGPL asks for prominent notice that the
 * libraries are used, FFmpeg's checklist for a mention with a link to the sources, and LAME for
 * an acknowledgement with a link to its site.
 */
export function ConverterCredit({ className }: { className?: string }) {
  return (
    <p className={className}>
      Save to device converts with code of{' '}
      <ExternalLink href="https://ffmpeg.org/" className={textLinkClasses}>
        FFmpeg
      </ExternalLink>
      , licensed under the LGPLv2.1,{' '}
      <ExternalLink href="https://lame.sourceforge.io/" className={textLinkClasses}>
        LAME
      </ExternalLink>{' '}
      (LGPL) and{' '}
      <ExternalLink href="https://opus-codec.org/" className={textLinkClasses}>
        Opus
      </ExternalLink>{' '}
      (BSD), built by FXM into a file you may replace:{' '}
      <ExternalLink href={noticesUrl()} className={textLinkClasses}>
        licences and sources
      </ExternalLink>
      .
    </p>
  )
}

/** Settings → About's entry for the converter. */
export function ConverterAbout() {
  return (
    <div className="p-4 text-sm text-text-muted sm:p-5">
      <p className="font-semibold text-text">Audio conversion</p>
      <ConverterCredit className="mt-1" />
    </div>
  )
}
