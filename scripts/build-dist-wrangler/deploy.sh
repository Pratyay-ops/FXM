#!/usr/bin/env bash
# Uploads dist/pages (make dist) to the Cloudflare Pages project fxm-music: a direct upload of
# static files, never a Worker and no Functions. The deploy workflow runs it
# (.github/workflows/deploy.yml) with the secrets CLOUDFLARE_API_TOKEN (Account > Cloudflare
# Pages > Edit) and CLOUDFLARE_ACCOUNT_ID; nobody holds the token locally.
#
#   deploy.sh <branch>   main deploys to production (fxm-music.pages.dev); any other branch to
#                        its preview alias, such as develop.fxm-music.pages.dev
#
# It creates the project, with main as its production branch, when it doesn't exist yet. With
# GITHUB_OUTPUT set, it writes the deployment's url and alias there. Install wrangler first:
# scripts/run.sh pnpm install --frozen-lockfile --dir scripts/build-dist-wrangler
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../env.sh"
source "$here/../lib.sh"

PROJECT=fxm-music
PRODUCTION_BRANCH=main

branch=${1:-}
[ -n "$branch" ] || fxm_die "usage: deploy.sh <branch>"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fxm_die "CLOUDFLARE_API_TOKEN is not set (a GitHub secret)"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fxm_die "CLOUDFLARE_ACCOUNT_ID is not set (a GitHub secret)"
pages="$FXM_ROOT/dist/pages"
[ -f "$pages/_headers" ] || fxm_die "$pages has no _headers: run make dist first"
wrangler="$here/node_modules/wrangler/bin/wrangler.js"
[ -f "$wrangler" ] ||
  fxm_die "wrangler is not installed: scripts/run.sh pnpm install --frozen-lockfile --dir scripts/build-dist-wrangler"

# This folder has no functions/ folder and no wrangler config, so wrangler uploads dist/pages
# as plain static files whatever else the repository holds.
cd "$here"

projects=$(node "$wrangler" pages project list --json)
status=0
node -e '
  // The JSON array, even if wrangler printed a notice around it.
  const text = require("fs").readFileSync(0, "utf8")
  let list
  try {
    list = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1))
  } catch {
    process.exit(2)
  }
  if (!Array.isArray(list)) process.exit(2)
  process.exit(list.some((project) => project["Project Name"] === process.argv[1]) ? 0 : 1)
' "$PROJECT" <<<"$projects" || status=$?
case $status in
  0) fxm_info "Cloudflare Pages project $PROJECT exists" ;;
  1)
    fxm_info "Creating the Cloudflare Pages project $PROJECT (production branch $PRODUCTION_BRANCH)"
    node "$wrangler" pages project create "$PROJECT" --production-branch "$PRODUCTION_BRANCH"
    ;;
  *) fxm_die "couldn't read wrangler's project list: $projects" ;;
esac

output=$(mktemp)
trap 'rm -f "$output"' EXIT
WRANGLER_OUTPUT_FILE_PATH=$output node "$wrangler" pages deploy "$pages" \
  --project-name "$PROJECT" --branch "$branch" --commit-hash "$(git rev-parse HEAD)"

# wrangler's machine-readable record of the deployment (one JSON object per line).
deployment=$(node -e '
  const entries = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const entry = entries.reverse().find((candidate) => candidate.type === "pages-deploy-detailed")
  if (!entry || !entry.url) process.exit(1)
  console.log(`${entry.url} ${entry.alias || ""} ${entry.environment || ""}`)
' "$output") || fxm_die "wrangler reported no deployment URL"
read -r url alias environment <<<"$deployment"
fxm_info "Deployed to $url (${environment:-unknown} environment${alias:+, alias $alias})"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "url=$url"
    echo "alias=${alias:-}"
    echo "environment=${environment:-}"
  } >>"$GITHUB_OUTPUT"
fi
