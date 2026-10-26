# FXM developer commands. Run `make` (or `make help`) to list them.
#
# Every tool runs through scripts/run.sh, which loads scripts/env.sh first, so
# tools, caches and package stores all live in .tools/ of the main checkout and
# `make nuke` can remove them. Written for GNU Make 3.81 (the macOS default).

SHELL := /bin/bash
RUN := scripts/run.sh

.DEFAULT_GOAL := help
.PHONY: help setup install doctor py-setup gh-setup dev lint format typecheck test coverage build check \
	extension dist ci-setup ci wt-new wt-list wt-remove clean nuke

help: ## List available commands
	@echo "FXM commands (docs/DEVELOPMENT.md has the details):"
	@awk 'BEGIN {FS = ":.*## "} /^[a-z0-9-]+:.*## / {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Setup ---------------------------------------------------------------------

setup: ## First-time setup: check prerequisites, install pinned pnpm and deps
	@scripts/setup.sh

install: ## Install or refresh JavaScript dependencies (also fixes lockfile conflicts)
	@$(RUN) pnpm install

doctor: ## Check prerequisites and show where every tool lives
	@scripts/doctor.sh

py-setup: ## Install uv and create .venv with the Python from .python-version
	@scripts/py-setup.sh

gh-setup: ## Install the GitHub CLI into .tools (optional, for the PR workflow)
	@scripts/install-gh.sh

# --- Develop -------------------------------------------------------------------

dev: ## Start the web app dev server
	@$(RUN) pnpm --filter @fxm/web dev

lint: ## Check formatting and lint rules (Biome)
	@$(RUN) pnpm run lint
	@# CHANGELOG.md is generated from commit history, which keeps the old name.
	@if git grep -niI -e 'fxm-music\.pages\.de[v]' -e 'fxm_music_pages_de[v]' -- . ':!docs/research/' ':!CHANGELOG.md' \
	  || git grep -nwI 'fxm-musi[c]' -- . ':!docs/research/' ':!docs/ARCHITECTURE.md' ':!Makefile' ':!CHANGELOG.md'; then \
	  echo "FXM moved to fxmusic.pages.dev and the Pages project fxmusic (fxm-music was taken, see ARCHITECTURE.md D24): update the lines above."; \
	  exit 1; \
	fi

format: ## Fix formatting and safe lint issues (Biome)
	@$(RUN) pnpm run format

typecheck: ## Type-check every package (TypeScript)
	@$(RUN) pnpm run typecheck

test: ## Run all tests once (Vitest)
	@$(RUN) pnpm run test

coverage: ## Run all tests with a coverage report
	@$(RUN) pnpm run coverage

build: ## Build every app
	@$(RUN) pnpm run build

check: lint typecheck test build ## Everything a stage must pass before merging

# Run from a residential connection: datacenter IPs get YouTube's bot checks, so CI's live runs
# are only advisory. docs/DEVELOPMENT.md has a daily schedule for the owner's Mac.
.PHONY: live-smoke
live-smoke: ## Live smoke tests against the real services (FXM_LIVE=1, a few requests each)
	@FXM_LIVE=1 $(RUN) pnpm exec vitest run live.test --no-file-parallelism

extension: ## Build the FXM Connect extension and its zips (FXM_EXTENSION_DEV=1: dev build)
	@$(RUN) pnpm --filter @fxm/extension build

dist: ## Compose what Cloudflare Pages serves (site, app, headers, notices) into dist/pages
	@$(RUN) pnpm --silent --filter @fxm/deploy dist

# The app as it ships: make dist served like Cloudflare Pages, in Playwright's Chromium (installed
# into .tools/playwright on first use), headless, muted and offline but for this machine
# (apps/web/e2e/README.md). CI runs both in the E2E workflow; make check doesn't.
.PHONY: e2e budgets
e2e: dist ## End-to-end tests of the critical flows against make dist (Chromium, offline)
	@$(RUN) pnpm --filter @fxm/web e2e:flows

budgets: dist ## Performance budgets of make dist's app: chunk sizes, transfer, LCP, CLS, INP
	@$(RUN) pnpm --filter @fxm/web budgets

ci-setup: ## CI only: setup with a frozen lockfile
	@scripts/setup.sh --frozen-lockfile

ci: ci-setup check ## What CI runs: frozen setup, then check

# Not part of check: it asks the npm registry about every package in both pnpm roots' lockfiles.
# The Audit workflow runs it every week and whenever a lockfile changes.
.PHONY: audit
audit: ## Check both pnpm roots' lockfiles for high and critical advisories (needs the network)
	@status=0; \
	echo "Repository root:"; \
	$(RUN) pnpm audit --audit-level high || status=1; \
	echo "The deploy's wrangler (scripts/build-dist-wrangler):"; \
	$(RUN) pnpm audit --audit-level high --dir scripts/build-dist-wrangler || status=1; \
	exit $$status

# --- ffmpeg core (stage 4.2; tools/ffmpeg-wasm/README.md) -------------------------
# FXM's LGPL, audio-only FFmpeg for WebAssembly, which the web app converts downloads with.
# Built into .tools/ (emsdk too), so `make nuke` removes it; `make check` never needs it.

.PHONY: ffmpeg-wasm ffmpeg-wasm-check ffmpeg-wasm-test

