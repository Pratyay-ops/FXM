/**
 * The desktop check's frontend: the e2e harness, run as soon as the app window opens. It sends
 * its report, or the first error, to the local server of `desktop.mjs`: with fetch, or, if that
 * fails, by navigating there, since a page can't otherwise talk to a script outside the app.
 */
const status = document.getElementById('status')
let sent = false
let stage = 'loading the harness'

function send(report) {
  if (sent) return
  sent = true
  const body = JSON.stringify(report)
  if (status) status.textContent = body
  fetch(__FXM_E2E_REPORT_URL__, { method: 'POST', body }).catch(() => {
    window.location.href = `${__FXM_E2E_REPORT_URL__}?body=${encodeURIComponent(body)}`
  })
}

// WebKit's stack traces leave out the message, so both are sent.
const fail = (error) => send({ error: String(error), stack: String(error?.stack ?? ''), stage })
window.addEventListener('error', (event) => fail(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => fail(event.reason))
setTimeout(() => fail(new Error('No result after 60 s')), 60_000)

try {
  const { fxmRun } = await import('./harness.mjs')
  send(
    await fxmRun(__FXM_E2E_UPDATES_URL__, (next) => {
      stage = next
      if (status) status.textContent = next
    }),
  )
} catch (error) {
  fail(error)
}
