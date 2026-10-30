# api-core — drivelens-api process, HTTP surface and cross-cutting rules

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `api/src/main.rs` (bootstrap, `router`, CORS, `/health`, `/api/health`, `ApiError`, `bad`, `paged`, `API_LEVEL`, `log_features`, test modules `cors_tests` and `auth_tests`), `api/Cargo.toml`, `README.md`, `SECURITY.md`, `docs/install.md`, `docs/DEVELOPMENT.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.
> In this document, "the system" means the drivelens-api process as a whole: its startup sequence, its route table, and the HTTP behavior that applies to every route (CORS, error envelope, health and version reporting).
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

drivelens-api is a small HTTP server that runs next to a user's TeslaMate installation. It reads the TeslaMate PostgreSQL database and serves JSON to the DriveLens web app, which calls it directly from the browser. api-core owns the parts every endpoint shares: how the process is configured and started, which routes exist and which are public, how cross-origin browser access is allowed, how errors are reported, and how clients learn the server version and feature level (`API_LEVEL`). The goal is a server that self-hosters can start with two secrets and that clients can probe cheaply.

## 2. Responsibility boundaries

### 2.1 In scope
- Reading and validating process configuration from environment variables (`DATABASE_URL`, `API_TOKEN`, `BIND_ADDR`, `RUST_LOG`, `DRIVELENS_CORS_ORIGINS` / `CORS_ORIGINS`) and refusing to start on invalid values.
- The startup sequence: database pool, schema migration call, auth state, feature log, background tasks, listener.
- The complete route table and which routes pass the authentication middleware.
- The unauthenticated `/health` endpoint and the authenticated `/api/health` endpoint.
- `API_LEVEL` and the version reported to clients.
- The CORS policy.
- The JSON error envelope and the generic 500 response.
- The `paged()` list envelope (`{items, next_cursor}` vs. plain array) used by list endpoints.
- The startup feature log line (the probes that feed it are owned by `api-storage`).

### 2.2 Out of scope
- Token checking, device tokens, pairing, scopes, failure limits, client-IP keying, `DRIVELENS_OWNER_KEY_MODE` semantics, `DRIVELENS_TRUST_PROXY_HEADERS` → `api-auth`.
- Creating and upgrading the `drivelens` schema, per-feature availability probes, degrade-instead-of-fail behavior → `api-storage`.
- The behavior of each data endpoint: cars, drives, charges, paths, months, aliases, costs, cursor format → `api-records`; home data → `api-summary`; report, trends, footprint, battery → `api-insights`; journeys, cover, weather, speed bands → `api-journeys`; push endpoints, VAPID, notifier loop, `DRIVELENS_VAPID_*`, `DRIVELENS_PUSH_HOSTS` → `api-push`.
- HTTPS termination, container image, compose file, release process → `ops-delivery`.
- Feature gating in the app based on `api_level` → `app-connection`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-storage` — `migrate()` at startup; feature probes (`costs_ok`, `journey::tables_ok`, `journey::dismiss_ok`, `phase2::cover_ok`, `phase2::weather_ok`, `push::push_ok`) for `/api/health` and the startup log.
  - `api-auth` — `auth::middleware` on the authenticated routes, `auth::AuthState::init`, `auth::OwnerKeyMode::from_env`, `auth::spawn` (device index reload).
  - `api-push` — `push::push_client()` (HTTP client stored in `AppState`), `push::spawn` (notifier loop).
  - `api-records`, `api-summary`, `api-insights`, `api-journeys`, `api-push`, `api-auth` — handler functions mounted in the route table.
  - `ext:PostgreSQL` (TeslaMate database) via `sqlx` with rustls TLS support.
  - `ext:tokio`, `ext:axum 0.8`, `ext:tower-http` (CORS, tracing).
