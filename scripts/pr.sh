#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Land everyday (non-release) changes on main through a pull request — main does not accept direct pushes.
# Usage: scripts/pr.sh [branch] [--dry-run]
#   Commit on main or on a feature branch (git commit -s), then run this. It pushes HEAD to <branch>
#   (default: the current branch; required when on main), opens or reuses a PR to main (title = the commit subject
#   when there is one commit, otherwise the branch name; body = the commit list), waits for the api/app/dco checks,
#   merges with --rebase and moves the local main to the merged origin/main.
#   For releases use scripts/release.sh, which does the same as its first step.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/pr-lib.sh
. scripts/pr-lib.sh
BRANCH="" DRY=""
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; -*) echo "unknown option $a"; exit 1 ;; *) BRANCH=$a ;; esac; done
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
CUR=$(git symbolic-ref -q --short HEAD || true)
BRANCH=${BRANCH:-$CUR}
[ -n "$BRANCH" ] && [ "$BRANCH" != main ] || { echo "on main: pass a branch name, e.g. scripts/pr.sh fix/typo"; exit 1; }
git fetch -q origin main
N=$(git rev-list --count origin/main..HEAD)
if [ "$N" = 1 ]; then TITLE=$(git log -1 --format=%s); else TITLE=$BRANCH; fi
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
git log --reverse --format='- %s' origin/main..HEAD >"$BODY"
echo "== land $BRANCH on main via PR"
pr_land "$BRANCH" "$TITLE" "$BODY" "$DRY"
