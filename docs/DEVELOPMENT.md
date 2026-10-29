# DriveLens development guide

DriveLens is a third-party viewer for [TeslaMate](https://github.com/teslamate-org/teslamate): `drivelens-api` (Rust / Axum) reads TeslaMate's PostgreSQL read-only, and the web app / PWA (Vite + TypeScript) talks to it over HTTPS + Bearer Token. For installing and running the server, see the install guide: [English](install.md) · [中文](install.zh.md) · [日本語](install.ja.md). Contribution process: [CONTRIBUTING.md](../CONTRIBUTING.md). Security: [SECURITY.md](../SECURITY.md).

```
Browser (web / PWA) ──HTTPS + Bearer Token──>  tunnel / reverse proxy (Cloudflare Tunnel, tailscale serve…) ──>  drivelens-api :8080  ──>  PostgreSQL (TeslaMate)
```

## Repository layout

```
drivelens/
├── api/                  # drivelens-api (Rust / Axum), Dockerfile, deny.toml / about.toml (dependency licenses)
│   └── src/              # main.rs (routes, migration), auth.rs (auth, device tokens), summary / report / insights / journey / phase2 / push.rs
├── app/                  # Frontend (Vite + TypeScript + MapLibre GL); same code builds the web app and the (paused) Tauri app
│   ├── src/              # main.ts entry, locales/{zh,en,ja}.ts strings, demo/ demo-mode data
│   ├── web-public/       # Static files for the web build only (_headers, icons)
│   ├── scripts/          # check-i18n.mjs, demo/fetch-routes.py (generates demo routes)
│   └── src-tauri/        # Tauri 2 shell (Windows / Android / iOS; publishing currently paused)
├── deploy/               # setup.sql (DB role + drivelens schema), docker-compose.drivelens.yml; drivelens-*.sql are upgrade scripts for old installs
├── docs/                 # Install guide (en/zh/ja), this development guide (English), screenshots
├── scripts/              # release.sh (maintainer releases), third-party-licenses.sh
├── testdata/             # TeslaMate-compatible schema subset + scripts that generate sample data (tests only)
└── third_party/          # Third-party notices (TeslaMate NOTICE)
```

## Local development

Prerequisites: Rust stable (`rustup update`), Node.js 20+, PostgreSQL (for local tests).

```bash
# 1. Test database (testdata only — never run schema.sql on a real TeslaMate database)
sudo -u postgres psql -c "CREATE USER teslamate PASSWORD 'secret'" -c "CREATE DATABASE teslamate OWNER teslamate"
cd testdata && python3 gen_sample.py
PGPASSWORD=secret psql -h localhost -U teslamate teslamate -f schema.sql -f sample_data.sql

# 2. API
cd ../api
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate API_TOKEN=dev-token-1234567890 \
  DRIVELENS_CORS_ORIGINS=http://localhost:1420,http://localhost:4174 cargo run

# 3. Frontend: open http://localhost:1420/ and enter http://127.0.0.1:8080 and dev-token-1234567890 on the setup screen
cd ../app && npm ci && npm run dev
```

- Web build: `npm run build:web` → `app/dist-web/` (also emits `manifest.webmanifest`, shell-only `sw.js`, `_headers`, `third-party-licenses.txt`); preview: `npm run preview:web` (`http://localhost:4174`).
- Demo mode works offline without a server: “Try demo” on the setup screen, or open `/?demo` (data in `app/src/demo/`).
- Performance testing: after the sample data, run `testdata/bigdata.sql` (~3 million positions). Battery-health reference data: `testdata/gen_battery_health.py`.
- Build variables: `VITE_DONATE_URL` (Support card at the bottom of Settings; empty = hidden), `VITE_DONATE_WEB_ONLY=1`, `VITE_WEB_ORIGIN` (default official web origin), `VITE_DRIVELENS_CHANNEL=preview` (preview deploys only: header preview strip + distinct PWA name).

## Checks before you commit

```bash
cd api && cargo test && cargo clippy --all-targets      # unit tests (auth flow, push SSRF protection, CORS, …)
cd app && npm run build && npm run build:web            # both run npm run check:i18n first
```

- `npm run check:i18n`: the three language tables have the same keys and placeholders, and no leftover hardcoded Chinese remains in the source. Add new strings in all three languages (Chinese is the source).
- Pull requests are checked by `.github/workflows/ci.yml`: `cargo test`, dependency licenses (`cargo deny check licenses`, rules in `api/deny.toml`), both frontend builds, and a `Signed-off-by` on every commit (`git commit -s`, DCO).
- New source files start with an `SPDX-License-Identifier: AGPL-3.0-or-later` comment on the first line.

## API

Everything except `/health` and `POST /api/auth/pair` needs `Authorization: Bearer <token>`: the server token (owner key, `API_TOKEN`) or a device token (`dlt_…`, since 0.14.0). `GET /health` returns `{"status","version","api_level"}` (current `api_level` 16); `GET /api/health` also checks the database and whether each feature is available.

| Endpoint | Description |
|---|---|
| `GET /api/cars` | Car list |
| `GET /api/cars/:id/status` (api_level ≥ 16 includes `tpms`) · `/last-activity` · `/stats?tz=` · `/summary?tz=` | Home data (status, latest drive / charge, month and lifetime stats) |
| `GET /api/drives` · `/api/charges` (`car_id`, `paged=true&before=<cursor>&limit=`; `/drives` and `/journeys` also accept optional `q` place/name search, api_level ≥ 16) | Drive / charge lists (keyset paging, `{items, next_cursor}`; legacy `limit/offset` still works) |
| `GET /api/drives/:id`, `/api/drives/:id/path`, `/api/charges/:id` | Detail, GPS path, charging curve |
| `GET /api/cars/:id/months?tz=` | Monthly totals (list month headers / jump) |
| `GET /api/cars/:id/report?month=YYYY-MM&tz=&currency=`, `/trends` | Monthly report |
| `GET /api/cars/:id/footprint?month=&tz=`, `/battery?summary=&tz=&new_kwh=` | Footprint, battery health (`tm` matches TeslaMate “Battery Health”) |
| `PUT/DELETE /api/charges/:id/cost` | Manual charging cost |
| `GET/PUT/DELETE /api/addresses/...` | Custom place names |
| `/api/journeys…` | Journeys (merged drives), suggestions, dismiss, cover, weather, speed bands |
| `/api/push/…` | Web push: `key`, `subscription`, `subscription/status`, `unsubscribe`, `test` |
| `GET /api/auth/me` | Current identity: `{kind:"owner"\|"device", device, device_auth, owner_key_mode}` |
| `POST /api/auth/devices` | Exchange server token for a device token (server token only): `{name}` → 201 `{token, device}` |
| `GET /api/auth/devices`, `PATCH/DELETE /api/auth/devices/:id`, `DELETE /api/auth/devices?except=current` | List, rename, revoke, revoke all other devices (server token or full device) |
| `PATCH/DELETE /api/auth/devices/current` | Rename this device, sign this device out (any device) |
| `POST /api/auth/pairings` | Create a pairing code: `{scope:"full"\|"read", device_ttl_days?}` → 201 `{code:"XXXX-XXXX", expires_at}` (10 minutes, one-shot) |
| `POST /api/auth/pair` | **No auth required**: `{code, name}` → 201 `{token, device}`; bad code 400 `{code:"invalid_code"}`, too many failures 429 |

- Device auth (`api/src/auth.rs`): the database stores only SHA-256 of tokens / pairing codes; `read` devices may only GET/HEAD, plus `/api/push/*` and `PATCH/DELETE /api/auth/devices/current` (otherwise 403 `{code:"read_only"}`). With `DRIVELENS_OWNER_KEY_MODE=pair-only`, the server token may only call `/api/auth/*` (otherwise 403 `{code:"owner_key_pair_only"}`). If tables cannot be created (no CREATE privilege), `device_auth:false`: the server token still works, and other `/api/auth/*` calls return 503 `{code:"device_auth_unavailable"}`. Database-backed tests: `DRIVELENS_TEST_DATABASE_URL=postgres://… cargo test` (skipped when unset).
- The app gates UI on `api_level` (`FEATURE_LEVEL` in `app/src/version.ts`). When you add a feature that needs the server: bump the API's `API_LEVEL` by 1, add a matching `FEATURE_LEVEL` on the frontend, and hide the feature on older servers with an update hint.
- Environment variables are listed in the install guide's “Environment variables” section (`DATABASE_URL`, `API_TOKEN`, `BIND_ADDR`, `DRIVELENS_CORS_ORIGINS`, `DRIVELENS_TRUST_PROXY_HEADERS`, `DRIVELENS_PUSH_HOSTS`, `DRIVELENS_VAPID_*`, `RUST_LOG`).

## Database rules

- **Never modify TeslaMate's tables.** TeslaMate access is SELECT only. DriveLens' own data (place aliases, manual costs, journeys, weather cache, push subscriptions, …) lives only in the `drivelens` schema.
- `deploy/setup.sql` creates the read-only role `drivelens_ro` and the `drivelens` schema (safe to re-run). On start, the API creates / upgrades tables in `drivelens` (`migrate()` in `main.rs`, `journey::try_create_tables`, `phase2::try_migrate`, `push::try_migrate`, `auth::try_migrate`). Missing privileges or tables only turn that feature off and log `disabled features: …`.
- `deploy/drivelens-init.sql` and `drivelens-v*.sql` are upgrade scripts from early installs that created tables by hand; new installs do not need them.
- Energy use follows TeslaMate Grafana's formula: `(start rated range − end rated range) × cars.efficiency`.

## Frontend notes

- Strings: `app/src/locales/{zh,en,ja}.ts`; formatting (dates, durations, months): `app/src/i18n.ts`.
- On the web build, the token lives only in the browser's localStorage (`drivelens-settings`). From app 1.2.0 the saved credential is a device token (`tokenKind:"device"`, `app/src/auth.ts`): the setup screen's second field accepts a pairing code or the server token; a server token is exchanged for a device token and then discarded, and older settings migrate on start. A 401 on a device token fires `drivelens-signed-out`, clears the connection, server caches (`isServerCacheKey()`) and notification subscriptions, and returns to the setup screen. Settings → Devices is in `app/src/devices.ts`; read-only devices hide every write entry point with `canWrite()`. `src/urlguard.ts` runs first and strips `api` / `token` / `key` from the address bar; the app never reads the server URL or token from the URL.
- Anything interpolated into `innerHTML` is escaped (each module's `esc()`) or set via `textContent`; deep-link parameters such as `?view=` are validated first.
- CSP: web build in `app/web-public/_headers`, Tauri in `app/src-tauri/tauri.conf.json`; do not load external scripts or fonts.
- Popover menus use `popMenu()` / `placePopover()` from `ui.ts`; sheets (`.modal`) are positioned to the visual viewport by `sheets.ts` (iOS keyboard).
- The service worker (generated by `vite.config.ts`) caches only the app shell and never caches API responses.

## Native apps (paused)

Windows / Android packaging has been paused since v0.15.0: `.github/workflows/windows.yml` and `android.yml` are manual-only, and `scripts/release.conf` sets `NATIVE_BUILDS=0`. The Android project lives under `app/src-tauri/gen/android` (custom pieces in `MainActivity.kt`, `network_security_config.xml`, `build.gradle.kts`); signing comes from `DRIVELENS_KEYSTORE_PROPERTIES` or the gitignored `gen/android/keystore.properties`. Local builds: `npm run tauri dev` / `npx tauri android dev` (needs JDK 17+, Android SDK, NDK 27).

## Releases (maintainer)

- **`main` is protected; every change (including maintainer and release work) goes through a PR**: a PR is required (0 approvals), the `api` / `app` / `dco` checks must pass and the branch must be up to date with `main`, force-push and deletion are blocked, and history stays linear. The only merge method is **Rebase and merge** (each commit is kept as-is, including `Signed-off-by`); the branch is deleted after merge.
- Day-to-day changes: after `git commit -s`, run `scripts/pr.sh <branch>` (on a feature branch the name can be omitted). The script pushes the branch, opens a PR, waits for checks, rebase-merges, then moves local `main` to the merged `origin/main`. `--dry-run` only shows what it would do. Or by hand: `git push origin HEAD:fix/x && gh pr create --base main --head fix/x --fill && gh pr merge fix/x --rebase --auto`.
- `scripts/release.sh`: push HEAD to `release/vX.Y.Z` → open PR `release: vX.Y.Z` (body from CHANGELOG) → after checks pass, rebase-merge → wait for the merged commit on `main` to build the Docker image (`ghcr.io/zzflsxygod/drivelens-api`, amd64 + arm64, `.github/workflows/docker.yml`) → when `api/` changed, wait until the server `/health` reports the new version → tag the merged commit on `main`, let `web.yml` build and deploy the web app → publish the Release. Plain `X.Y.Z` is a normal Latest release; versions with a suffix are prereleases. Re-running after a failure continues where it stopped (reuse an open PR, skip an already merged one, use an existing tag). `--dry-run` only checks and shows step 1. Tags are not covered by branch protection (the repo has no tag rules).
- Release notes come from that version's section of the root `CHANGELOG.md`; bump `api/Cargo.toml` (when the server changed), `app/package.json`, `app/src-tauri/tauri.conf.json`, and `app/src-tauri/Cargo.toml` together.
- Web deploys need repository secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (forks without them skip the deploy and only upload the build artifact).

### Preview environment (before merge / release)

- Same Cloudflare Pages project `drivelens-app`. Running `gh workflow run web.yml --ref <branch> -f target=preview` by hand deploys to the Pages `preview` branch; the stable alias is `https://preview.drivelens-app.pages.dev`.
- Preview builds set `VITE_DRIVELENS_CHANNEL=preview` (header “Preview” strip + distinct PWA name). Production (release tag or `-f target=production`) looks unchanged and still deploys to Pages `main`.
- To let the preview origin call the API, set both the official and preview origins in `.env`, **and** pass the
  variable into the container (Compose does not forward it unless the `environment:` line is present). Example:

  ```bash
  # in TeslaMate's compose directory .env:
  DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com,https://preview.drivelens-app.pages.dev
  ```

  In `docker-compose.drivelens.yml`, under `drivelens-api` → `environment:`, uncomment (or add):

  ```yaml
  - DRIVELENS_CORS_ORIGINS=${DRIVELENS_CORS_ORIGINS}
  ```

  Then recreate the service (do not leave the line uncommented with an empty value — that clears the default):

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
  ```

  Do not put the preview origin in the API's default CORS allow-list in code.
- You can enable Access for **preview deployments** in the Cloudflare Pages project settings (your own email only); API requests go straight to your server and are unaffected.

## License

- DriveLens: GNU AGPL-3.0-or-later ([LICENSE](../LICENSE)). The web Settings → Help & feedback card links to the source (AGPL §13).
- The battery-health SQL is ported from TeslaMate (AGPL-3.0-or-later); see the note in `api/src/insights.rs` and [third_party/teslamate/NOTICE](../third_party/teslamate/NOTICE).
- Dependency licenses: `scripts/third-party-licenses.sh` regenerates `api/THIRD_PARTY_LICENSES.txt` (shipped in the Docker image under `/usr/share/doc/drivelens/`) and checks compatibility; the frontend list is generated at build time (`/third-party-licenses.txt`).
- Demo routes `app/src/demo/routes.json`: © OpenStreetMap contributors (ODbL); elevation from Copernicus DEM via Open-Meteo (CC BY 4.0).