- **Used by:**
  - `app-connection` — `GET /health` (version, `api_level`) and `GET /api/health`.
  - `ops-delivery` — the binary and its environment variables (Docker image, compose file); `scripts/release.sh` polls `/health` for the version.
  - Every `api-*` module — `AppState`, `ApiError`, `bad()`, `paged()`, `TS`, `LOC_CURRENCY`, `charge_select`, `drive_select` are defined in `main.rs` and shared.
- **Provided interface:**

  Environment variables read directly by this module:

  | Variable | Required | Effect |
  |---|---|---|
  | `DATABASE_URL` | yes | PostgreSQL connection string |
  | `API_TOKEN` | yes | Owner key (passed to `api-auth`); length and strength checked here |
  | `BIND_ADDR` | no | Listen address; default `127.0.0.1:8080` |
  | `RUST_LOG` | no | Log filter; default `info,tower_http=info` |
  | `DRIVELENS_CORS_ORIGINS` | no | Allowed browser origins (comma-separated, `*` = any) |
  | `CORS_ORIGINS` | no | Older name, used only when `DRIVELENS_CORS_ORIGINS` is unset or blank |

  Route table (`api/src/main.rs:873-924`). "Auth" = passes `auth::middleware`.

  | Method | Path | Auth | Owner module |
  |---|---|---|---|
  | GET | `/health` | no | api-core |
  | GET | `/api/health` | yes | api-core |
  | GET | `/api/cars` | yes | api-records |
  | GET | `/api/cars/{id}/summary`, `/status`, `/last-activity`, `/stats` | yes | api-summary |
  | GET | `/api/cars/{id}/report`, `/trends`, `/footprint`, `/battery` | yes | api-insights |
  | GET | `/api/cars/{id}/months` | yes | api-records |
  | GET | `/api/charges`, `/api/charges/{id}` | yes | api-records |
  | PUT, DELETE | `/api/charges/{id}/cost` | yes | api-records |
  | GET | `/api/drives`, `/api/drives/{id}`, `/api/drives/{id}/path` | yes | api-records |
  | GET, PUT, DELETE | `/api/addresses/aliases` (GET), `/api/addresses/{id}/alias` (PUT, DELETE) | yes | api-records |
  | GET, POST | `/api/journeys` | yes | api-journeys |
  | GET | `/api/journeys/suggestions` | yes | api-journeys |
  | POST | `/api/journeys/suggestions/dismiss` | yes | api-journeys |
  | DELETE | `/api/journeys/suggestions/dismissed` | yes | api-journeys |
  | GET, PATCH, DELETE | `/api/journeys/{id}` | yes | api-journeys |
  | PUT | `/api/journeys/{id}/drives` | yes | api-journeys |
  | GET | `/api/journeys/{id}/path`, `/weather`, `/speed-bands` | yes | api-journeys |
  | GET, PUT, DELETE | `/api/journeys/{id}/cover` | yes | api-journeys |
  | GET | `/api/push/key` | yes | api-push |
  | POST | `/api/push/subscription`, `/api/push/subscription/status`, `/api/push/unsubscribe`, `/api/push/test` | yes | api-push |
  | GET | `/api/auth/me` | yes | api-auth |
  | GET, POST, DELETE | `/api/auth/devices` | yes | api-auth |
  | PATCH, DELETE | `/api/auth/devices/current`, `/api/auth/devices/{id}` | yes | api-auth |
  | POST | `/api/auth/pairings` | yes | api-auth |
  | POST | `/api/auth/pair` | **no** | api-auth |

  Shared Rust items: `AppState` (`main.rs:37-53`), `ApiError` / `ApiResult` (`main.rs:86-96`), `bad()` (`main.rs:486-488`), `paged()` (`main.rs:307-311`), `TS` (`main.rs:121`), `API_LEVEL` (`main.rs:303`).

## 3. External behavior

