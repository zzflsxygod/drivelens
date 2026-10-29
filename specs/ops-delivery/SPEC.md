# ops-delivery — build, CI, packaging, release and deployment

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `api/Dockerfile`, `api/.dockerignore`, `api/drivelens-api.service`, `deploy/docker-compose.drivelens.yml`, `.github/workflows/{ci,docker,web,android,windows}.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/*`, `.github/FUNDING.yml`, `scripts/pr.sh`, `scripts/pr-lib.sh`, `scripts/release.sh`, `scripts/release.conf`, `scripts/third-party-licenses.sh`, `api/deny.toml`, `api/about.toml`, `api/about.hbs`, `testdata/*`, `.gitignore`, `CONTRIBUTING.md`, `docs/DEVELOPMENT.md`, `docs/install.md`, `SECURITY.md`.
> In this document, "the system" means the DriveLens delivery tooling: the container image and its build, the compose deployment template, the GitHub Actions workflows, the maintainer scripts, the license checks and the test fixtures.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

ops-delivery turns the repository into things people run: a multi-architecture Docker image of drivelens-api that self-hosters add next to TeslaMate, the web app deployed to the official URL, and (paused) native installers. It also guards the main branch: every change lands through a pull request that passes tests, builds, a license check and a DCO sign-off check, and releases are published only after the new server version is live. The test fixtures let contributors run the API against fictional TeslaMate-shaped data.

## 2. Responsibility boundaries

### 2.1 In scope
- Building and publishing the `drivelens-api` container image (`ghcr.io/zzflsxygod/drivelens-api`).
- The compose template users add to TeslaMate's compose project, including the optional cloudflared and Watchtower services.
- The systemd unit file in `api/`.
- Pull-request CI (`api`, `app`, `dco` jobs), the Docker, web and (paused) native workflows.
- Dependabot configuration and issue templates.
- Maintainer scripts: landing changes on `main` (`scripts/pr.sh`, `scripts/pr-lib.sh`) and releasing (`scripts/release.sh`, `scripts/release.conf`).
- Rust dependency license compliance (`api/deny.toml`, `api/about.*`, `scripts/third-party-licenses.sh`, `api/THIRD_PARTY_LICENSES.txt`).
- Test fixtures in `testdata/` and the contribution process (`CONTRIBUTING.md`, `docs/DEVELOPMENT.md`).

