#!/usr/bin/env bash
# DriveLens release: server first, then the app.
#   1. push main  → wait for the "Docker image" CI run of this commit to succeed (:latest pushed)
#   2. poll https://<domain>/health until "version" == api/Cargo.toml version (skipped when api/ is unchanged since the last tag)
#      (Watchtower on the server pulls :latest within ~5 min)
#   3. tag vX.Y.Z → wait for the Web (PWA) build; with NATIVE_BUILDS=1 also the Windows build (creates a DRAFT release)
#      and the Android build (attaches APK + AAB). With NATIVE_BUILDS=0 (scripts/release.conf) the draft is created here.
#      The web app is only offered at the official URL (the web workflow deploys it to Cloudflare Pages); no web zip is attached.
#   4. publish the draft as a prerelease (only now can users download the new app)
#   5. mirror it to the public repo zzflsxygod/drivelens-releases (files + release + assets, scripts/sync-public.sh):
#      by the "Public repo sync" workflow when the RELEASES_REPO_TOKEN secret exists, otherwise from this machine
# Usage: scripts/release.sh [api-base-url] [--skip-health]
#   api-base-url defaults to $DRIVELENS_URL, else the first line of scripts/.release.local (gitignored, per machine)
# Steps are idempotent: re-running after a failure continues where it stopped.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
LOCAL_URL=$( [ -f scripts/.release.local ] && head -1 scripts/.release.local | tr -d '[:space:]' || true)
BASE="${1:-${DRIVELENS_URL:-$LOCAL_URL}}"; BASE="${BASE%/}"
[ -n "$BASE" ] || { echo "no server URL: pass it as the first argument, set DRIVELENS_URL, or put it in scripts/.release.local"; exit 1; }
SKIP_HEALTH="${2:-}"
NATIVE_BUILDS=$( [ -f scripts/release.conf ] && sed -n 's/^NATIVE_BUILDS=\([01]\).*/\1/p' scripts/release.conf | tail -1 || true)
NATIVE_BUILDS="${DRIVELENS_NATIVE_BUILDS:-${NATIVE_BUILDS:-1}}"
VER=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' app/package.json | head -1)
API_VER=$(grep -m1 '^version' api/Cargo.toml | cut -d'"' -f2)
TAG="v$VER"
for f in app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml; do
  grep -q "\"$VER\"\|= \"$VER\"" "$f" || { echo "version mismatch: $f is not $VER"; exit 1; }
done
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

echo "== 1. push main and wait for Docker CI ($TAG)"
git push -q origin HEAD:main
SHA=$(git rev-parse HEAD)
wait_run() { # workflow file, ref (branch or tag), [paths that trigger it]
  local id="" tries=60
  # main pushes are path-filtered: if this commit changed nothing relevant, no run is created →
  # accept the latest successful run whose commit has the same content for those paths.
  if [ -n "${3:-}" ]; then tries=6; fi
  for _ in $(seq $tries); do
    id=$(gh run list --workflow "$1" --json databaseId,headSha,headBranch \
         -q "[.[] | select(.headSha==\"$SHA\" and .headBranch==\"$2\")][0].databaseId // empty")
    [ -n "$id" ] && break; sleep 10
  done
  if [ -z "$id" ] && [ -n "${3:-}" ]; then
    local row rsha
    row=$(gh run list --workflow "$1" --branch "$2" --status success -L 1 --json databaseId,headSha -q '.[0] | "\(.databaseId) \(.headSha)"')
    id=${row%% *}; rsha=${row##* }
    # shellcheck disable=SC2086
    if [ -n "$id" ] && git diff --quiet "$rsha" "$SHA" -- $3; then echo "   $1 ($2): no new run needed (same content as run $id)"; return 0; fi
    echo "   no '$1' run for $SHA on $2 and content differs from the last successful run"; exit 1
  fi
  [ -n "$id" ] || { echo "no '$1' run for $SHA on $2"; exit 1; }
  # poll (gh run watch can hang when not attached to a terminal)
  local st=""
  for _ in $(seq 120); do
    st=$(gh run view "$id" --json status,conclusion -q '.status + " " + .conclusion')
    case "$st" in "completed success") echo "   $1 ($2) ok: run $id"; return 0 ;; completed*) echo "   $1 ($2) failed: $st (run $id)"; exit 1 ;; esac
    sleep 30
  done
  echo "   $1 ($2) timed out (run $id)"; exit 1
}
wait_run docker.yml main "api .github/workflows/docker.yml"

# app-only release: api/ unchanged since the previous release tag → the server keeps its version; don't wait for it
PREV=$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)
[ "$PREV" = "$TAG" ] && PREV=$(git describe --tags --abbrev=0 --match 'v*' "$TAG^" 2>/dev/null || true)
if [ "$SKIP_HEALTH" != "--skip-health" ] && [ -n "$PREV" ] && git diff --quiet "$PREV" HEAD -- api; then
  echo "== 2. api/ unchanged since $PREV (server stays $API_VER) — skipping health wait"; SKIP_HEALTH=--skip-health
fi
if [ "$SKIP_HEALTH" != "--skip-health" ]; then
  [ "$API_VER" = "$VER" ] || echo "   note: api/Cargo.toml is $API_VER, app is $VER — waiting for $API_VER"
  echo "== 2. wait until $BASE/health reports $API_VER (Watchtower polls every 5 min; timeout 30 min)"
  for i in $(seq 120); do
    got=$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
    [ "$got" = "$API_VER" ] && { echo "   server is $got"; break; }
    [ "$i" = 120 ] && { echo "   server still reports '${got:-unreachable}' — not publishing. Re-run later."; exit 2; }
    sleep 15
  done
fi

if [ "$NATIVE_BUILDS" = 1 ]; then echo "== 3. tag $TAG and wait for the Web, Windows (draft release) + Android builds"
else echo "== 3. tag $TAG and wait for the Web build (Windows/Android paused: NATIVE_BUILDS=0 in scripts/release.conf)"; fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag "$TAG"
git push -q origin "$TAG" 2>/dev/null || true
wait_run web.yml "$TAG"
if [ "$NATIVE_BUILDS" = 1 ]; then
  wait_run windows.yml "$TAG"
  wait_run android.yml "$TAG"
  for a in _android_universal.apk _android.aab; do
    gh release view "$TAG" --json assets -q '.assets[].name' | grep -q -- "$a\$" || { echo "   Android asset *$a missing on the draft — not publishing"; exit 1; }
  done
else
  gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --prerelease --verify-tag --title "DriveLens $TAG" \
    --notes "网页版 / Web app (PWA)：在浏览器打开即可使用，可“安装到主屏幕”。需要 drivelens-api v$API_VER 以上（https + CORS，见 https://github.com/zzflsxygod/drivelens-releases/blob/main/docs/install.md ）。
本版本没有新的 Windows / Android 安装包（打包暂停中），请继续使用之前版本的安装包。"
fi

echo "== 4. publish $TAG as prerelease"
gh release edit "$TAG" --draft=false --prerelease
gh release view "$TAG" --json url,isDraft,isPrerelease,assets -q '.url, "draft=\(.isDraft) prerelease=\(.isPrerelease)", (.assets[].name)'

echo "== 5. public repo (zzflsxygod/drivelens-releases)"
if gh secret list 2>/dev/null | grep -q '^RELEASES_REPO_TOKEN'; then
  # the release "published" event starts the sync workflow (wait_run matches on the tag's commit)
  wait_run public-sync.yml "$TAG" || { echo "   public sync workflow failed — run scripts/sync-public.sh $TAG"; exit 1; }
else
  scripts/sync-public.sh "$TAG"
fi