### 3.1 Configuration and startup
- **CORE-001** When the process starts and `DATABASE_URL` is not set, the system SHALL exit with the error `DATABASE_URL is required` without opening a listener. (src: api/src/main.rs:930)
- **CORE-002** When the process starts and `API_TOKEN` is not set, the system SHALL exit with the error `API_TOKEN is required`. (src: api/src/main.rs:931)
- **CORE-003** When `API_TOKEN` is shorter than 16 bytes, the system SHALL exit with an error that starts with `API_TOKEN must be at least 16 characters`. (src: api/src/main.rs:932; doc: docs/install.md "2. Create a password and a token"; doc: docs/install.md "Troubleshooting")
- **CORE-004** When `API_TOKEN` is at least 16 bytes but shorter than 32 bytes, or contains fewer than 10 distinct bytes, or uses fewer than 2 of the classes {lowercase ASCII, uppercase ASCII, ASCII digit, other}, the system SHALL log a warning that starts with `API_TOKEN looks weak` and continue starting. (src: api/src/main.rs:933-935; doc: docs/install.md "2. Create a password and a token")
- **CORE-005** When `BIND_ADDR` is not set, the system SHALL listen on `127.0.0.1:8080`; otherwise it SHALL listen on the value of `BIND_ADDR`. (src: api/src/main.rs:936, 950; doc: CONTRIBUTING.md "2. API")
- **CORE-006** When `RUST_LOG` is not set, the system SHALL use the log filter `info,tower_http=info`. (src: api/src/main.rs:927-929)
- **CORE-007** When `DRIVELENS_OWNER_KEY_MODE` holds a value other than empty, `full`, `pair-only` or `pair_only` (case-insensitive, trimmed), the system SHALL exit with an error that names the allowed values. The meaning of the mode is specified in `api-auth`. (src: api/src/main.rs:937; src: api/src/auth.rs:252-259)
- **CORE-008** When the database cannot be reached at startup, the system SHALL exit with an error; the pool connects eagerly with at most 5 connections. (src: api/src/main.rs:939)
- **CORE-009** When the database connection succeeds, the system SHALL run these steps in this order: schema migration (`api-storage`), auth state initialization (`api-auth`), the startup feature log, start of the push notifier task (`api-push`), start of the device-index reload task (`api-auth`), bind of the listener, and serving. (src: api/src/main.rs:939-953)
- **CORE-010** When the listener is bound, the system SHALL log `listening on <BIND_ADDR>`. (src: api/src/main.rs:950-951; doc: docs/install.md "4. Start drivelens-api")
- **CORE-011** When serving requests, the system SHALL attach the TCP peer address of each connection to the request so that `api-auth` can key its failure limits by client address. (src: api/src/main.rs:952-953; comment: api/src/main.rs:952)

### 3.2 Startup feature log
- **CORE-020** When startup reaches the feature log and every feature is available, the system SHALL log at INFO level `all features enabled (API level 16)`. (src: api/src/main.rs:608-609; doc: docs/install.md "4. Start drivelens-api")
- **CORE-021** When startup reaches the feature log and one or more features are unavailable, the system SHALL log at WARN level one line `disabled features: <comma-separated names> — <setup hint>`, where the names come from the set `teslamate read`, `place aliases`, `manual costs`, `journeys`, `suggestion dismissal`, `journey cover`, `weather cache`, `web push`, `device auth`. (src: api/src/main.rs:603-610; doc: docs/install.md "Troubleshooting")
- **CORE-022** When the API role cannot read `public.drives`, the system SHALL additionally log at ERROR level `cannot read TeslaMate tables (public.drives); <setup hint>` and continue starting. (src: api/src/main.rs:598-600; doc: docs/install.md "Troubleshooting")
- **CORE-023** When a feature probe fails with an error during the feature log, the system SHALL treat that feature as unavailable instead of aborting startup. (src: api/src/main.rs:598-607)

