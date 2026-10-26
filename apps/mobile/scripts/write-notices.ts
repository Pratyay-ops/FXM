/**
 * Writes the Android app's third-party notices (notices.ts) for `release-apk.sh build`, and fails,
 * naming every problem, when the APK would bundle code FXM may not ship:
 *
 *   node --experimental-strip-types scripts/write-notices.ts <library report> <web notices> <out>
 *
 * <library report> is Gradle's (`./gradlew fxmLibraryReport`), <web notices> make dist's
 * `dist/pages/third-party-notices.txt`, and <out> the file to write.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apkNotices, parseLibraryReport } from './notices.ts'

const [reportFile, webFile, outFile, ...extra] = process.argv.slice(2)
if (reportFile === undefined || webFile === undefined || outFile === undefined || extra.length) {
  console.error('usage: write-notices.ts <library report> <web notices> <out file>')
  process.exit(2)
}

try {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const result = apkNotices({
    report: parseLibraryReport(readFileSync(reportFile, 'utf8')),
    web: readFileSync(webFile, 'utf8'),
    apacheLicence: readFileSync(join(root, 'LICENSE'), 'utf8'),
    root,
  })
  if (result.problems.length > 0) {
    console.error(
      `\u001b[31m✘\u001b[0m The APK would bundle code FXM may not ship:\n${result.problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    )
    process.exit(1)
  }
  writeFileSync(outFile, result.text)
  console.log(
    `\u001b[32m✔\u001b[0m Third-party notices for ${result.listed.length} Android libraries and packages, and the web app: ${outFile}`,
  )
} catch (error) {
  console.error(`\u001b[31m✘\u001b[0m ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
