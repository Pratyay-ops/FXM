## Stage

<!-- e.g. 1.4 JioSaavn provider (docs/PLAN.md). Base branch: develop. -->

## What changed and why

## Shared-code changes

<!-- Anything outside the stage's Scope (e.g. a new field in packages/core). Write "none" if none. -->

## Definition of done

- [ ] Changes stay inside the stage's Scope; shared-code changes are minimal, additive and listed above
- [ ] `make check` passes (lint, typecheck, tests, build)
- [ ] New logic has offline tests (fixtures); live tests only behind `FXM_LIVE=1`
- [ ] Catalog mode (Music / Music + Video) is respected where relevant
- [ ] Docs updated; no secrets committed
- [ ] Public text (site, app strings, extension, bundle or store descriptions) follows the trademark rules in `docs/LEGAL.md`: no YouTube or Spotify logos, brand colours or lookalike names
- [ ] Conventional Commit messages, no co-author trailers