### 3.3 Routing and authentication boundary
- **CORE-030** When a request matches a route of the table in 2.3, the system SHALL dispatch it to the owning module's handler; all API routes are nested under `/api`, and `/health` is mounted at the root. (src: api/src/main.rs:873-924)
- **CORE-031** When any `/api/*` route other than `POST /api/auth/pair` is requested, the system SHALL pass the request through `auth::middleware` before the handler runs (see `api-auth`); a request without credentials SHALL receive 401. (src: api/src/main.rs:915-916; comment: api/src/main.rs:871-872; test: api/src/main.rs auth_tests::only_pair_is_public)
- **CORE-032** When `POST /api/auth/pair` is requested without an `Authorization` header, the system SHALL run its handler instead of answering 401. (src: api/src/main.rs:916; test: api/src/main.rs auth_tests::only_pair_is_public)
- **CORE-033** When a request path matches no route, the system SHALL answer 404 without running the auth middleware (`route_layer` only wraps matched routes). Confirmed from code: axum's `Router::route_layer` applies only to routes that matched, so an unmatched path falls through to the default 404. (src: api/src/main.rs:915; comment: api/src/main.rs:871-872)

### 3.4 Health and version
- **CORE-040** When `GET /health` is requested, with or without credentials, the system SHALL answer 200 with exactly `{"status":"ok","version":"<crate version>","api_level":16}` and SHALL NOT query the database. (src: api/src/main.rs:348-350, 919; comment: api/src/main.rs:305; test: api/src/main.rs auth_tests::only_pair_is_public; doc: docs/install.md "4. Start drivelens-api")
- **CORE-041** When `GET /api/health` is requested with valid credentials and `SELECT 1` succeeds, the system SHALL answer 200 with `status` `"ok"`, `version`, `api_level`, `database: true` and the booleans `manual_costs`, `journeys`, `suggestion_dismissal`, `journey_cover`, `weather`, `web_push` taken from the `api-storage` probes. (src: api/src/main.rs:352-362)
- **CORE-042** When `GET /api/health` is requested with valid credentials and `SELECT 1` fails, the system SHALL answer 503 with `status` `"db_error"` and `database: false`. (src: api/src/main.rs:354-356)
- **CORE-043** When a feature probe returns an error during `GET /api/health`, the system SHALL report that feature as `false` instead of failing the request. (src: api/src/main.rs:357-361)
- **CORE-044** When either health endpoint reports `version`, the value SHALL be the `version` of `api/Cargo.toml` (`0.15.0` at this commit), and `api_level` SHALL be the constant `API_LEVEL` (16 at this commit). (src: api/src/main.rs:303, 349; src: api/Cargo.toml:3; test: api/src/main.rs auth_tests::only_pair_is_public)

### 3.5 List envelope
- **CORE-050** When a list endpoint that uses `paged()` (`GET /api/drives`, `GET /api/charges`) is called with `paged=true`, the system SHALL answer `{"items": [...], "next_cursor": <string or null>}`; `next_cursor` SHALL be the cursor key of the last item when the number of items equals the effective limit, and `null` otherwise. The cursor key format is specified in `api-records`. (src: api/src/main.rs:307-321; doc: docs/DEVELOPMENT.md "API")
- **CORE-051** When such a list endpoint is called without `paged=true`, the system SHALL answer a plain JSON array of items. (src: api/src/main.rs:308; comment: api/src/main.rs:306)

### 3.6 Error envelope
- **CORE-060** When a handler fails with an unexpected error (for example a database error), the system SHALL answer 500 with the body `{"error":"internal error"}` and SHALL log the full error chain at ERROR level; the response SHALL NOT contain the error details. (src: api/src/main.rs:86-95)
- **CORE-061** When a handler rejects a request for a known reason, the system SHALL answer with a JSON body `{"error":"<message>"}` and a status that names the reason (for example 400, 404, 413, 503). (src: api/src/main.rs:486-488; src: api/src/journey.rs:65; src: api/src/phase2.rs:47; src: api/src/push.rs:343)
- **CORE-062** When an authentication or device-management response carries a machine-readable reason, the system SHALL add a `code` field next to `error` (for example `read_only`, `rate_limited`, `device_auth_unavailable`). (src: api/src/auth.rs:451-453; test: api/src/main.rs auth_tests::db_device_flow; doc: docs/DEVELOPMENT.md "API")

