import { useQuery } from '@tanstack/react-query'
import { PageTitle } from '../../components/ui/page'
import { ExternalLink, textLinkClasses } from '../connect/ui'
import { fetchBundledNotices } from './notices'
import { SITE_NOTICES_URL } from './settings-page'

/**
 * Settings → About → Third-party notices in the Android app (stage 6.6): the notices file that
 * the APK carries, read from the app itself (notices.ts). A build without one, such as a debug
 * build, says so and points to the website's notices of the web app.
 */
export function NoticesPage() {
  const notices = useQuery({
    queryKey: ['bundled-notices'],
    queryFn: () => fetchBundledNotices(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  return (
    <div className="max-w-3xl space-y-4 pt-2 md:pt-4">
      <PageTitle hideOnPhone>Third-party notices</PageTitle>
      <p className="text-text-muted">
        FXM is open source under the Apache License 2.0. It includes open-source software by others,
        each under its own licence. These are their notices and licences.
      </p>
      {notices.isPending ? (
        <p role="status" className="text-text-muted">
          Loading the notices…
        </p>
      ) : notices.isError ? (
        <p>
          This build of FXM carries no notices file.{' '}
          <ExternalLink href={SITE_NOTICES_URL} className={textLinkClasses}>
            The web app's notices
          </ExternalLink>{' '}
          are on FXM's website.
        </p>
      ) : (
        <pre className="rounded-xl border border-border bg-surface p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere sm:p-5">
          {notices.data}
        </pre>
      )}
    </div>
  )
}
