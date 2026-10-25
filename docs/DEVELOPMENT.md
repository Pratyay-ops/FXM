# Development guide

Everything FXM needs is installed **inside the repository** and can be removed with one command. Nothing is installed globally or written to your home directory.

## Prerequisites

Only these live on your machine:

| Tool | Notes |
|---|---|
| git, make, curl, tar, openssl | Preinstalled on macOS and most Linux distributions |
| Node.js 22 | Version pinned in `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm): `nvm install && nvm use` |
| ffmpeg *(optional)* | Only for the self-hosted server (stage 7.1) |

## Quick start

```sh
git clone https://github.com/Pratyay-ops/FXM.git
cd FXM
nvm install && nvm use   # Node 22 from .nvmrc
make setup               # pinned pnpm + dependencies, all inside the repo
make doctor              # shows every tool and where it lives
```

Run `make` with no arguments to list all commands.

## Where things are installed

| What | Where | Installed by |
|---|---|---|
| pnpm 12.12.1 (standalone binary, hash-verified) | `.tools/bin/pnpm` | `make setup` |
| pnpm store, cache, state | `.tools/pnpm/` | `make setup` |
| JavaScript dependencies | `node_modules/` in each checkout (hard links into the store) | `make setup` / `make install` |
| uv 0.12.24 | `.tools/bin/uv` | `make py-setup` |
| Python 3.13 | `.tools/uv/python/` | `make py-setup` |
| Python virtualenv | `.venv/` in each checkout | `make py-setup` |
| GitHub CLI 2.102.0 and its login | `.tools/bin/gh`, `.tools/gh/` | `make gh-setup` (optional) |
| JDK, Android SDK, Gradle caches | `.tools/jdk/`, `.tools/android-sdk/`, `.tools/gradle/` | `make android-setup` (stage 6.1) |
| Stage worktrees | `../FXM-worktrees/<branch>/` | `make wt-new` |

`scripts/env.sh` redirects into `.tools/` everything a tool would normally write under `$HOME`: npm and pnpm caches, uv, pip, Gradle, Android, gh, Playwright and wrangler logs. It also turns telemetry off. `.tools/` always belongs to the **main checkout**, so every worktree shares one copy.

## Using the tools in your own shell

`make` runs every tool through `scripts/run.sh`, which loads the environment first. You can do the same:

```sh
scripts/run.sh pnpm --filter @fxm/web add some-package   # one command
source scripts/env.sh                                     # or a whole shell session
source .venv/bin/activate   # optional: activate the Python venv (or use `uv run …`)
```

## Commands

| Command | What it does |
|---|---|
| `make setup` | First-time setup: check prerequisites, install pinned pnpm, install deps |
| `make install` | Install or refresh dependencies (also resolves `pnpm-lock.yaml` merge conflicts) |
| `make doctor` | Check prerequisites; fail if anything would install outside `.tools/` |
| `make py-setup` | Install uv and create `.venv` with the Python from `.python-version` |
| `make gh-setup` | Install the GitHub CLI (only for the PR workflow) |
| `make dev` | Start the web app dev server (Vite) |
| `make lint` / `make format` | Check, or fix, formatting and lint rules (Biome) |
| `make typecheck` | Type-check every package (TypeScript 7) |
| `make test` / `make coverage` | Run all tests (Vitest), optionally with a coverage report |
| `make build` | Build every app |
| `make check` | `lint` + `typecheck` + `test` + `build`: what every stage must pass |
| `make wt-new BRANCH=…` / `wt-list` / `wt-remove BRANCH=…` | Stage worktrees, see [WORKFLOW.md](WORKFLOW.md) |
| `make clean` | Remove build output |
| `make nuke` | Remove **all** installed tools, dependencies and caches |

## Monorepo layout and conventions

- **Workspace:** pnpm workspaces over `apps/*` and `packages/*`. Internal packages export their TypeScript source directly (`"exports": "./src/index.ts"`), so there is no build step between packages. Vite, Vitest and wrangler compile them on the fly.
- **TypeScript:** `tsconfig.base.json` is strict (including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). Each package picks its runtime libraries: `core` has none (pure ES), `sources` gets `webworker` (fetch, no DOM), `player` and `web` get the DOM.
- **Style:** Biome formats and lints: 2 spaces, single quotes, no semicolons, 100 columns. Run `make format` before committing. The VS Code settings in `.vscode/` format on save with the Biome extension.
- **Tests:** `*.test.ts(x)` next to the code, run by Vitest across all packages.
- **New dependencies:** `minimumReleaseAge` in `pnpm-workspace.yaml` makes pnpm install only versions that have been public for at least 14 days, transitive dependencies included.

## Removing everything

```sh
make nuke
```

This deletes `.tools/` and the `node_modules/` and `.venv/` folders of the main checkout and of every worktree.

- Tracked files and uncommitted work are never touched. Worktree folders themselves are kept because they hold work; remove each with `make wt-remove`.
- If you logged in to gh **without** `--insecure-storage`, run `gh auth logout` first so the token also leaves your keychain.
- `make setup` brings everything back.

## Upgrading pinned tools

Prefer releases that are at least two weeks old, and update the version and its hashes together:

| Tool | Edit | Where the hashes come from |
|---|---|---|
| pnpm | `scripts/install-pnpm.sh` **and** `"packageManager"` in `package.json` | `dist.integrity` of `https://registry.npmjs.org/@pnpm/exe.<platform>/<version>` |
| uv | `scripts/install-uv.sh` | `uv-<target>.tar.gz.sha256` files on the GitHub release |
| gh | `scripts/install-gh.sh` | `gh_<version>_checksums.txt` on the GitHub release |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node 22 is required` | `nvm install && nvm use` in the repo folder |
| `pnpm: command not found` in your shell | `source scripts/env.sh`, or run it through `make` |
| Merge conflict in `pnpm-lock.yaml` | `make install`, then continue the merge or rebase |
| `make doctor` says the store is outside `.tools/` | You ran pnpm without the environment: `source scripts/env.sh` |
