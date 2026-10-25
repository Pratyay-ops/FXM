# Security policy

## Supported versions

FXM is in early development. Until version 1.0, only the latest release gets security fixes.

| Version | Security fixes |
|---|---|
| The [latest release](https://github.com/Pratyay-ops/FXM/releases/latest) | Yes |
| Older releases | No. Please update to the latest release |
| `develop`, not released yet | Yes. Fixes land there first and ship in the next release |

## Reporting a vulnerability

Please report security problems privately, never in a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting: [open a report](https://github.com/Pratyay-ops/FXM/security/advisories/new), or use **Report a vulnerability** on the repository's security tab. You need a GitHub account. The report stays private between you and the maintainers until an advisory is published.

Include what you can:

- the part of FXM affected (see [Scope](#scope)) and its version or commit;
- what an attacker could do, and under which conditions;
- steps to reproduce it, or a proof of concept;
- whether, when and where you plan to publish your findings.

FXM is a volunteer project, so there is no guaranteed response time. Once a report is confirmed, the fix is prepared in private and released, and then the advisory is published, crediting you if you want. Please give the project reasonable time to release a fix before you publish details, and agree on a date with the maintainers.

## Scope

In scope:

- **The apps:** the web app and the website at `https://fxm-music.pages.dev` (they share one origin), the desktop app and the Android app.
- **FXM Connect,** the browser extension.
- **Release artifacts:** every file attached to a GitHub Release, and the workflows in this repository that build and publish them.
- The source code in this repository.

Out of scope:

- **The third-party services themselves,** such as YouTube, Google, Spotify, Last.fm, ListenBrainz, MusicBrainz, LRCLIB, Internet Archive and Jamendo. Report problems in them to those services.
- **GitHub and Cloudflare themselves,** which host FXM's code, releases and website. How FXM configures them is in scope.
- **Vulnerabilities in the libraries FXM uses.** Report them to those projects. If one makes FXM itself exploitable, report that here too.
- **Limitations the READMEs already document,** such as the FXM Connect development build trusting every page on its localhost ports.
- **Bugs that aren't security problems.** Report them on the [issue tracker](https://github.com/Pratyay-ops/FXM/issues).

Test only against your own installation and accounts. Don't run load tests or automated scanners against `fxm-music.pages.dev` or the services FXM connects to.
