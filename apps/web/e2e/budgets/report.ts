import { appendFileSync } from 'node:fs'
import { expect, type TestInfo } from '@playwright/test'
import { BUDGETS, type Budget } from './budgets'

// How a budget run reports: a table of each measurement against its budget, printed, attached to
// the test as JSON, and added to the GitHub Actions job summary when there is one. Every budget is
// checked (softly, so one run names every budget it exceeds).

/** One measurement of a budget. */
export interface Measured {
  readonly budget: Budget
  readonly value: number
  /** What it is made of, or how it varied. */
  readonly detail?: string
}

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 }

/** A value in the budget's unit: kB (1,000 bytes), milliseconds, or a layout shift score. */
export function format(budget: Budget, value: number): string {
  if (budget === 'cls') return value.toFixed(3)
  if (budget === 'lcp' || budget === 'inp') return `${Math.round(value).toLocaleString('en-US')} ms`
  return `${(value / 1000).toLocaleString('en-US', ONE_DECIMAL)} kB`
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

/**
 * Reports the measurements (console, a JSON attachment with `data`, the job summary), then
 * checks each against its budget.
 */
export async function report(
  testInfo: TestInfo,
  title: string,
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
  await testInfo.attach(`${title}.json`, {
    body: JSON.stringify({ measured, budgets: BUDGETS, data }, null, 2),
    contentType: 'application/json',
  })
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
