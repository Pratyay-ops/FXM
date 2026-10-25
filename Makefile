# FXM developer commands. Run `make` (or `make help`) to list them.
#
# Every recipe runs in bash with scripts/env.sh sourced first (via BASH_ENV), so
# tools, caches and package stores all live in .tools/ of the main checkout and
# `make nuke` can remove them. Written for GNU Make 3.81 (the macOS default).

SHELL := /bin/bash
export BASH_ENV := $(CURDIR)/scripts/env.sh

.DEFAULT_GOAL := help
.PHONY: help setup install doctor py-setup gh-setup wt-new wt-list wt-remove clean nuke

help: ## List available commands
	@echo "FXM commands (docs/DEVELOPMENT.md has the details):"
	@awk 'BEGIN {FS = ":.*## "} /^[a-z0-9-]+:.*## / {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --- Setup ---------------------------------------------------------------------

setup: ## First-time setup: check prerequisites, install pinned pnpm and deps
	@scripts/setup.sh

install: ## Install or refresh JavaScript dependencies (also fixes lockfile conflicts)
	pnpm install

doctor: ## Check prerequisites and show where every tool lives
	@scripts/doctor.sh

py-setup: ## Install uv and create .venv with the Python from .python-version
	@scripts/install-uv.sh
	uv venv --allow-existing "$$FXM_ROOT/.venv"

gh-setup: ## Install the GitHub CLI into .tools (optional, for the PR workflow)
	@scripts/install-gh.sh

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
