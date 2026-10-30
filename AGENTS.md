# AGENTS.md — rules for AI coding agents

This file is for AI coding agents (Codex, Cursor, Claude Code, Copilot, …) and the people who run them.
It applies to every contribution. Human contributors: the same rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## 1. Project overview

DriveLens is a companion app for [TeslaMate](https://github.com/teslamate-org/teslamate). A small API on the
user's own server (**drivelens-api**) reads the TeslaMate PostgreSQL database **read-only**, and the DriveLens
web app shows the car, drives, charging, journeys, monthly reports and battery health. DriveLens stores its own
data only in the `drivelens` schema of the same database.

| Path | Contents |
|------|----------|
| `api/` | drivelens-api: Rust, axum 0.8, sqlx 0.8 (PostgreSQL). Routes, auth, migration and tests mostly in `api/src/main.rs`; modules `auth.rs`, `summary.rs`, `report.rs`, `insights.rs`, `journey.rs`, `phase2.rs`, `push.rs`. `Dockerfile`, `deny.toml` |
| `app/` | Web app / PWA: Vite + TypeScript + MapLibre GL. `src/locales/{en,ja,zh}.ts` texts, `src/demo/` demo mode, `src-tauri/` Tauri 2 shell (Windows/Android, builds paused) |
| `deploy/` | `setup.sql` (database role, grants, `drivelens` schema), `docker-compose.drivelens.yml`; `drivelens-*.sql` are legacy upgrade scripts for old installs |
| `docs/` | Install guide ([en](docs/install.md) · [zh](docs/install.zh.md) · [ja](docs/install.ja.md)), [DEVELOPMENT.md](docs/DEVELOPMENT.md) (English), screenshots |
| `specs/` | Behavior specs per module — **read these first** (section 2) |
| `scripts/` | `pr.sh`, `release.sh` (maintainer only), `third-party-licenses.sh` |
| `testdata/` | TeslaMate-compatible schema subset and fictional sample data, for throwaway databases only |

Start with [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## 2. Specs workflow (the main rule)

`specs/` describes what each module does. Treat it as the contract.

1. **Before changing a module**, read [specs/OVERVIEW.md](specs/OVERVIEW.md) (module table, dependencies,
   cross-cutting rules in section 5, cross-module issues in section 6) and the module's `specs/<module>/SPEC.md`.
   Check the dependency table for other modules your change affects.
2. **Keep behavior consistent with the SHALL statements** (section 3 of each spec). Do not change specified
   behavior as a side effect.
3. **When behavior changes, update the spec in the same PR**: edit or add the numbered statements, and their
   evidence (`src:` / `test:`). When you fix a row in section 7 ("Current behavior vs. intended behavior"),
   mark it fixed with the version, e.g. `**Fixed in v1.2.3 / API 0.14.1:** …`, and update the matching
   `X-n` row in OVERVIEW.md section 6.
4. **Unclear or not covered? Do not guess.** Ask the maintainer in the issue or PR, and record the answer in
   the spec (as a statement, or under Key design decisions / Constraints / Non-goals).

Markers used in the specs:

- **Statement IDs** — module prefix + number, e.g. `AUTH-012`, `JRN-041` (prefixes in OVERVIEW.md section 3).
- **Evidence** — `src:` code location, `test:` a test asserting the statement, `doc:` README/CHANGELOG/docs,
  `comment:` a code comment stating intent. Line numbers refer to the commit named in the spec header.
- **Confirmed from code** / **Confirmed (owner decision)** / **Confirmed (current scope / design)** — how a
  former guess was verified. Owner decisions are rules; do not change them without the maintainer.
- **[OWNER DECISION NEEDED]** — open question. Do not implement either side; leave it to the maintainer.
- **[TO CONFIRM]** — a statement based on inference. Use it for new statements you could not verify.
- **CB-n** — rows in section 7: suspected bugs, inconsistencies and leftovers, each with a **Review** verdict.
- **X-n** — cross-module issues in OVERVIEW.md section 6, pointing to CB rows.

## 3. Hard rules

- **TeslaMate data is read-only.** Never create, alter, delete or write to TeslaMate tables or the `public`
  schema. Anything DriveLens stores lives in the `drivelens` schema (specs/api-storage STOR-007, STOR-023, STOR-050).
- **Schema changes.** drivelens-api migrates its own `drivelens` schema on startup (`migrate()` in
  `api/src/main.rs` plus each module's `try_migrate` / `try_create_tables`). A new table or column goes there,
  and must be:
  - idempotent (check that the object exists before issuing DDL; running twice changes nothing),
  - non-fatal (on failure log a warning, turn off only that feature, and answer `503` with a setup hint),
  - limited to the `drivelens` schema.

  `deploy/setup.sql` is run once by hand by the user as the TeslaMate admin; it only creates the
  `drivelens_ro` role, grants and the schema. Change it only for privileges, and say so in the PR, because
  every existing user has to re-run it. See specs/api-storage sections 3.1–3.2.
- **Any change that needs DDL or a migration** must list the exact SQL in the PR description and must not be
  merged without the maintainer's explicit approval.
- **API level contract** (specs/OVERVIEW.md 5.1). `/health` reports `version` (`api/Cargo.toml`) and
  `api_level` (`API_LEVEL` in `api/src/main.rs`). Bump `API_LEVEL` only when the app must detect a new
  endpoint or behavior. Then add the feature to `FEATURE_LEVEL` and the release to `LEVEL_VERSION` in
  `app/src/version.ts`, and gate the UI with `lacks(feature)` / `featureText(feature)`. Bug fixes and
  compatible changes keep the level. Older apps must keep working against newer servers, and vice versa
  (features degrade, nothing crashes).
- **Degrade instead of fail** (OVERVIEW.md 5.2): a missing optional table turns its feature off; the rest keeps working.

## 4. UI rules

- **No new bottom tabs** (Home, Drives, Charges, Settings). **Portrait only.**
- **"Telemetry" style** (`app/src/style.css`): flat solid surfaces, 1px hairlines (`--line*`), cyan accent
  (`--accent`), numbers in the monospace stack with tabular numerals, light and dark themes that follow the
  system (overridable in Settings). Use the existing tokens and components; no new colors or fonts ad hoc.
- **Every user-facing string** goes through `app/src/locales/en.ts`, `ja.ts` and `zh.ts`, all three updated in
  the same change. `npm run check:i18n` (part of every build) fails on missing keys.
- **Demo mode must keep working** for every feature. Demo mode answers API calls in the browser
  (`app/src/demo/server.ts`, data from `gen.ts`), keeps edits in `localStorage` (`drivelens-demo-state`) and
  never touches the user's real server settings. When you add or change an endpoint, update the mock to match.
  Demo data must stay obviously fictional (specs/app-demo).
- Read-only devices: hide editing entry points with `canWrite()`.

## 5. Security and privacy

- Never commit secrets, tokens, keys, real server URLs or domains, personal data, real locations, real
  addresses, VINs or real car names. Use placeholders (`https://drivelens.example.com`, `dev-token-1234567890`).
- Sample and test data must be obviously fictional (`testdata/`, `app/src/demo/`).
- The server URL and token are sent only to the user's own server, only in the `Authorization` header —
  never in URLs or query strings, logs, telemetry or third-party requests. No analytics or trackers
  (OVERVIEW.md 5.4; `app/src/urlguard.ts` strips `api`, `token`, `key` parameters).
- The service worker must not intercept or cache API requests or map tiles.
- Security problems: report privately, see [SECURITY.md](SECURITY.md).

## 6. Build and test

API (`api/`, Rust stable 1.85+):

```bash
cd api
cargo test --locked          # what CI runs; database tests are skipped without the variable below
cargo clippy                 # no new warnings
# Database tests (migration, device auth, journeys) need a THROWAWAY PostgreSQL 14+ loaded with
# testdata/schema.sql and testdata/sample_data.sql (see CONTRIBUTING.md "Running DriveLens locally"):
DRIVELENS_TEST_DATABASE_URL=postgres://user:pass@localhost/throwaway cargo test --locked
```

App (`app/`, Node.js 20+; CI uses 22):

```bash
cd app
npm ci
npm run build                # i18n check + tsc (type check, noEmit) + vite build
npm run build:web            # PWA build → dist-web/
npm run preview:web          # http://localhost:4174
npm run dev                  # http://localhost:1420; use demo mode or a local API
```

There is no frontend unit-test framework: test UI changes in a browser at phone and desktop sizes, and in demo mode.

CI (`.github/workflows/ci.yml`) runs on every pull request. Required checks:
- `api`: `cargo test --locked` and the cargo-deny license check.
- `app`: `npm ci`, `npm run build`, `npm run build:web`.
- `dco`: every commit has `Signed-off-by`.

Native builds are paused: `NATIVE_BUILDS=0` in `scripts/release.conf` (releases don't wait for Windows/Android
builds), and the tag triggers in `windows.yml` / `android.yml` are commented out. The web app is the primary target.

## 7. Git, language and pull requests

- `main` is protected: changes land only through pull requests, merged with **rebase and merge**, after the
  `api`, `app` and `dco` checks pass. Agents open PRs; they do not merge them.
- **DCO:** every commit needs `Signed-off-by` (`git commit -s`). Keep each commit meaningful (rebase-merge keeps them).
- Commit subjects follow the log: `api: …`, `app: …`, `docs: …`, `deploy: …`, `ci: …`, `scripts: …`, or
  `fix(<area>): …` / `docs(specs): …`.
- **Language on GitHub:** commit messages and pull request titles/bodies are **English**. Issues follow the
  reporter's language (reply in the language they used); issues opened by the maintainer or by agents default
  to English.
- **Docs languages:** user-facing docs (install guides, README) ship in English / Chinese / Japanese
  (`name.md` · `name.zh.md` · `name.ja.md`, with language-switch links). Keep all three in the same change when
  you edit one. The contributor/developer guide ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)), `AGENTS.md` and
  `specs/` are **English only**.
- Keep PRs focused, one topic each. Open an issue before a new feature.
- **CHANGELOG.md:** add user-visible changes in the existing format (`## vX.Y.Z — YYYY-MM-DD`, bullets, a
  `**Server X.Y.Z**` sub-list for API changes, "No server update needed." when only the app changed).
- **Releases are done by the maintainer** (`scripts/release.sh`). Agents must not bump release versions, create
  tags or publish releases unless the maintainer asks. `scripts/pr.sh` merges automatically and is for maintainers.

## 8. Preview web app (before merge / release)

The official web app is only updated on release. **Every PR that is not docs-only** must be deployed to
the **preview** Pages branch and confirmed by the maintainer before merge (not only UI PRs). Docs-only
PRs skip preview. Before asking the maintainer to release, also deploy preview when the release
includes web changes.

```bash
gh workflow run web.yml --ref <branch> -f target=preview
# alias: https://preview.drivelens-app.pages.dev
```

- Same Cloudflare Pages project as production (`drivelens-app`); preview uses `--branch preview`.
- Preview builds set `VITE_DRIVELENS_CHANNEL=preview` (visible "Preview" strip + distinct PWA name).
- Production deploy is unchanged: release tags (and manual `target=production`) deploy to Pages `main`.
  A preview run must never write to production.
- Preview shares the production API (CORS allows the preview origin). **API-only changes cannot be
  exercised end-to-end on preview until a release** updates the server; verify those with demo mode or
  other test data and say in the PR what still needs a post-release check.
- The maintainer's server must list both origins in `DRIVELENS_CORS_ORIGINS` (official +
  `https://preview.drivelens-app.pages.dev`), pass that variable through the compose `environment:` block
  (uncomment `- DRIVELENS_CORS_ORIGINS=${DRIVELENS_CORS_ORIGINS}`), and recreate the container. A value in
  `.env` alone is not enough. Do not put the preview origin in the API's default CORS list.
- Preview may be locked with Cloudflare Access (Pages project → preview deployments); the API itself is
  not behind that Access policy.
- Agents still do not merge or release unless the maintainer asks.

## 9. License

DriveLens is [AGPL-3.0-or-later](LICENSE). Contributions are under the same license. New source files carry
`SPDX-License-Identifier: AGPL-3.0-or-later`. New dependencies must have AGPL-compatible licenses (`api/deny.toml`).
