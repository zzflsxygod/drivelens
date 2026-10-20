#!/usr/bin/env bash
# Sync the public distribution repo (zzflsxygod/drivelens-releases) from this private repo.
#   scripts/sync-public.sh            → files only (README, LICENSE, CHANGELOG, screenshots, issue templates,
#                                       docs/install*.md, deploy/setup.sql, deploy/docker-compose.drivelens.yml)
#   scripts/sync-public.sh vX.Y.Z     → files + a public release vX.Y.Z (notes = that version's CHANGELOG section)
#                                       with the assets of the private release: DriveLens_X.Y.Z_web.zip, and with
#                                       NATIVE_BUILDS=1 (scripts/release.conf) also the .exe / .msi / .apk / .aab.
# Never copies source code. Idempotent: re-running updates the files and re-uploads the assets (--clobber).
# Auth: PUBLIC_REPO_TOKEN (CI: secret RELEASES_REPO_TOKEN, a fine-grained PAT with Contents: read & write on
#       drivelens-releases) for the public repo; without it the logged-in gh account is used (the build box).
#       The private release assets are read with GH_TOKEN / the gh login (CI: GITHUB_TOKEN).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PUBLIC="${PUBLIC_REPO:-zzflsxygod/drivelens-releases}"
PRIVATE="${PRIVATE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
TAG="${1:-}"
NATIVE_BUILDS=$( [ -f scripts/release.conf ] && sed -n 's/^NATIVE_BUILDS=\([01]\).*/\1/p' scripts/release.conf | tail -1 || true)
NATIVE_BUILDS="${DRIVELENS_NATIVE_BUILDS:-${NATIVE_BUILDS:-1}}"
PUB_TOKEN="${PUBLIC_REPO_TOKEN:-}"
pub_gh() { if [ -n "$PUB_TOKEN" ]; then GH_TOKEN="$PUB_TOKEN" gh "$@"; else gh "$@"; fi; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
echo "== sync files → $PUBLIC"
if [ -n "$PUB_TOKEN" ]; then URL="https://x-access-token:${PUB_TOKEN}@github.com/${PUBLIC}.git"
else URL="https://github.com/${PUBLIC}.git"; fi
git clone -q --depth 1 "$URL" "$WORK/pub" 2>/dev/null || { echo "   cannot clone $PUBLIC (missing repo or no access)"; exit 1; }
cd "$WORK/pub"
# mirror: everything in the public repo is generated from here (except .git)
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
SRC="$OLDPWD"
cp -a "$SRC/distribution/." .
mkdir -p docs deploy
cp "$SRC"/docs/install*.md docs/
cp "$SRC/deploy/setup.sql" "$SRC/deploy/docker-compose.drivelens.yml" deploy/
# guard: nothing that looks like source / secrets / the private server may leave this repo
BAD=$(grep -rIohE '[A-Za-z0-9.-]*oharuru\.com' . --exclude-dir=.git | sort -u | grep -vx 'drivelens-app\.oharuru\.com' || true)
[ -z "$BAD" ] || { echo "   refusing: unexpected host(s): $BAD"; exit 1; }
if grep -rInE 'BEGIN (RSA|OPENSSH|PRIVATE)|ghp_|github_pat_|gho_' . --exclude-dir=.git; then echo "   refusing: private URL or secret-like string found"; exit 1; fi
if find . -path ./.git -prune -o -type f \( -name '*.rs' -o -name '*.ts' -o -name 'Cargo.toml' -o -name 'package.json' -o -name '*.p12' -o -name '*.jks' \) -print | grep -q .; then echo "   refusing: source/secret file types found"; exit 1; fi
git add -A
if git diff --cached --quiet; then echo "   files unchanged"
else
  git -c user.name="DriveLens bot" -c user.email="drivelens-bot@users.noreply.github.com" commit -q -m "Sync from DriveLens ${TAG:-main}"
  git push -q origin HEAD:main && echo "   pushed $(git rev-parse --short HEAD)"
fi
cd "$SRC"
[ -n "$TAG" ] || exit 0

echo "== public release $TAG"
VER="${TAG#v}"
NOTES=$(awk -v v="$TAG" '$0 ~ "^## "v"( |$)" {f=1; next} /^## / {if (f) exit} f' distribution/CHANGELOG.md | sed '/./,$!d')
[ -n "$NOTES" ] || NOTES="See [CHANGELOG](https://github.com/${PUBLIC}/blob/main/CHANGELOG.md)."
NOTES="${NOTES}

---
**Use it:** web app https://drivelens-app.oharuru.com · [demo](https://drivelens-app.oharuru.com/?demo) · server: [install guide](https://github.com/${PUBLIC}/blob/main/docs/install.md) (image \`ghcr.io/zzflsxygod/drivelens-api\`)"
if [ "$NATIVE_BUILDS" != 1 ]; then NOTES="${NOTES}
Windows / Android installers are not part of this version; the web app has the latest features.
\`DriveLens_${VER}_web.zip\`: the web app as static files, for hosting it yourself (add your URL to \`DRIVELENS_CORS_ORIGINS\`)."; fi
if pub_gh release view "$TAG" -R "$PUBLIC" >/dev/null 2>&1; then
  pub_gh release edit "$TAG" -R "$PUBLIC" --title "DriveLens $TAG" --notes "$NOTES" >/dev/null
else
  pub_gh release create "$TAG" -R "$PUBLIC" --target main --title "DriveLens $TAG" --notes "$NOTES" --latest >/dev/null
fi
PATS=(-p "*_web.zip"); [ "$NATIVE_BUILDS" = 1 ] && PATS+=(-p "*.exe" -p "*.msi" -p "*.apk" -p "*.aab")
mkdir -p "$WORK/assets"
gh release download "$TAG" -R "$PRIVATE" "${PATS[@]}" -D "$WORK/assets" --clobber || { echo "   no assets on the private release $TAG"; exit 1; }
pub_gh release upload "$TAG" -R "$PUBLIC" "$WORK"/assets/* --clobber
pub_gh release view "$TAG" -R "$PUBLIC" --json url,assets -q '.url, (.assets[].name)'
