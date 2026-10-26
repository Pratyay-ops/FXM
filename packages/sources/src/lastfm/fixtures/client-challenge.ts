/**
 * The page Last.fm answered a station request with on 2026-10-26, instead of the station's
 * JSON: HTTP 200, `text/html`, titled "Client Challenge". Trimmed: its scripts and stylesheets
 * are left out.
 */
export const CLIENT_CHALLENGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Client Challenge</title>
  </head>
  <body>
    <noscript>
      <div class="noscript-container">
        <div class="noscript-content">
          <span class="noscript-span">JavaScript is disabled in your browser.</span>
          <p>Please enable JavaScript to proceed.</p>
        </div>
      </div>
    </noscript>
    <div id="loading-error" role="alert" aria-live="polite">
      A required part of this site couldn’t load. This may be due to a browser extension, network
      issues, or browser settings. Please check your connection, disable any ad blockers, or try
      using a different browser.
    </div>
  </body>
</html>
`
