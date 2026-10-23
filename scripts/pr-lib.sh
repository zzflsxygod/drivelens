# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# Shared by scripts/pr.sh and scripts/release.sh: land the local HEAD on main through a pull request.
# main is protected (PR required, checks api/app/dco required and up to date, admins included), so nothing is pushed
# to main directly. Merge method: rebase — every commit keeps its message (and its Signed-off-by line) and main stays
# linear. Squash and merge commits are disabled on the repository.

PR_REQUIRED_CHECKS="api app dco"   # job names in .github/workflows/ci.yml (pull_request)

# pr_land <branch> <title> <body-file> [dry-run]
# Idempotent: when origin/main already has the same content as HEAD (e.g. the PR was merged on an earlier run)
# it only syncs the local main and returns. An open PR for <branch> is reused.
pr_land() {
  local branch=$1 title=$2 body=$3 dry=${4:-} sha num st head i
  git fetch -q origin main
  if git diff --quiet HEAD origin/main --; then
    echo "   HEAD already landed on main ($(git rev-parse --short origin/main))"; pr_sync_main; return 0
  fi
  git merge-base --is-ancestor origin/main HEAD || {
    echo "   origin/main has commits that HEAD does not have — run: git pull --rebase origin main"; exit 1; }
  local bad=""
  for c in $(git rev-list --no-merges origin/main..HEAD); do
    git show -s --format=%B "$c" | grep -q '^Signed-off-by: ' || bad="$bad $(git rev-parse --short "$c")"
  done
  [ -z "$bad" ] || { echo "   commits without Signed-off-by:$bad — fix with: git rebase --signoff origin/main"; exit 1; }
  sha=$(git rev-parse HEAD)
  if [ -n "$dry" ]; then
    echo "   [dry-run] would push HEAD ($(git rev-parse --short HEAD)) to branch $branch, open/reuse a PR to main:"
    echo "   [dry-run]   title: $title"
    git log --format='   [dry-run]   %h %s' origin/main..HEAD
    echo "   [dry-run] then wait for checks ($PR_REQUIRED_CHECKS) and merge with --rebase"
    return 0
  fi
  git push -q --force origin "HEAD:refs/heads/$branch"
  num=$(gh pr list --head "$branch" --base main --state open --json number -q '.[0].number // empty')
  if [ -z "$num" ]; then
    gh pr create --base main --head "$branch" --title "$title" --body-file "$body" >/dev/null
    num=$(gh pr list --head "$branch" --base main --state open --json number -q '.[0].number // empty')
  fi
  [ -n "$num" ] || { echo "   could not open a pull request for $branch"; exit 1; }
  echo "   PR #$num: $(gh pr view "$num" --json url -q .url)"
  # poll (gh pr checks --watch can hang when not attached to a terminal)
  for i in $(seq 120); do
    head=$(gh pr view "$num" --json headRefOid -q .headRefOid)
    if [ "$head" = "$sha" ]; then
      st=$(gh pr view "$num" --json statusCheckRollup -q "[.statusCheckRollup[] | select(.__typename==\"CheckRun\")] as \$r
        | [\"${PR_REQUIRED_CHECKS// /\",\"}\"][] as \$n
        | ([\$r[] | select(.name==\$n)] | last) as \$c
        | if \$c == null or \$c.status != \"COMPLETED\" then \"wait\" elif \$c.conclusion == \"SUCCESS\" then \"ok\" else \"fail:\" + \$n end" | sort -u | tr '\n' ' ')
      case "$st" in *fail:*) echo "   checks failed: $st— fix, commit and re-run"; exit 1 ;; "ok ") echo "   checks passed ($PR_REQUIRED_CHECKS)"; break ;; esac
    fi
    [ "$i" = 120 ] && { echo "   checks did not finish in 60 min (PR #$num)"; exit 1; }
    sleep 30
  done
  gh pr merge "$num" --rebase --match-head-commit "$sha" >/dev/null
  for _ in $(seq 30); do
    [ "$(gh pr view "$num" --json state -q .state)" = MERGED ] && break; sleep 5
  done
  [ "$(gh pr view "$num" --json state -q .state)" = MERGED ] || { echo "   PR #$num did not merge"; exit 1; }
  git fetch -q origin main
  git diff --quiet HEAD origin/main -- || { echo "   merged, but origin/main differs from HEAD — check PR #$num"; exit 1; }
  echo "   merged PR #$num → main $(git rev-parse --short origin/main)"
  pr_sync_main
}

# After a rebase merge main has new commit ids with the same content: move the local main to origin/main.
pr_sync_main() {
  local cur; cur=$(git symbolic-ref -q --short HEAD || true)
  if [ "$cur" = main ]; then
    git diff --quiet HEAD origin/main -- && git reset -q --keep origin/main
  elif git merge-base --is-ancestor main origin/main 2>/dev/null || git diff --quiet main origin/main -- 2>/dev/null; then
    [ -n "$(git status --porcelain)" ] || { git switch -q main && git reset -q --keep origin/main; }
    [ -n "$cur" ] && echo "   switched to main (branch $cur can be deleted: git branch -D $cur)"
  else
    echo "   note: local main has commits that are not on origin/main; left it alone"
  fi
  return 0
}