### 3.7 CORS
- **CORE-070** When neither `DRIVELENS_CORS_ORIGINS` nor `CORS_ORIGINS` is set to a non-blank value, the system SHALL allow exactly the origins `https://drivelens-app.oharuru.com`, `tauri://localhost`, `http://tauri.localhost` and `https://tauri.localhost`. (src: api/src/main.rs:623-640; test: api/src/main.rs cors_tests::default_is_official_web_plus_tauri; doc: docs/install.md "Environment variables")
- **CORE-071** When `DRIVELENS_CORS_ORIGINS` is set and not blank, the system SHALL use it; otherwise it SHALL use `CORS_ORIGINS`. (src: api/src/main.rs:643-644; doc: docs/install.md "Environment variables")
- **CORE-072** When the configured list contains an entry `*`, the system SHALL allow any origin. (src: api/src/main.rs:635, 652; test: api/src/main.rs cors_tests::star_means_any; doc: docs/install.md "Environment variables")
- **CORE-073** When the configured list is parsed, the system SHALL split it on commas, trim each entry, strip trailing `/`, skip empty entries, lower-case the entries, drop case-insensitive duplicates and always append the three Tauri origins. (src: api/src/main.rs:631-640; test: api/src/main.rs cors_tests::custom_list_keeps_tauri_and_dedups)
- **CORE-074** When a configured origin is not a valid header value, the system SHALL ignore it and log a warning `CORS: ignoring invalid origin …`. (src: api/src/main.rs:655-656)
- **CORE-075** When a CORS preflight arrives from an allowed origin, the system SHALL answer with `Access-Control-Allow-Origin` set to that origin, allow the methods GET, POST, PATCH, PUT, DELETE and OPTIONS, allow the request headers `authorization` and `content-type`, set a max-age of 600 seconds and allow Private Network Access. (src: api/src/main.rs:645-650; test: api/src/main.rs cors_tests::preflight_default_policy; comment: api/src/main.rs:649)
- **CORE-076** When a CORS preflight arrives from an origin that is not allowed, the system SHALL NOT send `Access-Control-Allow-Origin`. (test: api/src/main.rs cors_tests::preflight_default_policy)
- **CORE-077** When the CORS layer is built at startup, the system SHALL log either `CORS: any origin` or `CORS: allowed origins <list>`. (src: api/src/main.rs:651-655)
- **CORE-078** When any route is requested, including `/health`, the CORS policy SHALL apply. (src: api/src/main.rs:918-923)

