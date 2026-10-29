# Contributing to DriveLens

Thanks for helping! DriveLens is maintained by one person, so a little coordination up front saves everyone time.

## Before you start

- **New features or larger changes:** please [open an issue](https://github.com/zzflsxygod/drivelens/issues) first and describe what you want to do. Not every feature fits DriveLens, and it is better to agree on the approach before you write code.
- **Small fixes** (bugs, typos, translations, docs): a pull request without an issue is fine.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).
- **AI coding agents:** follow [AGENTS.md](AGENTS.md) (specs workflow, hard rules, build and test commands).

## Ground rules

- **Never modify TeslaMate's tables.** drivelens-api only reads them. Anything DriveLens stores goes into the `drivelens` schema.
- **Schema changes are applied by the API itself.** On every start, drivelens-api upgrades its `drivelens` tables (`migrate()` in `api/src/main.rs` and each module's `try_migrate` / `try_create_tables`). New tables or columns go there. The DDL must be idempotent (check that the object exists first), non-fatal (on failure log a warning and turn off only that feature) and limited to the `drivelens` schema. `deploy/setup.sql` is a one-time manual step that users run as the TeslaMate admin; it only sets up the `drivelens_ro` role, grants and the schema, so change it only for privileges.
- **Any change that needs DDL** (a new table, column or index, or a `setup.sql` change) must list the exact SQL in the pull request and needs the maintainer's approval before it is merged.
- **Privacy:** the app must never send the server URL or the API token anywhere except the user's own server, and must not add telemetry, analytics or third-party trackers.
- **UI:** portrait layout, no new bottom tabs, follow the existing style in `app/src/style.css`. All user-facing text goes through `app/src/locales/{en,zh,ja}.ts` (`npm run check:i18n` checks that every key exists in all three).
- Keep pull requests focused: one topic per pull request.

## Developer Certificate of Origin (DCO)

DriveLens is licensed under the [GNU AGPL-3.0-or-later](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.

Every commit must carry a `Signed-off-by` line that certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/), i.e. that you wrote the change or otherwise have the right to submit it under this license:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. To fix the last commit: `git commit --amend -s`. For several commits: `git rebase --signoff main`.

## Pull requests

Commit messages and pull request titles/bodies are English. Issues follow the reporter's language (reply in that language); issues you open yourself default to English.

`main` is protected and only changes through pull requests — for everyone, maintainers included. A pull request can be merged when the `api`, `app` and `dco` checks pass and the branch is up to date with `main`. Pull requests are merged with **rebase and merge**, so keep each commit meaningful (and signed off); fixup commits are best squashed before you ask for a merge. Maintainers can use `scripts/pr.sh <branch>` to push, open, wait for checks and merge in one step.

## Running DriveLens locally

Longer notes (architecture, API overview, release and preview): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) (English).

Requirements: Rust stable (1.85+), Node.js 20+, PostgreSQL 14+ and Python 3 (for the sample data).

### 1. Database with synthetic sample data

`testdata/` contains a TeslaMate-compatible subset of the schema and generated (fictional) data around Tokyo. **Only use it on a throwaway database, never on a real TeslaMate database.**

```bash
sudo -u postgres psql -c "CREATE USER teslamate PASSWORD 'secret'" -c "CREATE DATABASE teslamate OWNER teslamate"
cd testdata
python3 gen_sample.py            # writes sample_data.sql
PGPASSWORD=secret psql -h localhost -U teslamate teslamate -f schema.sql -f sample_data.sql
# optional, for load testing (~3M positions): -f bigdata.sql
```

### 2. API (`api/`)

```bash
cd api
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate \
API_TOKEN=dev-token-1234567890 \
DRIVELENS_CORS_ORIGINS=http://localhost:1420,http://localhost:4174 \
cargo run
# listens on 127.0.0.1:8080 (BIND_ADDR to change); GET /health needs no token
cargo test                       # unit tests
```

drivelens-api creates its own `drivelens` schema on start if it is missing. Other variables (`DRIVELENS_VAPID_PRIVATE_KEY`, `DRIVELENS_VAPID_SUBJECT`, `RUST_LOG`) are described in [docs/install.md](docs/install.md).

### 3. App (`app/`)

```bash
cd app
npm ci
npm run dev                      # http://localhost:1420
```

On the setup screen enter `http://127.0.0.1:8080` and the token `dev-token-1234567890` (they are stored only in your browser's localStorage). You can also try **Demo mode**, which needs no server at all.

Other commands:

```bash
npm run build                    # i18n check + type check + build
npm run build:web                # PWA build (manifest, service worker) → dist-web/
npm run preview:web              # preview the PWA build at http://localhost:4174
```

The Tauri shell (`app/src-tauri/`) for the Windows / Android apps is kept in the repo, but the native builds are currently paused; the web app is the primary target.

## Pull request checklist

- [ ] `cargo test` passes in `api/` (and `cargo clippy` has no new warnings)
- [ ] `npm run build` passes in `app/`
- [ ] Tested in the browser at phone and desktop sizes, and in demo mode if the UI changed
- [ ] New strings added to all three locale files
- [ ] Every commit is signed off (`git commit -s`)
