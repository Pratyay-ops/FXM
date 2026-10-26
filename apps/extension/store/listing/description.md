FXM Connect is the optional companion extension of FXM, a free and open-source music player that runs as a web app at https://fxmusic.pages.dev/app/. It does nothing on its own: it only helps that one web app.

Browsers stop a web page from reading answers from other sites unless those sites allow it. YouTube, Spotify and Last.fm don't allow it for FXM's page, and FXM has no servers that could ask them instead. FXM Connect closes that gap inside your own browser. The web app makes the requests; FXM Connect changes a few of their headers. FXM Connect itself also fetches Spotify's public server time (open.spotify.com/api/server-time, without cookies) when the web app asks: this needs no setting and isn't tied to any account.

**What it changes**

Its rules apply only to requests that FXM's own pages (https://fxmusic.pages.dev) make to the services below. Every rule removes cookies from those requests and their answers, so these rules never make the web app act as your logged-in account. Only the optional Spotify login bridge below does that, and only after you turn it on. Only FXM's page may read the answers.

- YouTube and YouTube Music (search, song details and audio, and the radio the web app's home feed and endless radio are made from): requests to their API get YouTube's own address in the Origin and Referer headers, and the answers get the headers that let FXM's page read them. Audio answers get the same headers, so the web app can read the audio it plays, for example to check that a stream is complete.
- Spotify (search and details, and radio and recommendations for the web app's home feed and endless radio, from the same endpoints as Spotify's own web player): requests to the endpoints that hand out the web player's tokens and server time get Spotify's own address in the Origin and Referer headers. Their answers, and those of Spotify's web-player API, get the headers that let FXM's page read them.
- Last.fm (radio stations, which the web app's home feed uses for recommendations): the answers get the headers that let FXM's page read them.

**Spotify login bridge (optional, off by default)**

If you turn on "Use my Spotify login from this browser" in FXM Connect's options, the web app can ask FXM Connect for a Spotify access token for the account you are signed in to at open.spotify.com in this browser. The web app asks for one only after you also connect your Spotify account in FXM. FXM Connect then makes that one request to open.spotify.com, and your browser attaches your Spotify cookies to it, as it does on Spotify's own site. FXM Connect never reads, stores or forwards your cookies: it hands the web app only the token. It refuses pages in private windows and container tabs, and serves at most about ten requests a minute. In Firefox, turning it on also asks for Firefox's consent to share authentication information, because the token is your login. Firefox words it as sharing with the extension's developer: the token goes only to FXM's web app in your browser, which uses it for its requests to Spotify, and no FXM server receives it.

Spotify's terms don't permit automated access like FXM's, and they let Spotify suspend accounts that break them; no such case has been reported for this kind of use. With the bridge on, Spotify knows that the web app's requests come from your account. That is why the bridge stays off until you switch it on, and you can switch it off at any time. Without it, FXM uses Spotify's anonymous web-player token, which isn't tied to any account.

**Privacy**

- Nothing goes to FXM: no analytics, no telemetry and no FXM servers.
- The only personal data FXM Connect handles is your Spotify token, and only with the login bridge on: it passes the token to the web app in your browser, which uses it only for its requests to Spotify.
- No remote code: everything that runs ships inside the extension, as readable, unminified files built from FXM's public source code.
- Only FXM's pages can use it. Other sites get nothing, and the rules ignore their requests.
- Permissions: declarativeNetRequest for the fixed header rules, storage for the rate limit of its Spotify requests, and access to FXM's site and to the services above.

FXM is an independent open-source project, not affiliated with or endorsed by YouTube, Google, Spotify or Last.fm.

Source code, the full list of permissions and the issue tracker: https://github.com/Pratyay-ops/FXM

Privacy policy: https://fxmusic.pages.dev/privacy#fxm-connect
