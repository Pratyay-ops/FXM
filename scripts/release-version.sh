#!/usr/bin/env bash
# Sets or checks the FXM product version: SemVer x.y.z, kept in "version" of the root package.json.
#
#   release-version.sh 0.2.0            sets it in the root package.json, in every workspace
#                                       package.json (FXM Connect builds its manifest version from
#                                       apps/extension/package.json) and in APP_VERSION of
#                                       packages/core/src/index.ts (shown in Settings → About)
#   release-version.sh --dry-run 0.2.0  prints what would change and changes nothing
#   release-version.sh --check          fails unless all of them equal the root package.json
#
# make release-pr sets the version; the release workflow runs --check before it tags a release.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/env.sh"
source "$here/lib.sh"
source "$here/release-lib.sh"

usage="usage: release-version.sh [--dry-run] <x.y.z> | release-version.sh --check"
mode=apply
case "${1:-}" in
  --dry-run) mode=dry-run && shift ;;
  --check) mode=check && shift ;;
  -* | '') fxm_die "$usage" ;;
esac
if [ "$mode" = check ]; then
  [ $# -eq 0 ] || fxm_die "$usage"
  version=
else
  [ $# -eq 1 ] || fxm_die "$usage"
  version=$1
  fxm_release_require_version "$version"
fi

# The version lives in JSON and TypeScript, so Node (a prerequisite) edits it. Each edit
# replaces only the version text and is checked by parsing the result.
read -r -d '' program <<'JS' || true
const fs = require('node:fs')
const path = require('node:path')
const [mode, version, root] = process.argv.slice(1)

const fail = (message) => {
  console.error(`release-version.sh: ${message}`)
  process.exit(1)
}
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const hasPackage = (dir) => fs.existsSync(path.join(root, dir, 'package.json'))

// Workspace folders from pnpm-workspace.yaml. Only "dir" and "dir/*" entries are understood;
// anything else fails rather than skipping a package.
function workspaceDirs() {
  const patterns = []
  let inPackages = false
  for (const line of read('pnpm-workspace.yaml').split('\n')) {
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const entry = line.match(/^\s+-\s*(['"]?)([^'"#\s]+)\1\s*(#.*)?$/)
    if (entry) patterns.push(entry[2])
    else if (!/^\s*(#.*)?$/.test(line)) break
  }
  const dirs = []
  for (const pattern of patterns) {
    if (/^[\w.-]+(\/[\w.-]+)*\/\*$/.test(pattern)) {
      const parent = pattern.slice(0, -2)
      if (!fs.existsSync(path.join(root, parent))) continue
      for (const name of fs.readdirSync(path.join(root, parent)).sort()) {
        if (hasPackage(`${parent}/${name}`)) dirs.push(`${parent}/${name}`)
      }
    } else if (/^[\w.-]+(\/[\w.-]+)*$/.test(pattern)) {
      if (hasPackage(pattern)) dirs.push(pattern)
    } else {
      fail(`pnpm-workspace.yaml: only "dir" and "dir/*" package entries are supported, not "${pattern}"`)
    }
  }
  return dirs
}

const APP_VERSION = /^export const APP_VERSION = '([^'\\]*)'$/m

const targets = [
  'package.json',
  ...workspaceDirs().map((dir) => `${dir}/package.json`),
  'packages/core/src/index.ts',
].map((file) => {
  const text = read(file)
  if (file.endsWith('.json')) {
    const value = JSON.parse(text).version
    return { file, text, current: typeof value === 'string' ? value : undefined }
  }
  const matches = text.match(new RegExp(APP_VERSION.source, 'gm')) ?? []
  if (matches.length !== 1) fail(`${file}: expected one "export const APP_VERSION = '…'" line`)
  return { file, text, current: text.match(APP_VERSION)[1] }
})

function withVersion({ file, text, current }) {
  if (!file.endsWith('.json')) return text.replace(APP_VERSION, `export const APP_VERSION = '${version}'`)
  const updated =
    current === undefined
      ? text.replace(/^( {2}"name": "[^"\\]*",)$/m, `$1\n  "version": "${version}",`)
      : text.replace(/^( {2}"version": )"[^"\\]*"/m, `$1"${version}"`)
  const before = JSON.parse(text)
  const after = JSON.parse(updated)
  delete before.version
  if (after.version !== version) fail(`${file}: could not set "version" (expected 2-space JSON)`)
  delete after.version
  if (JSON.stringify(before) !== JSON.stringify(after)) fail(`${file}: changing the version changed more`)
  return updated
}

const width = Math.max(...targets.map((target) => target.file.length)) + 2
const show = (target, detail, log = console.log) => log(`  ${target.file.padEnd(width)}${detail}`)

if (mode === 'check') {
  const expected = targets[0].current
  const wrong = targets.filter((target) => target.current !== expected)
  if (wrong.length === 0) {
    console.log(`All ${targets.length} versions are ${expected}`)
  } else {
    console.error(`These versions differ from package.json (${expected}):`)
    for (const target of wrong) show(target, target.current ?? '(none)', console.error)
    console.error('Set them all with scripts/release-version.sh <x.y.z>.')
    process.exit(1)
  }
} else {
  // Every edit is prepared (and so checked) before any file is written, in a dry run too.
  const edits = targets.map((target) => ({
    target,
    text: target.current === version ? undefined : withVersion(target),
  }))
  for (const { target } of edits) {
    const from = target.current ?? '(none)'
    show(target, target.current === version ? `${version} (unchanged)` : `${from} → ${version}`)
  }
  if (mode === 'apply') {
    for (const { target, text } of edits) {
      if (text !== undefined) fs.writeFileSync(path.join(root, target.file), text)
    }
  }
}
JS

node -e "$program" "$mode" "$version" "$FXM_ROOT"
if [ "$mode" = apply ]; then
  fxm_info "Version $version set"
fi