### 2.2 Out of scope
- `deploy/setup.sql` and the `drivelens` schema → `api-storage`.
- The API's environment variables and runtime behavior → `api-core`, `api-auth`, `api-push`.
- The Vite build modes, PWA plugin, service worker, `_headers`, web third-party license list, Tauri configuration and Android project → `app-platforms`.
- `scripts/check-i18n.mjs` (run by the app build) → `app-i18n`.
- `app/scripts/demo/fetch-routes.py` → `app-demo`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-core` — the binary, its environment variables, and `GET /health` (`version`) polled by `scripts/release.sh`.
  - `api-storage` — `deploy/setup.sql` (run by users before starting the compose service); the `drivelens_ro` role used in `DATABASE_URL`.
  - `app-platforms` — `npm run build` / `npm run build:web` and their outputs (`dist-web/sw.js`, `dist-web/manifest.webmanifest`, `dist-web/_headers`); Tauri build for native installers.
  - `app-i18n` — `check-i18n` runs inside both app builds.
  - `ext:GitHub Actions`, `ext:ghcr.io`, `ext:GitHub Releases` (`gh` CLI), `ext:Cloudflare Pages` (`wrangler@4.152.0`), `ext:Docker` / Docker Compose, `ext:tonistiigi/xx`, `ext:distroless cc-debian12`, `ext:Watchtower` (`nickfedor/watchtower`), `ext:cloudflared`, `ext:cargo-deny`, `ext:cargo-about`, `ext:Dependabot`, `ext:Android SDK/NDK`, `ext:tauri-action`.
- **Used by:** self-hosters (compose template, image), the maintainer (scripts), contributors (CI, fixtures, CONTRIBUTING).
- **Provided interface:**

  | Item | Values |
  |---|---|
  | Image | `ghcr.io/<owner>/drivelens-api`, tags `latest` (default branch), `vX.Y.Z` (git tag), `sha-<short>`; platforms `linux/amd64`, `linux/arm64` |
  | Compose service | `drivelens-api` (plus commented `cloudflared`, `watchtower`) |
  | `.env` variables | `DRIVELENS_DB_PASS` (required), `DRIVELENS_API_TOKEN` (required), `DRIVELENS_DB_NAME` (default `teslamate`), `DRIVELENS_IMAGE` (default `ghcr.io/zzflsxygod/drivelens-api:latest`), `CLOUDFLARE_TUNNEL_TOKEN`, `TZ` (watchtower) |
  | Required PR checks | `api`, `app`, `dco` |
  | Script inputs | `scripts/release.sh [api-base-url] [--skip-health] [--dry-run]`, `scripts/pr.sh [branch] [--dry-run]`; env `DRIVELENS_URL`, `DRIVELENS_PRERELEASE`, `DRIVELENS_NATIVE_BUILDS`; file `scripts/.release.local` (git-ignored); `scripts/release.conf` `NATIVE_BUILDS` |
  | Repository settings used by workflows | variables `DONATE_URL`, `WEB_ORIGIN`, `CF_PAGES_PROJECT`; secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |

## 3. External behavior

### 3.1 Container image
- **OPS-001** When the image is built, the system SHALL cross-compile the binary on the build host for the target platform with `tonistiigi/xx` and `cargo build --release --locked`, caching dependencies in a separate layer, and verify the result with `xx-verify`. (src: api/Dockerfile:4-19; comment: api/Dockerfile:2-3)
- **OPS-002** When the image runs, it SHALL be based on `gcr.io/distroless/cc-debian12:nonroot`, run as user `nonroot:nonroot`, contain no shell, and start `/usr/local/bin/drivelens-api` as the entrypoint. (src: api/Dockerfile:21-22, 27, 32-33)
- **OPS-003** When the image runs without overrides, it SHALL set `BIND_ADDR=0.0.0.0:8080` and `RUST_LOG=info` and expose port 8080. (src: api/Dockerfile:30-31; doc: docs/install.md "Environment variables")
- **OPS-004** When the image is built, it SHALL include `/usr/share/doc/drivelens/THIRD_PARTY_LICENSES.txt` copied from `api/THIRD_PARTY_LICENSES.txt`. (src: api/Dockerfile:28-29; doc: CHANGELOG.md v1.1.2 "Server 0.13.1")
- **OPS-005** When the image is built, it SHALL carry the OCI labels `org.opencontainers.image.title`, `description` and `source`; the CI build SHALL also set `org.opencontainers.image.version` to the `version` of `api/Cargo.toml`. (src: api/Dockerfile:23-26; src: .github/workflows/docker.yml:27-39)
- **OPS-006** When the Docker build context is sent, `target/` SHALL be excluded. (src: api/.dockerignore:1)

### 3.2 Image publishing (`docker.yml`)
- **OPS-010** When a commit that changes `api/**` or `docker.yml` is pushed to `main`, the system SHALL build the image for `linux/amd64` and `linux/arm64` and push it to `ghcr.io/<owner>/drivelens-api` with the tags `latest` and `sha-<short>`. (src: .github/workflows/docker.yml:3-7, 32-36, 40-46)
- **OPS-011** *(confirmed: GitHub does not evaluate path filters for tag pushes, and the run history shows `docker.yml` runs for the tags v1.1.0 – v1.2.2)* When a tag `v*` is pushed, the system SHALL build and push the image tagged with the git tag name (e.g. `v1.2.2`); GitHub does not apply the `paths` filter to tag pushes, so every release tag gets an image. (src: .github/workflows/docker.yml:6-7, 35; doc: deploy/docker-compose.drivelens.yml:11)
- **OPS-012** When the workflow runs, it SHALL authenticate to ghcr.io with the workflow's `GITHUB_TOKEN` (`packages: write`) and use the GitHub Actions build cache. (src: .github/workflows/docker.yml:10-12, 22-26, 47-48)

### 3.3 Compose deployment template
- **OPS-020** When the template is used next to TeslaMate's compose file, the service `drivelens-api` SHALL use `${DRIVELENS_IMAGE:-ghcr.io/zzflsxygod/drivelens-api:latest}`, restart always, and depend on the `database` service of the same compose project. (src: deploy/docker-compose.drivelens.yml:10-15; comment: deploy/docker-compose.drivelens.yml:1-4; doc: docs/install.md "4. Start drivelens-api")
- **OPS-021** When the service starts, it SHALL get `DATABASE_URL=postgres://drivelens_ro:${DRIVELENS_DB_PASS}@database:5432/${DRIVELENS_DB_NAME:-teslamate}`, `API_TOKEN=${DRIVELENS_API_TOKEN}` and `RUST_LOG=info`; Compose SHALL refuse to start the service when `DRIVELENS_DB_PASS` or `DRIVELENS_API_TOKEN` is unset (`:?`). (src: deploy/docker-compose.drivelens.yml:16-19)
- **OPS-022** When the service runs, it SHALL publish port 8080 on `127.0.0.1` only. (src: deploy/docker-compose.drivelens.yml:27-30; doc: docs/install.md "4. Start drivelens-api")
- **OPS-023** When the service runs, its root filesystem SHALL be read-only, `no-new-privileges` SHALL be set, and the Docker healthcheck SHALL be disabled because the distroless image has no shell or curl. (src: deploy/docker-compose.drivelens.yml:33-37)
- **OPS-024** When the service runs, it SHALL carry the label `com.centurylinklabs.watchtower.enable=true`; the optional Watchtower service, when uncommented, SHALL update only labelled containers, poll every 21600 s (6 h) and clean up old images. (src: deploy/docker-compose.drivelens.yml:31-32, 48-58; doc: docs/install.md "8. Updates")
- **OPS-025** When the optional `cloudflared` service is uncommented, it SHALL run `tunnel --no-autoupdate run` with `TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}`, and the API port mapping may be removed. (src: deploy/docker-compose.drivelens.yml:27, 39-46; doc: docs/install.md "Option A: Cloudflare Tunnel")
- **OPS-026** When `DRIVELENS_CORS_ORIGINS` or `DRIVELENS_OWNER_KEY_MODE` is needed, the template SHALL offer them as commented, documented lines (unset by default). (src: deploy/docker-compose.drivelens.yml:20-26)

### 3.4 systemd unit
- **OPS-030** **[OWNER DECISION NEEDED]** (see CB-2) When `api/drivelens-api.service` is installed, it SHALL start `/usr/local/bin/drivelens-api` with variables from `/etc/drivelens-api.env`, as a dynamic user with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, restarting on failure after the network is online. No document describes this deployment path. (src: api/drivelens-api.service:1-17)

### 3.5 Pull-request CI (`ci.yml`)
- **OPS-040** When a pull request is opened or updated (including from forks), or the workflow is started by hand, the system SHALL run the jobs `api`, `app` and `dco`. (src: .github/workflows/ci.yml:4-6, 11-53; doc: CONTRIBUTING.md "Pull requests")
- **OPS-041** When the `api` job runs, it SHALL run `cargo test --locked` in `api/` and then `cargo deny check licenses` against `api/deny.toml`. (src: .github/workflows/ci.yml:12-24)
- **OPS-042** When the `app` job runs, it SHALL use Node 22, run `npm ci`, `npm run build` and `npm run build:web` in `app/`. (src: .github/workflows/ci.yml:26-36)
- **OPS-043** When the `dco` job runs for a pull request, it SHALL fail if any non-merge commit between the base and head SHA has no line starting with `Signed-off-by: `, naming each such commit; when there is no pull-request base (manual run), it SHALL pass. (src: .github/workflows/ci.yml:38-53)
- **OPS-044** When CI runs, it SHALL use no secrets, a read-only token, and checkouts without persisted credentials. (comment: .github/workflows/ci.yml:3; src: .github/workflows/ci.yml:8-9, 17, 31, 42)
- **OPS-045** When `cargo test` runs in CI, the database-backed test `db_device_flow` SHALL be skipped, because `DRIVELENS_TEST_DATABASE_URL` is not set there. (src: api/src/main.rs:756-760; src: .github/workflows/ci.yml:21)
- **OPS-046** When `cargo deny check licenses` runs, every Rust dependency license SHALL be one of `AGPL-3.0-or-later`, `Apache-2.0`, `Apache-2.0 WITH LLVM-exception`, `MIT`, `MIT-0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Zlib`, `BSL-1.0`, `CC0-1.0`, `Unlicense`, `Unicode-3.0`, `CDLA-Permissive-2.0`, with a detection confidence threshold of 0.9. (src: api/deny.toml:1-10)

### 3.6 Web app build and deployment (`web.yml`)
- **OPS-050** When a commit that changes `app/**` or `web.yml` is pushed to `main`, a `v*` tag is pushed, or the workflow is started by hand, the system SHALL run `npm run build:web` with `VITE_DONATE_URL` from the variable `DONATE_URL` and `VITE_WEB_ORIGIN` from the variable `WEB_ORIGIN` (default `https://drivelens-app.oharuru.com`; for a manual `target=preview` run, `https://preview.drivelens-app.pages.dev`), fail unless `dist-web/sw.js`, `dist-web/manifest.webmanifest` and `dist-web/_headers` exist, and upload `app/dist-web/` as the artifact `DriveLens-web`. (src: .github/workflows/web.yml:44-66)
- **OPS-051** When the ref is a tag, or a manual run sets `target=production`, and both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, the system SHALL create the Cloudflare Pages project if needed (name from `CF_PAGES_PROJECT`, default `drivelens-app`) and deploy `dist-web` to its `main` (production) branch with `wrangler@4.152.0`. (src: .github/workflows/web.yml:74-88; comment: .github/workflows/web.yml:3-12)
- **OPS-052** When a deploy step runs without those two secrets, the system SHALL skip that deploy with a notice and succeed. (src: .github/workflows/web.yml:81-84, 97-100; doc: docs/DEVELOPMENT.md "Releases (maintainer)")
- **OPS-053** When the build job runs longer than 20 minutes, it SHALL be cancelled. (src: .github/workflows/web.yml:35)
- **OPS-054** When a manual run sets `target=preview`, the system SHALL set `VITE_DRIVELENS_CHANNEL=preview` for the build and, when the Cloudflare secrets are set, deploy `dist-web` to the Pages project's `preview` branch (stable alias `https://preview.<project>.pages.dev`). Other runs SHALL leave `VITE_DRIVELENS_CHANNEL` empty. (src: .github/workflows/web.yml:58-60, 90-104; doc: docs/DEVELOPMENT.md "Preview environment"; doc: AGENTS.md §8)
- **OPS-055** When the workflow deploys, it SHALL write production only from a release tag or an explicit `target=production` manual run, and preview only from an explicit `target=preview` manual run. A preview run SHALL NOT deploy to the Pages `main` branch. (src: .github/workflows/web.yml:74-75, 90-91; comment: .github/workflows/web.yml:4-8)

### 3.7 Native builds (paused)
- **OPS-060** When the Windows workflow is started by hand, the system SHALL build the Tauri app on `windows-latest` with Node 20 and upload the NSIS `.exe` and `.msi` installers as `DriveLens-windows-x64`; on a tag ref it SHALL create a draft prerelease named `DriveLens <tag>`. (src: .github/workflows/windows.yml:7, 16-60)
- **OPS-061** When the Android workflow is started by hand, the system SHALL build a signed universal APK and an AAB for `aarch64`, `armv7` and `x86_64` with a keystore decoded from secrets into the runner's temp directory, verify that the APK certificate SHA-256 digest starts with `a970e58a`, delete the keystore files, upload the artifact `DriveLens-android`, and on a tag ref attach the files to the draft release (waiting up to 30 minutes for it, creating it as a last resort). (src: .github/workflows/android.yml:7, 14-134)
- **OPS-062** When code is pushed or tagged, the native workflows SHALL NOT start, and `scripts/release.sh` SHALL NOT wait for them, because native packaging is paused (`NATIVE_BUILDS=0`). (src: .github/workflows/windows.yml:4-11; src: .github/workflows/android.yml:4-9; src: scripts/release.conf:3-9; doc: docs/DEVELOPMENT.md "Native apps (paused)"; doc: CONTRIBUTING.md "3. App")

### 3.8 Landing changes on `main` (`scripts/pr.sh`, `scripts/pr-lib.sh`)
- **OPS-070** When `scripts/pr.sh` runs with uncommitted changes, or on `main` without a branch argument, the system SHALL stop with an error. (src: scripts/pr.sh:16-19)
- **OPS-071** When `pr_land` runs and `origin/main` already has the same content as `HEAD`, the system SHALL only move the local `main` to `origin/main` and return. (src: scripts/pr-lib.sh:15-18, 66-78)
- **OPS-072** When `origin/main` is not an ancestor of `HEAD`, the system SHALL stop and tell the user to rebase onto `origin/main`. (src: scripts/pr-lib.sh:19-20)
- **OPS-073** When a commit between `origin/main` and `HEAD` lacks a `Signed-off-by: ` line, the system SHALL stop before pushing and list those commits. (src: scripts/pr-lib.sh:21-25)
- **OPS-074** When `--dry-run` is given, the system SHALL print the branch, PR title and commit list it would use and change nothing. (src: scripts/pr-lib.sh:27-33)
- **OPS-075** When landing proceeds, the system SHALL force-push `HEAD` to the branch, open a PR to `main` or reuse an open one (title = the commit subject when there is one commit, else the branch name; body = the commit list), poll every 30 s for up to 60 minutes until the checks `api`, `app` and `dco` on that head SHA pass, merge with `--rebase --match-head-commit`, verify that `origin/main` has the same content as `HEAD`, and move the local `main` to `origin/main`. (src: scripts/pr.sh:20-26; src: scripts/pr-lib.sh:8, 34-63)
- **OPS-076** When any required check fails, the system SHALL stop and not merge. (src: scripts/pr-lib.sh:50)

### 3.9 Release (`scripts/release.sh`)
- **OPS-080** When `release.sh` starts, the system SHALL take the server base URL from the first argument, else `DRIVELENS_URL`, else the first line of `scripts/.release.local`, and stop when none is given. (src: scripts/release.sh:26-30)
- **OPS-081** When `release.sh` starts, the system SHALL read the app version from `app/package.json`, stop unless `app/src-tauri/tauri.conf.json` and `app/src-tauri/Cargo.toml` contain the same version, and stop if the working tree is not clean. (src: scripts/release.sh:33-41; doc: docs/DEVELOPMENT.md "Releases (maintainer)")
- **OPS-082** When the tag `v<version>` does not exist yet, the system SHALL land `HEAD` through a PR from branch `release/v<version>` titled `release: v<version>` whose body is that version's section of `CHANGELOG.md` (or a fallback line), then use the merged `origin/main` commit. When the tag exists, it SHALL use the tagged commit and open no PR. (src: scripts/release.sh:43-56)
- **OPS-083** When the release commit is known, the system SHALL wait for a successful `docker.yml` run on `main` for that commit, or accept the latest successful run whose `api/` and workflow content is identical. (src: scripts/release.sh:57-85)
- **OPS-084** When `api/` changed since the previous release tag and `--skip-health` is not given, the system SHALL poll `<base>/health` every 15 s, up to 120 times (30 minutes), until `version` equals the `api/Cargo.toml` version, and exit with status 2 without tagging when it does not. When `api/` is unchanged since the previous tag, it SHALL skip this wait. (src: scripts/release.sh:87-102)
- **OPS-085** When the server check passes, the system SHALL tag the release commit `v<version>`, push the tag and wait for the `web.yml` run on that tag; with `NATIVE_BUILDS=1` it SHALL also wait for the Windows and Android runs and require the `_android_universal.apk` and `_android.aab` assets on the draft; with `NATIVE_BUILDS=0` it SHALL create the draft release itself with the CHANGELOG section as notes (or a fallback text naming the web app and server image). (src: scripts/release.sh:104-125)
- **OPS-086** When publishing, the system SHALL mark the release as prerelease if the version starts with `0.` or contains `-` (or `DRIVELENS_PRERELEASE=1`), and otherwise as a normal release marked Latest (or as forced by `DRIVELENS_PRERELEASE=0`). (src: scripts/release.sh:36-37, 127-133; comment: scripts/release.sh:13-14)
- **OPS-087** When `NATIVE_BUILDS` is resolved, `DRIVELENS_NATIVE_BUILDS` SHALL override `scripts/release.conf`, and the default without either SHALL be `1`. (src: scripts/release.sh:31-32; comment: scripts/release.conf:8)
- **OPS-088** When `release.sh` is re-run after a failure, it SHALL continue where it stopped (reuse an open PR, detect an already merged one, use an existing tag). (comment: scripts/release.sh:20-21; src: scripts/pr-lib.sh:16-18, 35-39; src: scripts/release.sh:44-47)
- **OPS-089** When `--dry-run` is given, the system SHALL run the checks, show what step 1 would do and stop without pushing. (src: scripts/release.sh:18, 47, 54)

### 3.10 License files
- **OPS-090** When `scripts/third-party-licenses.sh` runs, the system SHALL run `cargo deny check licenses`, regenerate `api/THIRD_PARTY_LICENSES.txt` with `cargo about` from `api/about.hbs`, and print the number of crate entries. (src: scripts/third-party-licenses.sh:6-10)
- **OPS-091** When `cargo about` generates the file, it SHALL consider only the targets `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu`, ignore build, dev and private crates, and accept the same third-party licenses as `deny.toml` (without AGPL). (src: api/about.toml:1-9; src: api/about.hbs:1-15)

### 3.11 Dependency updates and intake
- **OPS-100** When Dependabot runs (weekly, Monday, Asia/Tokyo), it SHALL open grouped update PRs for GitHub Actions, the `api` crate, the Tauri crate and the npm packages, grouping minor and patch updates, and SHALL ignore major updates of `sqlx` and `getrandom`. (src: .github/dependabot.yml:1-33)
- **OPS-101** When a user opens an issue, blank issues SHALL be disabled, the chooser SHALL link the install guide and demo mode, the bug form SHALL require a description, the app platform and the app version, and SHALL warn against posting the server URL, token, passwords or location data. (src: .github/ISSUE_TEMPLATE/config.yml:1-8; src: .github/ISSUE_TEMPLATE/bug_report.yml:1-53; src: .github/ISSUE_TEMPLATE/feature_request.yml:1-31)

### 3.12 Test fixtures (`testdata/`)
- **OPS-110** When `testdata/schema.sql` is loaded into an empty database, it SHALL create the TeslaMate subset the API reads (`cars`, `addresses`, `geofences`, `drives`, `positions`, `charging_processes`, `charges`, `states`, `updates`, the enum types `billing_type` and `states_status`, and TeslaMate's indexes). (src: testdata/schema.sql:1-65)
- **OPS-111** When `testdata/gen_sample.py` runs, it SHALL write the same `sample_data.sql` every time (fixed seed 1): one fictional car and fictional places around Tokyo, with the home geofence at Tokyo Tower. (src: testdata/gen_sample.py:1-18)
- **OPS-112** When `testdata/bigdata.sql` is loaded after the sample data, it SHALL add about 3 million positions, 6,000 drives and 1,500 charging sessions for performance testing. (src: testdata/bigdata.sql:1-25; doc: CONTRIBUTING.md "1. Database with synthetic sample data")
- **OPS-113** When `testdata/gen_battery_health.py` runs, it SHALL write `battery_health_fixture.sql` (seed 7) with two cars and 260 charging sessions, on which `/battery` `tm` is documented to equal TeslaMate's Grafana result (now 75.01 kWh, max 81.36 kWh, health 92.2 %, 120 cycles). (src: testdata/gen_battery_health.py:2-5, 9-10, 35)

## 4. Key design decisions

- **D-1 Cross-compile instead of emulating.** The image is built with `tonistiigi/xx` on the build host instead of running the whole Rust build under QEMU, which is "much faster". (comment: api/Dockerfile:2-3)
- **D-2 Minimal runtime image.** Distroless with glibc and CA certificates, no shell, non-root user; consequently no Docker healthcheck. (comment: api/Dockerfile:21; comment: deploy/docker-compose.drivelens.yml:37)
- **D-3 Loopback-only port, HTTPS from a tunnel.** The template publishes 8080 on `127.0.0.1`; HTTPS comes from Cloudflare Tunnel or `tailscale serve`. (comment: deploy/docker-compose.drivelens.yml:27-28; doc: docs/install.md "4. Start drivelens-api", "5. Give the server an https address")
- **D-4 Opt-in, scoped auto-updates.** Watchtower is commented out and, when enabled, only touches containers with the DriveLens label, leaving TeslaMate, its database and Grafana alone. (doc: docs/install.md "8. Updates")
- **D-5 Protected `main`, rebase merges, DCO.** Every change, maintainer releases included, lands through a PR with the `api`, `app` and `dco` checks; rebase merging keeps each commit and its `Signed-off-by`. (comment: scripts/pr-lib.sh:3-6; doc: CONTRIBUTING.md "Pull requests"; doc: docs/DEVELOPMENT.md "Releases (maintainer)")
- **D-6 Server first, then app.** A release waits until the image is built and the maintainer's server reports the new version before tagging and publishing, so the published app never needs a server that does not exist yet. (comment: scripts/release.sh:3-11) (confirmed)
- **D-7 Web first, native paused.** Since v0.15.0 the web app is the primary target; native workflows are manual-only. (comment: .github/workflows/windows.yml:4-6; comment: scripts/release.conf:5-8; doc: CONTRIBUTING.md "3. App")
- **D-8 CI without secrets.** Pull-request CI uses no secrets and a read-only token so it can run for forks. (comment: .github/workflows/ci.yml:3) Deploy steps skip themselves when secrets are absent. (comment: .github/workflows/web.yml:4-5)
- **D-9 License gate.** All Rust dependency licenses must be AGPL-compatible (CI-enforced), and the image ships the license texts. (comment: api/deny.toml:1; doc: CHANGELOG.md v1.1.2)
- **D-10 Release notes from `CHANGELOG.md`.** PR bodies and release notes are cut from the version's section of the changelog. (comment: scripts/release.sh:5, 15; src: scripts/release.sh:51, 117)
- **D-11 Pinned actions.** Every third-party action is pinned to a commit SHA with the version in a comment. Rationale: (confirmed, design) supply-chain safety. (src: .github/workflows/ci.yml:16, 18-19, 23)
- **D-12 Manual majors for security-relevant crates.** `sqlx` 0.9 needs a review of about 33 dynamic queries; `getrandom` generates device tokens and pairing codes, so its API change is reviewed by hand. (comment: .github/dependabot.yml:16-23)
- **D-13 Preview before production.** UI changes are checked on `https://preview.drivelens-app.pages.dev` (Pages `preview` branch, same project) before merge/release; production Pages `main` is only updated on release tags (or explicit `target=production`). The preview origin is documented for the maintainer's `DRIVELENS_CORS_ORIGINS` and is not added to the API default CORS list. (doc: AGENTS.md §8; doc: docs/DEVELOPMENT.md "Preview environment"; confirmed: owner decision)

## 5. Constraints

- Image platforms: `linux/amd64` and `linux/arm64` only. (src: .github/workflows/docker.yml:43; doc: docs/install.md "Requirements")
- Toolchains: Rust stable 1.85+, Node.js 22 in CI (20+ locally), PostgreSQL 14+ and Python 3 for fixtures. (src: api/Cargo.toml:8; src: .github/workflows/ci.yml:33; doc: CONTRIBUTING.md "Running DriveLens locally")
- Versions that must match for a release: `app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`; `api/Cargo.toml` is versioned separately. (src: scripts/release.sh:33-40; doc: docs/DEVELOPMENT.md "Releases (maintainer)")
- Wait limits in scripts: PR checks 60 min, Docker run discovery 10 min then 60 min completion, server version 30 min. (src: scripts/pr-lib.sh:43-53; src: scripts/release.sh:58-83, 96-101)
- Secrets and signing material never enter the repository (`.env*`, `*.p12`, `*.jks`, `*.keystore`, `keystore.properties`, `*.pem`, `*.key`, `scripts/.release.local` are ignored). (src: .gitignore)
- Fixtures must only be loaded into a throwaway database, never into a real TeslaMate database. (doc: CONTRIBUTING.md "1. Database with synthetic sample data")
- New source files start with an `SPDX-License-Identifier: AGPL-3.0-or-later` comment. (doc: docs/DEVELOPMENT.md "Checks before you commit")

## 6. Non-goals

- Pushing updates to users' servers: users pull the image themselves or enable Watchtower. (doc: docs/install.md "8. Updates")
- Publishing native installers while packaging is paused. (src: scripts/release.conf:9)
- Attaching a web-app zip to releases; the web app is only offered at the official URL. (comment: scripts/release.sh:12; doc: CHANGELOG.md v0.16.0)
- Supporting self-hosted web app deployments (the LAN appendix and the auth-proxy subsection are unofficial / untested). (doc: README.md "Quick start (server)"; doc: docs/install.md "Appendix: LAN-only use", "Behind an auth proxy")
- Running database-backed tests or `cargo clippy` in CI; both are left to contributors. Confirmed (current scope): CI has no database and stays fast; contributors run them locally. (src: .github/workflows/ci.yml:21; doc: CONTRIBUTING.md "Pull request checklist")

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `release.sh` expects Watchtower to pull `:latest` "within ~5 min" and waits at most 30 minutes for `/health` to report the new version. (comment: scripts/release.sh:9, 95; src: scripts/release.sh:96-101) | The shipped Watchtower service polls every 21600 s (6 h) (deploy/docker-compose.drivelens.yml:54; docs/install.md "8. Updates"). A server set up from the template would usually make the release stop with exit 2. Possible: the maintainer's own server may use a shorter interval. | The wait matches the maintainer's actual update mechanism, or the template/doc and script agree. **Review:** not a bug. `release.sh` polls only the maintainer's own server (`scripts/.release.local`), which updates within the window (releases with API changes, e.g. v1.2.0 / API 0.14.0, were tagged through it); the template's 6 h Watchtower interval is for users. Optional: reword the "~5 min" comment. |
| CB-2 | `api/drivelens-api.service` exists but no document mentions it; it has `After=docker.service` although it runs the native binary, and no build or install path produces `/usr/local/bin/drivelens-api` outside the image. (src: api/drivelens-api.service:3, 7-8) | Looks like a leftover from a pre-Docker deployment. Possible. | Either documented as an unofficial path or removed. **[OWNER DECISION NEEDED]** Keep `api/drivelens-api.service` as a documented unofficial path, or delete it? Recommendation: delete it (Docker/GHCR is the only supported deployment). |
| CB-3 | The former Chinese-only development guide described `main.rs` as containing "路由、鉴权、迁移" (routes, auth, migration). (doc: docs/DEVELOPMENT.md "Repository layout"; fixed text now lists `auth.rs`) | Authentication moved to `api/src/auth.rs` (API 0.14.0). Documentation drift. Likely. | The directory overview lists `auth.rs`. **Review:** real issue, verified at 9b1c39c. **Fixed in docs (2026-10-26):** the overview lists `auth.rs` (auth, device tokens), and the database section names every migration hook. |
| CB-4 | The bug-report form's placeholders show app `v0.15.1` and server `0.11.0`. (src: .github/ISSUE_TEMPLATE/bug_report.yml:33-34, 42) | Outdated examples (current app 1.2.2, server 0.14.0). Cosmetic. Certain. | Placeholders without a specific old version. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic. |
| CB-5 | The Windows workflow's release body is Chinese-only and describes Android assets. (src: .github/workflows/windows.yml:49) | Releases created by `release.sh` use the multilingual CHANGELOG section; this text only appears when native builds run. Possible leftover. | Release notes come from CHANGELOG in both paths. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Dormant while native builds are paused. |