### 3.8 Request tracing
- **CORE-080** When a request is handled, the system SHALL pass it through `tower_http::trace::TraceLayer::new_for_http()`. With the default filter `info,tower_http=info` (and `RUST_LOG=info` in the image), the per-request span, request and response events (DEBUG in tower-http's defaults) are not written, but a 5xx response or a failed request IS logged at ERROR by the default `on_failure` handler. Confirmed from code (tower-http 0.7 `DefaultOnFailure` = ERROR, `DefaultOnResponse` = DEBUG). (src: api/src/main.rs:922, 928)

## 4. Key design decisions

- **D-1 Two health endpoints.** `/health` is public, does not touch the database and returns only `status`, `version` and `api_level`. `/api/health` is authenticated and also checks the database and the optional features. Rationale: the public one is "cheap; also used as the container health/version probe" (comment: api/src/main.rs:305) and lets the app check version and reachability before it has credentials (doc: docs/install.md "6. Connect the web app"). Consequence: anyone who can reach the server learns its version and API level.
- **D-2 Integer `API_LEVEL` as the client contract.** The app gates features on one integer instead of parsing versions; the constant is bumped whenever endpoints are added or changed, and its history is kept in a comment (levels 3 to 16). (comment: api/src/main.rs:300-302; doc: docs/DEVELOPMENT.md "API") Consequence: older apps keep working against newer servers; newer apps hide features on older servers.
- **D-3 CORS restricts browsers, not access.** Authentication is a bearer token, not cookies, so CORS only decides which web pages may call the API from a browser. The default allows only the official web app plus the Tauri app origins; `*` is available. (comment: api/src/main.rs:627-630; doc: docs/install.md "Environment variables") The Tauri origins are always added so the paused native apps keep working with any custom list. (comment: api/src/main.rs:622-625; doc: deploy/docker-compose.drivelens.yml:20-22)
- **D-4 Private Network Access allowed.** Chrome's Private Network Access preflight is answered positively so the https web app can reach a server on a LAN or tailnet address. (comment: api/src/main.rs:649; doc: docs/install.md "Option B: Tailscale")
- **D-5 Generic 500.** Unexpected errors are logged in full and returned as `{"error":"internal error"}`. Rationale (confirmed, design): avoid exposing database or query details to clients; the full error stays in the server log. (src: api/src/main.rs:90-95)
- **D-6 One public route via `route_layer` + `merge`.** The auth middleware is attached with `route_layer` to the routes added before it; the pairing route is merged afterwards and stays public. A test enumerates every route to prove only `POST /api/auth/pair` is reachable without credentials. (comment: api/src/main.rs:871-872; test: api/src/main.rs auth_tests::only_pair_is_public)
- **D-7 SQL-side casting.** Numeric columns are cast to `float8`/`int4`/`int8` and timestamps to ISO-8601 text (`TS` = `YYYY-MM-DD"T"HH24:MI:SS"Z"`) inside SQL, "so the code is robust to TeslaMate's numeric & timestamp types". (comment: api/src/main.rs:14-15; src: api/src/main.rs:121)
- **D-8 Opt-in paging envelope.** `paged=true` returns `{items, next_cursor}`; without it the old plain array is returned so older apps keep working. (comment: api/src/main.rs:107, 306)
- **D-9 Token strength at startup.** Tokens under 16 characters stop the process; weak tokens only warn. (src: api/src/main.rs:932-935; doc: docs/install.md "2. Create a password and a token")
- **D-10 Peer address as rate-limit input.** The server is started with `ConnectInfo` so the TCP peer address is available to `api-auth`; proxy headers are only trusted on request (see `api-auth`). (comment: api/src/main.rs:952; doc: CHANGELOG.md v1.1.2 "Server 0.13.1")
- **D-11 Loopback by default.** The binary listens on `127.0.0.1:8080` unless `BIND_ADDR` is set; the Docker image sets `0.0.0.0:8080` and the compose file publishes the port on `127.0.0.1` only. Rationale: "Don't expose port 8080 to the internet; use one of the https options". (src: api/src/main.rs:936; src: api/Dockerfile:30; doc: docs/install.md "4. Start drivelens-api")
- **D-12 Small connection pool.** At most 5 database connections. Rationale (confirmed, design): keep the load on the shared TeslaMate database low; the API serves one owner's devices. (src: api/src/main.rs:939)

## 5. Constraints

- Rust 1.85 or newer, edition 2021; axum 0.8, tokio, sqlx 0.8 (PostgreSQL, rustls), tower-http 0.7, reqwest with rustls; no OpenSSL. (src: api/Cargo.toml:6-24; comment: api/src/push.rs:3)
- License AGPL-3.0-or-later. (src: api/Cargo.toml:4)
- `API_TOKEN` must be at least 16 bytes. (src: api/src/main.rs:932)
- At most 5 pooled database connections. (src: api/src/main.rs:939)
- CORS preflight results may be cached for 600 seconds by browsers. (src: api/src/main.rs:648)
- Only the request headers `Authorization` and `Content-Type` are allowed cross-origin; a reverse proxy in front must pass `Authorization` unchanged. (src: api/src/main.rs:647; doc: docs/install.md "Troubleshooting")
- The server speaks plain HTTP; HTTPS is expected to be terminated by Cloudflare Tunnel, `tailscale serve` or a reverse proxy. (doc: README.md "How it works"; doc: SECURITY.md "Scope notes"; doc: docs/install.md "5. Give the server an https address")
- Tokens and pairing codes are never written to logs. (doc: SECURITY.md "Privacy promise")
- The server never modifies TeslaMate's tables (see `api-storage`). (doc: README.md "How it works")

## 6. Non-goals

- Terminating TLS inside the API. (doc: SECURITY.md "Scope notes"; doc: docs/install.md "5. Give the server an https address")
- Cookie or session authentication. (comment: api/src/main.rs:629)
- Serving the web app's static files; the web app is hosted separately, and same-origin LAN hosting is an unofficial Caddy setup. (doc: README.md "How it works"; doc: docs/install.md "Appendix: LAN-only use")
- Telemetry, analytics or tracking. (doc: README.md "Privacy"; doc: SECURITY.md "Privacy promise")
- A general-purpose TeslaMate API: routes exist only for what the DriveLens app needs. Confirmed (owner decision): drivelens-api is the companion server of the DriveLens app, not a general TeslaMate API.

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | The doc comment "Unauthenticated and DB-free (cheap; also used as the container health/version probe)." sits above `paged()`, not above `health()`. (src: api/src/main.rs:305-311, 348) | The sentence describes `health()`; a reader of `paged()` is misled. Documentation only, no runtime effect. Certain. | The comment belongs on `health()` at line 348. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (doc comment only). |
| CB-2 | Request-extraction failures (malformed JSON body, wrong `Content-Type`, non-numeric `{id}`, wrongly typed query parameters) are answered by axum's default rejection with a plain-text body, not the `{"error": …}` envelope. (src: api/src/main.rs:86-96 maps only handler errors; handlers take `Json<…>`, `Path<i64>`, `Query<…>` extractors, e.g. api/src/main.rs:490, 524) | Every other error path returns JSON (CORE-060/061); clients that parse `error` get no message. Likely. | All 4xx responses use the JSON envelope. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: only clients that send malformed requests are affected; the app never does. |
| CB-3 | The process installs no handler for SIGTERM / Ctrl-C and serves without graceful shutdown. (src: api/src/main.rs:953; no `signal`/`ctrl_c` in api/src) | In the Docker image the binary is PID 1 (api/Dockerfile:33); a PID-1 process without a SIGTERM handler ignores SIGTERM, so `docker stop` / Watchtower updates wait for the stop timeout before SIGKILL. Possible (depends on Docker runtime behavior, not verified). | Exit promptly on SIGTERM, optionally finishing in-flight requests. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: confirmed that the image runs the binary as PID 1 (distroless `ENTRYPOINT`, api/Dockerfile:33) and the compose file has no `init: true`, so `docker stop` / Watchtower waits for the 10 s stop timeout. Fix: handle SIGTERM with `axum::serve(..).with_graceful_shutdown(..)` (or add `init: true`). |
| CB-4 | `/api/health` reports six feature flags but not `place aliases` or `device auth`, which the startup feature log does report. (src: api/src/main.rs:356-361 vs. 603-607) | The two feature lists disagree; device-auth status is only available via `GET /api/auth/me`. Possible. | Either both lists match or the difference is deliberate. **Review:** not a bug. Device-auth status is reported per caller by `GET /api/auth/me` (`device_auth`), which is what the app reads; place aliases have no runtime probe (see api-storage CB-2). Adding both flags to `/api/health` would be an optional improvement. |
