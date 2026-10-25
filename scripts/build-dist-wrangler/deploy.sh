#!/usr/bin/env bash
# Uploads dist/pages (make dist) to the Cloudflare Pages project fxmusic: a direct upload of
# static files, never a Worker and no Functions. The deploy workflow runs it
# (.github/workflows/deploy.yml) with the secrets CLOUDFLARE_API_TOKEN (Account > Cloudflare
# Pages > Edit) and CLOUDFLARE_ACCOUNT_ID; nobody holds the token locally.
#
#   deploy.sh develop             the preview: develop.fxmusic.pages.dev
#   deploy.sh main --candidate    a release candidate: main-candidate.fxmusic.pages.dev, which
#                                 the workflow checks before it deploys production
#   deploy.sh main                production: fxmusic.pages.dev
#
# Only develop and main deploy, and in GitHub Actions only from a run of that branch
# (GITHUB_REF). The project is created, with main as its production branch, when it doesn't
# exist yet. FXM_PAGES_PROJECT names another project, to try the pipeline without touching
# fxmusic. With GITHUB_OUTPUT set, it writes the deployment's url, alias and environment
# there. Install wrangler first:
#   scripts/run.sh pnpm install --frozen-lockfile --dir scripts/build-dist-wrangler
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../env.sh"
source "$here/../lib.sh"

PROJECT=${FXM_PAGES_PROJECT:-fxmusic}
PRODUCTION_BRANCH=main
CANDIDATE_BRANCH=main-candidate

usage="usage: deploy.sh develop | main [--candidate]"
branch=${1:-}
mode=${2:-}
case "$branch $mode" in
  "develop " | "main ") pages_branch=$branch ;;
  "main --candidate") pages_branch=$CANDIDATE_BRANCH ;;
  *) fxm_die "$usage (got: ${*:-nothing})" ;;
esac
[ $# -le 2 ] || fxm_die "$usage"
if [ -n "${GITHUB_REF:-}" ] && [ "$GITHUB_REF" != "refs/heads/$branch" ]; then
  fxm_die "a run of $GITHUB_REF may not deploy $branch"
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fxm_die "CLOUDFLARE_API_TOKEN is not set (a GitHub secret)"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fxm_die "CLOUDFLARE_ACCOUNT_ID is not set (a GitHub secret)"
pages="$FXM_ROOT/dist/pages"
[ -f "$pages/_headers" ] || fxm_die "$pages has no _headers: run make dist first"
wrangler="$here/node_modules/wrangler/bin/wrangler.js"
[ -f "$wrangler" ] ||
  fxm_die "wrangler is not installed: scripts/run.sh pnpm install --frozen-lockfile --dir scripts/build-dist-wrangler"
commit=${GITHUB_SHA:-$(git -C "$FXM_ROOT" rev-parse HEAD)}

# This folder has no functions/ folder and no wrangler config, so wrangler uploads dist/pages
# as plain static files whatever else the repository holds.
cd "$here"

projects=$(node "$wrangler" pages project list --json) ||
  fxm_die "couldn't list the Pages projects: $projects"
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
    if ! node "$wrangler" pages project create "$PROJECT" --production-branch "$PRODUCTION_BRANCH"; then
      # Measured 2026-10-26: FXM's first project name failed this way while other names
      # worked on the same account and token (ARCHITECTURE.md D24).
      fxm_die "Cloudflare refused to create the Pages project $PROJECT. Code 8000000 while the account can create other projects means the name is taken: by a project or Worker in this or another account, or reserved after a deletion. Pick another name, or ask Cloudflare support to release it."
    fi
    ;;
  *) fxm_die "couldn't read wrangler's project list: $projects" ;;
esac

# Pages decides production by the project's production branch, so a project created elsewhere
# (in the dashboard, say) must deploy main to production and nothing else, before anything is
# uploaded: a wrong setting would publish develop as production.
details=$(curl -sS --fail-with-body -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT") ||
  fxm_die "couldn't read the Pages project $PROJECT: $details"
actual=$(node -e '
  let body
  try {
    body = JSON.parse(require("fs").readFileSync(0, "utf8"))
  } catch {
    process.exit(1)
  }
  console.log((body && body.result && body.result.production_branch) || "")
' <<<"$details") || fxm_die "the Pages project $PROJECT came back unreadable: $details"
[ "$actual" = "$PRODUCTION_BRANCH" ] ||
  fxm_die "the Pages project $PROJECT deploys ${actual:-no branch} to production, not $PRODUCTION_BRANCH: change its production branch in the Cloudflare dashboard first"

output=$(mktemp)
trap 'rm -f "$output"' EXIT
WRANGLER_OUTPUT_FILE_PATH=$output node "$wrangler" pages deploy "$pages" \
  --project-name "$PROJECT" --branch "$pages_branch" --commit-hash "$commit"

# wrangler's machine-readable record of the deployment (one JSON object per line): the URL,
# the environment and the alias, one per line, since the alias is missing when Cloudflare
# reports none (a production deployment usually has none).
deployment=$(node -e '
  const entries = require("fs").readFileSync(process.argv[1], "utf8").split("\n")
    .filter((line) => line.trim()).map((line) => JSON.parse(line))
  const entry = entries.reverse().find((candidate) => candidate.type === "pages-deploy-detailed")
  if (!entry || typeof entry.url !== "string" || !entry.url) process.exit(1)
  const field = (value) => (typeof value === "string" ? value.replace(/\s/g, "") : "")
  console.log([field(entry.url), field(entry.environment), field(entry.alias)].join("\n"))
' "$output") || fxm_die "wrangler reported no deployment URL"
url='' environment='' alias=''
{
  read -r url || true
  read -r environment || true
  read -r alias || true
} <<<"$deployment"
fxm_info "Deployed $branch to $url (${environment:-unknown} environment${alias:+, alias $alias})"
expected=preview
if [ "$pages_branch" = "$PRODUCTION_BRANCH" ]; then expected=production; fi
[ "$environment" = "$expected" ] ||
  fxm_die "the deployment of $pages_branch went to the ${environment:-unknown} environment, not $expected"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "url=$url"
    echo "alias=$alias"
    echo "environment=$environment"
  } >>"$GITHUB_OUTPUT"
fi
