import { appendFileSync, writeFileSync } from 'node:fs'
import { expect, type TestInfo } from '@playwright/test'
import { BUDGETS, type Budget } from './budgets'

// How a budget run reports: a table of each measurement against its budget, printed, written with
// the files it counts as JSON into the test's results folder (test-results/budgets/, which CI
// uploads when the job fails) and attached to the test, and added to the GitHub Actions job
// summary when there is one. Every budget is checked (softly, so one run names every budget it
// exceeds).

/** One measurement of a budget. */
export interface Measured {
  readonly budget: Budget
  readonly value: number
  /** What it is made of, or how it varied. */
  readonly detail?: string
}

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 }

/** Bytes in kB (1,000 bytes), with one decimal: `442.4 kB`. */
export function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toLocaleString('en-US', ONE_DECIMAL)} kB`
}

/** A value in the budget's unit: kB (1,000 bytes), milliseconds, or a layout shift score. */
export function format(budget: Budget, value: number): string {
  if (budget === 'cls') return value.toFixed(3)
  if (budget === 'lcp' || budget === 'inp') return `${Math.round(value).toLocaleString('en-US')} ms`
  return kilobytes(value)
}

/** The rows of the table: budget, measured, limit, how much of it is used, and the detail. */
export function rows(measured: readonly Measured[]): string[][] {
  return measured.map(({ budget, value, detail }) => {
    const limit: number = BUDGETS[budget]
    const used = limit === 0 ? '' : `${Math.round((value / limit) * 100)} %`
    return [
      value <= limit ? 'ok' : 'OVER',
      budget,
      format(budget, value),
      format(budget, limit),
      used,
      detail ?? '',
    ]
  })
}

/** Which report: its file's name in the test's results folder (`<name>.json`), and its title. */
export interface ReportName {
  readonly name: string
  readonly title: string
}

/**
 * Reports the measurements (console, `<name>.json` with `data` in the test's results folder and
 * attached to the test, the job summary), then checks each against its budget.
 */
export async function report(
  testInfo: TestInfo,
  { name, title }: ReportName,
  measured: readonly Measured[],
  data: unknown,
): Promise<void> {
  const table = rows(measured)
  const header = ['', 'budget', 'measured', 'limit', 'used', 'detail']
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...table.map((row) => (row[column] ?? '').length)),
  )
  const line = (row: readonly string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  console.log(`\n${title}\n${[header, ...table].map(line).join('\n')}\n`)
  // On disk, so the results folder keeps every file a budget counted when the run fails.
  const json = testInfo.outputPath(`${name}.json`)
  writeFileSync(json, `${JSON.stringify({ title, measured, budgets: BUDGETS, data }, null, 2)}\n`)
  await testInfo.attach(`${name}.json`, { path: json, contentType: 'application/json' })
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary !== undefined && summary !== '') {
    const markdown = [
      `### ${title}`,
      '',
      `| ${header.join(' | ')} |`,
      `|${header.map(() => ' --- ').join('|')}|`,
      ...table.map((row) => `| ${row.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`),
      '',
    ].join('\n')
    appendFileSync(summary, `${markdown}\n`)
  }
  for (const { budget, value } of measured) {
    expect.soft(value, `${budget}: ${format(budget, value)}`).toBeLessThanOrEqual(BUDGETS[budget])
  }
}
