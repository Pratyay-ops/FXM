# FXM developer commands. Run `make` (or `make help`) to list them.
#
# Every tool runs through scripts/run.sh, which loads scripts/env.sh first, so
# tools, caches and package stores all live in .tools/ of the main checkout and
# `make nuke` can remove them. Written for GNU Make 3.81 (the macOS default).

SHELL := /bin/bash
RUN := scripts/run.sh

.DEFAULT_GOAL := help
.PHONY: help setup install doctor py-setup gh-setup dev lint format typecheck test coverage build check \
	extension ci-setup ci wt-new wt-list wt-remove clean nuke

help: ## List available commands
	@echo "FXM commands (docs/DEVELOPMENT.md has the details):"
	@awk 'BEGIN {FS = ":.*## "} /^[a-z0-9-]+:.*## / {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

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

extension: ## Build the FXM Connect extension and its zips (FXM_EXTENSION_DEV=1: dev build)
	@$(RUN) pnpm --filter @fxm/extension build

ci-setup: ## CI only: setup with a frozen lockfile
	@scripts/setup.sh --frozen-lockfile

ci: ci-setup check ## What CI runs: frozen setup, then check

# --- Worktrees (one per plan stage, see docs/WORKFLOW.md) ----------------------

wt-new: ## New stage worktree from origin/develop: make wt-new BRANCH=feat/1.4-jiosaavn
	@scripts/worktree.sh new "$(BRANCH)" $(BASE)

wt-list: ## List worktrees and their branches
	@git worktree list

wt-remove: ## Remove a stage worktree: make wt-remove BRANCH=feat/1.4-jiosaavn
	@scripts/worktree.sh remove "$(BRANCH)"

# --- Cleanup -------------------------------------------------------------------

clean: ## Remove build output (keeps dependencies and tools)
	@scripts/clean.sh build

nuke: ## Remove ALL installed tools, deps and caches (main checkout and worktrees)
	@scripts/clean.sh all
