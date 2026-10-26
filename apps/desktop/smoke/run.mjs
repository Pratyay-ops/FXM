// Runs the smoke-test build of the desktop app and prints its report (see the app's README).
// The package's `smoke` script builds it first: a debug build with the `smoke` feature, its own
// identifier and a hidden window. The app prints a line per step as it goes, then one line with
// the report, and exits.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOG_PREFIX = 'FXM_SMOKE_LOG '
const PREFIX = 'FXM_SMOKE_REPORT '
const TIMEOUT_MS = Number(process.env.FXM_SMOKE_TIMEOUT_MS ?? 15 * 60_000)
const LABELS = { passed: 'PASS', failed: 'FAIL', pending: 'WAIT' }

const executable = process.platform === 'win32' ? 'fxm.exe' : 'fxm'
const binary = fileURLToPath(new URL(`../src-tauri/target/debug/${executable}`, import.meta.url))

const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'] })
let report
let pending = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  const lines = (pending + chunk).split('\n')
  pending = lines.pop() ?? ''
  for (const line of lines) {
    if (line.startsWith(PREFIX)) report = JSON.parse(line.slice(PREFIX.length))
    else if (line.startsWith(LOG_PREFIX))
      console.log(`... ${JSON.parse(line.slice(LOG_PREFIX.length))}`)
    else if (line.trim() !== '') console.log(line)
  }
})

const timer = setTimeout(() => {
  console.error(`No report after ${TIMEOUT_MS / 1000} s: stopping the app`)
  child.kill()
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (report === undefined) {
    console.error(`The app exited (${signal ?? code}) without a report`)
    process.exit(2)
  }
  for (const step of report.steps) {
    const label = LABELS[step.status] ?? step.status
    console.log(`${label}  ${step.name} (${Math.round(step.ms)} ms): ${step.detail}`)
  }
  const waiting = report.steps.filter((step) => step.status === 'pending').length
  console.log(report.ok ? `Passed${waiting ? `, ${waiting} step(s) waiting` : ''}` : 'Failed')
  process.exit(report.ok ? 0 : 1)
})
