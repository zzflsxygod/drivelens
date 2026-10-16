#!/usr/bin/env bash
# DriveLens release: server first, then the app.
#   1. push main  → wait for the "Docker image" CI run of this commit to succeed (:latest pushed)
#   2. poll https://<domain>/health until "version" == the version in api/Cargo.toml
#      (Watchtower on the server pulls :latest within ~5 min)
#   3. tag vX.Y.Z → wait for the Windows build (creates a DRAFT release)
#   4. publish the draft as a prerelease (only now can users download the new app)
# Usage: scripts/release.sh [api-base-url] [--skip-health]   (default: $DRIVELENS_URL or https://drivelens.example.com)
# Steps are idempotent: re-running after a failure continues where it stopped.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE="${1:-${DRIVELENS_URL:-https://drivelens.example.com}}"; BASE="${BASE%/}"
SKIP_HEALTH="${2:-}"
VER=$(grep -m1 '^version' api/Cargo.toml | cut -d'"' -f2)
TAG="v$VER"
for f in app/package.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml; do
  grep -q "\"$VER\"\|= \"$VER\"" "$f" || { echo "version mismatch: $f is not $VER"; exit 1; }
done
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }

echo "== 1. push main and wait for Docker CI ($TAG)"
git push -q origin HEAD:main
SHA=$(git rev-parse HEAD)
wait_run() { # workflow name, ref (branch or tag)
  local id=""
  for _ in $(seq 60); do
    id=$(gh run list --workflow "$1" --json databaseId,headSha,headBranch \
         -q "[.[] | select(.headSha==\"$SHA\" and .headBranch==\"$2\")][0].databaseId // empty")
    [ -n "$id" ] && break; sleep 10
  done
  [ -n "$id" ] || { echo "no '$1' run for $SHA on $2"; exit 1; }
  gh run watch "$id" --exit-status --interval 30 >/dev/null && echo "   $1 ($2) ok: run $id"
}
wait_run docker.yml main

if [ "$SKIP_HEALTH" != "--skip-health" ]; then
  echo "== 2. wait until $BASE/health reports $VER (Watchtower polls every 5 min; timeout 30 min)"
  for i in $(seq 120); do
    got=$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
    [ "$got" = "$VER" ] && { echo "   server is $got"; break; }
    [ "$i" = 120 ] && { echo "   server still reports '${got:-unreachable}' — not publishing. Re-run later."; exit 2; }
    sleep 15
  done
fi

echo "== 3. tag $TAG and wait for the Windows build (draft release)"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag "$TAG"
git push -q origin "$TAG" 2>/dev/null || true
wait_run windows.yml "$TAG"

echo "== 4. publish $TAG as prerelease"
gh release edit "$TAG" --draft=false --prerelease
gh release view "$TAG" --json url,isDraft,isPrerelease,assets -q '.url, "draft=\(.isDraft) prerelease=\(.isPrerelease)", (.assets[].name)'
