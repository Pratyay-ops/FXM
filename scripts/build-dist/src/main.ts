/** `make dist`: compose dist/pages (see README.md). */
import { relative } from 'node:path'
import { compose } from './compose.ts'
import { PARTS, spawnRunner } from './parts.ts'
import { PAGES_DIR, REPOSITORY_URL, ROOT, STAGING_DIR } from './paths.ts'

const log = (message: string) => console.log(`\u001b[32m✔\u001b[0m ${message}`)

try {
  const started = Date.now()
  const result = compose({
    root: ROOT,
    parts: PARTS,
    stagingDir: STAGING_DIR,
    outDir: PAGES_DIR,
    run: spawnRunner(ROOT),
    log,
    repositoryUrl: REPOSITORY_URL,
  })
  const size = (result.bytes / 1024 / 1024).toFixed(2)
  const packages = result.packages.map((pkg) => `${pkg.name} ${pkg.version}`).sort()
  log(`Third-party packages (${packages.length}): ${packages.join(', ') || 'none'}`)
  log(
    `${relative(ROOT, PAGES_DIR)}: ${result.built.join(', ')}; ${result.files} files, ${size} MiB, ` +
      `${result.rules} header rules, ${result.redirects} rewrites, in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  )
  if (result.skipped.length > 0) log(`Not built yet: ${result.skipped.join(', ')}`)
} catch (error) {
  console.error(`\u001b[31m✘\u001b[0m ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