CORE_BUILD = node --experimental-strip-types --disable-warning=ExperimentalWarning tools/ffmpeg-wasm/core-build.ts

ffmpeg-wasm: ## Build the LGPL ffmpeg core into .tools (minutes; FXM_FFMPEG_JOBS=2 by default)
	@tools/ffmpeg-wasm/recipe/build.sh

ffmpeg-wasm-check: ## Check the built ffmpeg core: under 25 MiB, LGPL, from the current recipe
	@$(RUN) $(CORE_BUILD) check

ffmpeg-wasm-test: ## Test the built ffmpeg core end to end, in every format, on generated audio
	@FXM_FFMPEG_CORE_DIR="$$($(RUN) $(CORE_BUILD) dir)" $(RUN) pnpm exec vitest run packages/convert/src/core.wasm.test.ts

# --- Android app (docs/DEVELOPMENT.md, "Android app") ---------------------------

.PHONY: android-setup apk android-test android-clean

android-setup: ## Install the JDK and Android SDK into .tools (accepts the SDK licenses)
	@scripts/android-setup.sh

apk: ## Build the Android debug APK (run make android-setup once first)
	@apps/mobile/scripts/build-apk.sh

android-test: ## Run the Android app's native unit tests (offline, no device needed)
	@apps/mobile/scripts/test-native.sh

android-clean: ## Remove this checkout's Android build output
	@scripts/clean.sh android

# --- Worktrees (one per plan stage, see docs/WORKFLOW.md) ----------------------

wt-new: ## New stage worktree from origin/develop: make wt-new BRANCH=feat/1.4-jiosaavn
	@scripts/worktree.sh new "$(BRANCH)" $(BASE)

wt-list: ## List worktrees and their branches
	@git worktree list

wt-remove: ## Remove a stage worktree: make wt-remove BRANCH=feat/1.4-jiosaavn
	@scripts/worktree.sh remove "$(BRANCH)"

# --- Releases (docs/WORKFLOW.md, "Releases") -----------------------------------

.PHONY: release-pr release-notes release-build release-check

release-pr: ## Open the release PR develop → main: make release-pr VERSION=x.y.z (DRY_RUN=1: plan only)
	@DRY_RUN="$(DRY_RUN)" scripts/release-pr.sh "$(VERSION)"

release-notes: ## Print the next release's notes (VERSION=x.y.z: that version's)
	@scripts/release-notes.sh $(VERSION)

release-build: ## Build what a release ships into dist/release, with SHA256SUMS
	@scripts/release-build.sh dist/release
	@scripts/release-build.sh --checksums dist/release

# actionlint's optional shellcheck and pyflakes checks stay off: they would use whatever copy is
# on the PATH (GitHub's runners have shellcheck, a Mac usually doesn't), so CI and a local run
# could disagree. CI runs this target after make check.
release-check: ## Lint the GitHub workflows (actionlint) and test the release scripts offline
	@scripts/install-actionlint.sh
	@$(RUN) actionlint -shellcheck= -pyflakes=
	@scripts/release-test.sh

# --- Cleanup -------------------------------------------------------------------

clean: ## Remove build output (keeps dependencies and tools)
	@scripts/clean.sh build

nuke: ## Remove ALL installed tools, deps and caches (main checkout and worktrees)
	@scripts/clean.sh all

# --- Desktop app (Tauri 2; "Desktop app" in docs/DEVELOPMENT.md) --------------
# Rust lives in .tools/ (make rust-setup); `make check` never needs it.

.PHONY: rust-setup desktop-setup desktop-dev desktop-build desktop-dmg desktop-check

# Locally, macOS builds only FXM.app: the DMG step can drive Finder windows (desktop-dmg).
DESKTOP_BUNDLES = $(if $(filter Darwin,$(shell uname -s)),--bundles app,)
DESKTOP_CARGO = cd apps/desktop/src-tauri && "$(CURDIR)/$(RUN)" cargo

rust-setup: ## Install the pinned Rust toolchain into .tools (desktop app)
	@scripts/install-rust.sh

desktop-setup: rust-setup install ## Set up the desktop app: Rust toolchain plus dependencies

desktop-dev: ## Run the desktop app on the web dev server (port 5260, hot reload)
	@scripts/install-rust.sh --check
	@$(RUN) pnpm --filter @fxm/desktop tauri dev

desktop-build: ## Build the desktop app (FXM.app on macOS; all bundles elsewhere)
	@scripts/install-rust.sh --check
	@$(RUN) pnpm --filter @fxm/desktop tauri build $(DESKTOP_BUNDLES) -- --locked

# Naming `app` too keeps FXM.app: with only `dmg`, Tauri deletes it after packing the image.
desktop-dmg: ## macOS: build FXM.app and the .dmg, without Finder windows
	@scripts/install-rust.sh --check
	@CI=true $(RUN) pnpm --filter @fxm/desktop tauri build --bundles app,dmg -- --locked

desktop-check: ## Check the desktop Rust code: rustfmt, clippy, cargo test
	@scripts/install-rust.sh --check
	@$(DESKTOP_CARGO) fmt --check
	@$(DESKTOP_CARGO) clippy --locked --all-targets -- -D warnings
	@$(DESKTOP_CARGO) test --locked
