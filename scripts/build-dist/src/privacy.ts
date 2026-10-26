/**
 * Every third-party service whose hosts the deployed policies name must be listed on the
 * site's privacy page (docs/PLAN.md, stage 2.8). The policies come from `_headers` itself, so
 * the check covers whatever a stage adds, and each host must belong to a service in
 * APP_SERVICES, whose name the page has to show in its list of services.
 */
import { parsePolicy } from './csp.ts'
import type { HeaderRule } from './headers-file.ts'
import { elementTexts } from './html.ts'
import { APP_SERVICES, type Service } from './policies.ts'

/** The services the privacy page lists: the terms of its description lists. */
export function privacyPageServices(html: string): Set<string> {
  return new Set(elementTexts(html, 'dt'))
}

/** Sources that name a host, such as `https://lrclib.net` or `https://*.archive.org`. */
export function isHostSource(source: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\/./i.test(source) ||
    /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(source)
  )
}

/** Every host the rules' Content-Security-Policies name, with the rules that name it. */
export function policyHosts(rules: readonly HeaderRule[]): Map<string, string[]> {
  const hosts = new Map<string, string[]>()
  for (const rule of rules) {
    for (const [name, value] of rule.headers) {
      if (name.toLowerCase() !== 'content-security-policy') continue
      for (const sources of parsePolicy(value).values()) {
        for (const source of sources.filter(isHostSource)) {
          hosts.set(source, [...(hosts.get(source) ?? []), rule.path])
        }
      }
    }
  }
  return hosts
}

/** Why the privacy page doesn't cover the policies (an empty list when it does). */
export function privacyProblems(
  rules: readonly HeaderRule[],
  privacyHtml: string | undefined,
  services: readonly Service[] = APP_SERVICES,
): string[] {
  if (privacyHtml === undefined) return ['the site has no privacy.html']
  const listed = privacyPageServices(privacyHtml)
  if (listed.size === 0) return ['privacy.html lists no services (no <dt> elements)']
  const problems: string[] = []
  const needed = new Set<string>()
  for (const [host, paths] of policyHosts(rules)) {
    const service = services.find((candidate) =>
      [...(candidate.connect ?? []), ...(candidate.img ?? [])].includes(host),
    )
    if (!service) {
      problems.push(
        `${host} (in ${paths[0]}) belongs to no service in APP_SERVICES (src/policies.ts)`,
      )
    } else {
      needed.add(service.privacyName)
    }
  }
  for (const name of [...needed].sort()) {
    if (!listed.has(name)) {
      problems.push(
        `the privacy page doesn't list ${name}, whose hosts the policies allow: add it to apps/site/src/pages/privacy.astro`,
      )
    }
  }
  return problems
}
