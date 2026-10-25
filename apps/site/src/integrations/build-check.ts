import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'
import { checkSite } from '../lib/build-check'

const TEXT_FILE = /\.(html|xml|txt)$/

/**
 * Runs src/lib/build-check.ts on the build output and fails the build when it finds a
 * problem. List it after @astrojs/sitemap so the sitemap exists when it runs.
 */
export function buildCheck(options: { externalPaths?: readonly string[] } = {}): AstroIntegration {
  let site: string | undefined
  return {
    name: 'fxm:build-check',
    hooks: {
      'astro:config:done': ({ config }) => {
        site = config.site
      },
      'astro:build:done': async ({ dir, logger }) => {
        if (!site) throw new Error('fxm:build-check needs `site` in astro.config.ts')
        const root = fileURLToPath(dir)
        const files = new Map<string, string | null>()
        for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue
          const path = join(entry.parentPath, entry.name)
          const file = relative(root, path).split(sep).join('/')
          files.set(file, TEXT_FILE.test(file) ? await readFile(path, 'utf8') : null)
        }

        const problems = checkSite({ site, files, externalPaths: options.externalPaths })
        if (problems.length > 0) {
          const list = problems.map((problem) => `  ${problem.file}: ${problem.message}`).join('\n')
          throw new Error(`The build check found ${problems.length} problem(s):\n${list}`)
        }
        const pages = [...files.keys()].filter((file) => file.endsWith('.html')).length
        logger.info(`${pages} pages passed: metadata, canonical URLs, links, scripts and sitemap`)
      },
    },
  }
}
