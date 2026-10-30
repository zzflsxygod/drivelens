# api-auth — Authentication, device tokens and pairing

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `api/src/auth.rs`, `api/src/main.rs` (`router`, `main`, `auth_tests`), `api/src/push.rs` (`subscribe`, device link only), `SECURITY.md`, `docs/install.md` ("Managing devices", "Upgrading to 0.14.0", "Environment variables", "Troubleshooting"), `CHANGELOG.md` (v1.1.2 server 0.13.1, v1.2.0 server 0.14.0).
> In this document, "the system" means the drivelens-api authentication layer: the auth middleware in front of `/api/*`, the `/api/auth/*` endpoints, and the in-memory device index with its failure limits.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

drivelens-api exposes a TeslaMate owner's private driving data over HTTPS. The system decides who may call the API. One owner key (`API_TOKEN`) exists per server. Each phone, tablet or browser can get its own revocable device token, so a lost device can be disconnected without changing the server token on every device (doc: CHANGELOG.md v1.2.0). Pairing codes let a new device join without typing the server token. Read-only devices let family members or a car screen view data without changing it (doc: docs/install.md "Managing devices").

## 2. Responsibility boundaries

### 2.1 In scope
- Bearer-token authentication of every `/api/*` route except `POST /api/auth/pair`.
- Owner key comparison and the owner-key mode (`DRIVELENS_OWNER_KEY_MODE`).
- Device tokens (`dlt_…`): creation, lookup, expiry, last-use tracking, rename, revocation.
- Pairing codes: issue, normalization, redemption, single use, expiry, limits.
- Scope enforcement (`full` / `read`) and the `owner_key_pair_only` restriction.
- Failure limits (per client, global, separate pairing limits) and client-address keying, including trusted proxy headers.
- Creation of the `drivelens.devices` and `drivelens.pairing_codes` tables and the `push_subscriptions.device_id` link column.
- Periodic reload of the device index from the database.

### 2.2 Out of scope
- Reading `API_TOKEN`, `BIND_ADDR`, the `API_TOKEN` length check (≥ 16) and the weak-token warning → `api-core` (api/src/main.rs:930-935).
- CORS policy and the unauthenticated `GET /health` → `api-core`.
- The general schema-migration policy, `deploy/setup.sql` privileges (`CREATE` on schema `drivelens`, table ownership) → `api-storage`.
- Push subscription storage, delivery and the meaning of `/api/push/*` → `api-push`. This module only links a subscription to a device and lets read-only devices call `/api/push/*`.
- Handlers of all non-auth routes → `api-records`, `api-summary`, `api-insights`, `api-journeys`, `api-push`.
- Storing tokens on the device, the setup wizard, the Devices UI and sign-out → `app-connection`.
- TLS termination (Cloudflare Tunnel, Tailscale Serve, reverse proxy) → deployment, see `ops-delivery` (doc: SECURITY.md "Scope notes").

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-core` — `AppState` (database pool, `auth: Arc<AuthState>`), router wiring (`route_layer` + `merge`), `API_TOKEN` and the TCP peer address (`ConnectInfo<SocketAddr>`) (src: api/src/main.rs:873-924, 941, 947, 952-953).
  - `api-storage` — the `drivelens` schema and the privileges that let the API role create and own its tables; startup migration order (`auth::try_migrate` runs after `push::try_migrate`) (src: api/src/main.rs:589-592).
  - `ext:PostgreSQL` — tables `drivelens.devices`, `drivelens.pairing_codes`, column `drivelens.push_subscriptions.device_id`.
  - `ext:OS RNG` — `getrandom` for tokens and codes (src: api/src/auth.rs:106-110).
- **Used by:**
  - every authenticated route of drivelens-api — the middleware runs before the handlers (src: api/src/main.rs:875-915).
  - `api-push` — reads the `Principal` request extension and `AuthState::push_link()` to store the calling device id on a subscription (src: api/src/push.rs:433-457).
  - `api-core` — `log_features` reports `device auth` from `AuthState::available()` (src: api/src/main.rs:607).
  - `app-connection` — calls every `/api/auth/*` endpoint.
- **Provided interface:**

| Method | Path | Who may call | Purpose |
|---|---|---|---|
| GET | `/api/auth/me` | any authenticated principal | Who is calling, device-auth availability, owner-key mode |
| GET | `/api/auth/devices` | owner key, full device | List live devices |
| POST | `/api/auth/devices` | owner key only | Exchange the owner key for a new full-scope device token |
| DELETE | `/api/auth/devices?except=current` | owner key, full device | Revoke every device except the caller |
| PATCH | `/api/auth/devices/current` | any device (also read-only) | Rename the calling device |
| DELETE | `/api/auth/devices/current` | any device (also read-only) | Revoke the calling device |
| PATCH | `/api/auth/devices/{id}` | owner key, full device | Rename a device |
| DELETE | `/api/auth/devices/{id}` | owner key, full device | Revoke a device |
| POST | `/api/auth/pairings` | owner key, full device | Issue a pairing code |
| POST | `/api/auth/pair` | public (no `Authorization`) | Redeem a pairing code for a device token |

  - Request extension `Principal` = `Owner` | `Device { id, scope }` for downstream handlers (src: api/src/auth.rs:244-246, 489).
  - Environment variables: `DRIVELENS_OWNER_KEY_MODE` (src: api/src/auth.rs:248-259), `DRIVELENS_TRUST_PROXY_HEADERS` (src: api/src/auth.rs:160-168). `API_TOKEN` is read by `api-core` and passed in (src: api/src/main.rs:931, 941).
  - Error body: `{"error": <message>, "code": <code>}`. Codes: `rate_limited`, `owner_key_pair_only`, `read_only`, `device_auth_unavailable`, `invalid_name`, `not_found`, `not_a_device`, `owner_key_required`, `too_many_devices`, `bad_request`, `invalid_scope`, `ttl_requires_read`, `invalid_ttl`, `invalid_code`. A plain authentication failure is `{"error": "unauthorized"}` without `code` (src: api/src/auth.rs:428, 451-453, 494-497, 552).

## 3. External behavior

### 3.1 Authenticating `/api/*` requests
- **AUTH-001** When a request to any `/api/*` route other than `POST /api/auth/pair` carries no `Authorization: Bearer <token>` header, the system SHALL answer 401 with `{"error":"unauthorized"}` and count one failure for the client key. (src: api/src/auth.rs:474-486, 422-429; test: api/src/main.rs auth_tests::only_pair_is_public)
- **AUTH-002** When `POST /api/auth/pair` is requested, the system SHALL NOT apply the auth middleware to it. (src: api/src/main.rs:871-872, 915-916; test: api/src/main.rs auth_tests::only_pair_is_public; test: api/src/auth.rs tests::pair_route_is_public)
- **AUTH-003** When the bearer value starts with `dlt_` and device auth is available, the system SHALL accept the request as `Device { id, scope }` if and only if the SHA-256 of the value matches a device in the in-memory index whose `expires_at` is null or later than now. (src: api/src/auth.rs:382-386, 271, 477; test: api/src/auth.rs tests::owner_and_device_tokens)
- **AUTH-004** When the bearer value starts with `dlt_` and device auth is not available, the system SHALL reject the request with 503 `device_auth_unavailable` and SHALL NOT count it as a failed attempt (API ≥ 0.14.1; 401 before), so apps do not treat it as a revoked device. (src: api/src/auth.rs:383; test: api/src/auth.rs tests::unavailable_device_auth_keeps_the_owner_key)
- **AUTH-005** When the bearer value does not start with `dlt_`, the system SHALL compare the SHA-256 digest of the value with the SHA-256 digest of `API_TOKEN` in constant time and, on a match, accept the request as `Owner`. (src: api/src/auth.rs:111-116, 339, 478-482; test: api/src/auth.rs tests::owner_key_compared_as_digest; doc: CHANGELOG.md v1.2.0 "compared in constant time regardless of its length")
- **AUTH-006** When device auth is not available, the system SHALL keep accepting the owner key on every route. (comment: api/src/auth.rs:10-11; test: api/src/auth.rs tests::unavailable_device_auth_keeps_the_owner_key; doc: docs/install.md "Managing devices")
- **AUTH-007** When a request fails authentication and the client key has at most 10 failures in the current window, the system SHALL wait 300 ms and then answer 401 `{"error":"unauthorized"}`. (src: api/src/auth.rs:422-429, 201; comment: api/src/auth.rs:292)
- **AUTH-008** When a request fails authentication and it is more than the 10th failure for that client key within 10 minutes of the key's first failure, the system SHALL wait 1 s and answer 429 with header `Retry-After: 600` and body code `rate_limited`. (src: api/src/auth.rs:416-420, 423-425, 201-213; test: api/src/auth.rs tests::full_mode_never_blocks_the_correct_owner_key; doc: docs/install.md "Troubleshooting")
- **AUTH-009** When a client key is over the failure limit, the system SHALL still evaluate device tokens and accept valid ones. (comment: api/src/auth.rs:476; test: api/src/auth.rs tests::full_mode_never_blocks_the_correct_owner_key, tests::pair_only_blocks_the_owner_key_while_blocked; doc: docs/install.md "Environment variables")
- **AUTH-010** When the owner-key mode is `full` and a client key is over the failure limit, the system SHALL accept a correct owner key from that client. (comment: api/src/auth.rs:479-480; test: api/src/auth.rs tests::full_mode_never_blocks_the_correct_owner_key; doc: CHANGELOG.md v1.1.2 server 0.13.1)
- **AUTH-011** When the owner-key mode is `pair-only` and either the client key has 10 or more failures in its window or all clients together have 50 or more failed owner-key attempts in the global 10-minute window, the system SHALL answer any bearer value that does not start with `dlt_` with 429 `rate_limited` without comparing it. (src: api/src/auth.rs:35-36, 402-404, 481; test: api/src/auth.rs tests::pair_only_blocks_the_owner_key_while_blocked, tests::pair_only_global_limit; doc: docs/install.md "Troubleshooting")
- **AUTH-012** When the global owner-key failure count in `pair-only` mode first reaches 50 in a window, the system SHALL log one warning for that window. (src: api/src/auth.rs:405-412)
- **AUTH-013** When the 10th failure of a client key is recorded, the system SHALL log a warning naming the client key. (src: api/src/auth.rs:427)

### 3.2 Client address and failure buckets
- **AUTH-020** When `DRIVELENS_TRUST_PROXY_HEADERS` is not one of `1`, `true`, `yes`, `on` (case-insensitive), the system SHALL key failures by the TCP peer address and ignore `CF-Connecting-IP`, `X-Forwarded-For` and `X-Real-IP`. (src: api/src/auth.rs:165-184; test: api/src/main.rs auth_tests::headers_ignored_by_default)
- **AUTH-021** When header trust is enabled and the TCP peer is a loopback, private or link-local IPv4 address, an IPv6 loopback or `fc00::/7` address, or an IPv4-mapped loopback/private address, the system SHALL take the client address from `CF-Connecting-IP`, else the right-most `X-Forwarded-For` entry, else `X-Real-IP`, and fall back to the peer address when none of them parses as an IP address. (src: api/src/auth.rs:170-184; test: api/src/main.rs auth_tests::headers_trusted_only_from_local_proxy)
- **AUTH-022** When header trust is enabled and the TCP peer is a public address, the system SHALL use the peer address. (src: api/src/auth.rs:180-183; test: api/src/main.rs auth_tests::headers_trusted_only_from_local_proxy)
- **AUTH-023** When the client address is a non-mapped IPv6 address, the system SHALL use its /64 prefix (`a:b:c:d::/64`) as the key; an IPv4-mapped address SHALL be keyed as its IPv4 form, and a missing address as `unknown`. (src: api/src/auth.rs:185-193; test: api/src/main.rs auth_tests::headers_trusted_only_from_local_proxy)
- **AUTH-024** When 4096 client keys are already tracked within the window, the system SHALL count failures from further new keys in one shared `overflow` bucket. (src: api/src/auth.rs:199-213; test: api/src/main.rs auth_tests::map_is_bounded)
- **AUTH-025** When 10 minutes have passed since a key's first counted failure, the system SHALL drop that key's count. (src: api/src/auth.rs:205-218)

### 3.3 Scopes and owner-key mode
- **AUTH-030** When `DRIVELENS_OWNER_KEY_MODE` is unset, empty or `full`, the system SHALL run in `full` mode; when it is `pair-only` or `pair_only` (trimmed, case-insensitive), in `pair-only` mode; for any other value the API SHALL fail to start with an error. (src: api/src/auth.rs:252-259; src: api/src/main.rs:937; test: api/src/auth.rs tests::names_and_modes)
- **AUTH-031** When `pair-only` is configured but device auth is not available at startup, the system SHALL run in `full` mode and log an error. (src: api/src/auth.rs:328-331; comment: api/src/auth.rs:319-320; doc: docs/install.md "Environment variables")
- **AUTH-032** When the owner key is used in `pair-only` mode on a path that does not start with `/api/auth/`, the system SHALL answer 403 with code `owner_key_pair_only`. (src: api/src/auth.rs:456-459; test: api/src/auth.rs tests::pair_only_mode, tests::permissions_use_the_full_path; doc: docs/install.md "Troubleshooting")
- **AUTH-033** When a `read`-scope device sends a request with a method other than GET or HEAD, the system SHALL answer 403 with code `read_only`, except for any path under `/api/push/` and for PATCH or DELETE on `/api/auth/devices/current`. (src: api/src/auth.rs:460-464; test: api/src/auth.rs tests::read_only_devices, tests::permissions_use_the_full_path; test: api/src/main.rs auth_tests::db_device_flow; doc: SECURITY.md "Revoking and signing out")
- **AUTH-034** When a `read`-scope device calls `GET /api/auth/devices`, `PATCH`/`DELETE /api/auth/devices/{id}`, `DELETE /api/auth/devices?except=current` or `POST /api/auth/pairings`, the system SHALL answer 403 with code `read_only`. (src: api/src/auth.rs:499-502, 567, 586, 606, 621, 635; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-035** When scope rules are evaluated, the system SHALL match on the full original request path including the `/api` prefix. (src: api/src/auth.rs:455, 487; test: api/src/auth.rs tests::permissions_use_the_full_path)

### 3.4 `GET /api/auth/me`
- **AUTH-040** When `GET /api/auth/me` is called, the system SHALL answer 200 with `{"kind": "owner"|"device", "device": <device view>|null, "device_auth": <bool>, "owner_key_mode": "full"|"pair-only"}`; `device` is the caller's device view for a device token and `null` for the owner key. (src: api/src/auth.rs:508-513; test: api/src/main.rs auth_tests::me_without_device_auth, auth_tests::db_device_flow)
- **AUTH-041** When a device is returned by any `/api/auth/*` endpoint, the system SHALL represent it as `{"id", "name", "scope": "full"|"read", "created_via": "owner_key"|"pairing", "created_at", "expires_at", "last_used_at", "last_ip", "user_agent", "current"}`, with timestamps as `YYYY-MM-DDTHH:MM:SSZ` (UTC) or `null`, and `current` true only for the calling device. (src: api/src/auth.rs:272-276, 143-157; test: api/src/auth.rs tests::names_and_modes)

### 3.5 Exchanging the owner key (`POST /api/auth/devices`)
- **AUTH-050** When `POST /api/auth/devices` is called with the owner key and `{"name": <string>}`, the system SHALL create a device with scope `full`, `created_via` `owner_key` and no expiry, and answer 201 with `{"token": <new device token>, "device": <device view>}`. (src: api/src/auth.rs:554-563, 520-547, 549-551; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-051** When `POST /api/auth/devices` is called with a device token, the system SHALL answer 403 with code `owner_key_required`. (src: api/src/auth.rs:557; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-052** When a device is created, the system SHALL store the request's `User-Agent` with control characters removed and cut to 200 characters, or `null` when empty. (src: api/src/auth.rs:30, 504-506; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-053** When a device name is submitted (create, pair, rename), the system SHALL remove control characters, trim it, and answer 400 `invalid_name` unless 1–60 characters remain. (src: api/src/auth.rs:29, 133-138, 495; test: api/src/auth.rs tests::names_and_modes; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-054** When 50 or more unexpired devices already exist, the system SHALL refuse to create another and answer 409 `too_many_devices`. (src: api/src/auth.rs:26, 534-535, 552)
- **AUTH-055** When a device token is created, the system SHALL generate `dlt_` followed by the unpadded base64url encoding of 32 bytes from the OS random number generator (47 characters in total). (src: api/src/auth.rs:23, 106-110, 118; test: api/src/auth.rs tests::token_format; doc: SECURITY.md "Device tokens")
- **AUTH-056** When a device token is created, the system SHALL store only its SHA-256 digest and SHALL return the token only in the creation response. (src: api/src/auth.rs:536-541, 549-551; comment: api/src/auth.rs:5; doc: SECURITY.md "Device tokens")
- **AUTH-057** When device auth is not available, every `/api/auth/*` endpoint except `GET /api/auth/me` SHALL answer 503 with code `device_auth_unavailable`. (src: api/src/auth.rs:494, 556, 566, 585, 590, 605, 610, 620, 634, 672; test: api/src/main.rs auth_tests::only_pair_is_public)

### 3.6 Listing, renaming and revoking devices
- **AUTH-060** When `GET /api/auth/devices` is called by the owner key or a full device, the system SHALL answer 200 with an array of unexpired devices, newest `created_at` first (ties: higher `id` first), with `current` set for the caller. (src: api/src/auth.rs:565-573; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-061** When `PATCH /api/auth/devices/{id}` is called by the owner key or a full device with `{"name"}`, the system SHALL rename the device and answer 200 with its device view, or 404 `not_found` when no such device exists. (src: api/src/auth.rs:575-588)
- **AUTH-062** When `PATCH /api/auth/devices/current` is called with a device token, the system SHALL rename the calling device and answer 200 with its view; with the owner key it SHALL answer 400 `not_a_device`. (src: api/src/auth.rs:589-593, 497; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-063** When `DELETE /api/auth/devices/{id}` is called by the owner key or a full device, the system SHALL delete the device and answer 204, or 404 `not_found` when it does not exist. (src: api/src/auth.rs:595-608)
- **AUTH-064** When `DELETE /api/auth/devices/current` is called with a device token, the system SHALL delete the calling device and answer 204; with the owner key it SHALL answer 400 `not_a_device`. (src: api/src/auth.rs:609-613; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-065** When `DELETE /api/auth/devices?except=current` is called by a full device, the system SHALL delete every other device; when called by the owner key, it SHALL delete every device; it SHALL answer 200 `{"revoked": <count>}`. Without `except=current` it SHALL answer 400 `bad_request`. (src: api/src/auth.rs:618-628; comment: api/src/auth.rs:618)
- **AUTH-066** When a device is revoked, the system SHALL reject its token with 401 on the next request, without waiting for a reload. (src: api/src/auth.rs:597-599, 625; test: api/src/main.rs auth_tests::db_device_flow; doc: SECURITY.md "Revoking and signing out")
- **AUTH-067** When a device is revoked and `drivelens.push_subscriptions.device_id` exists, the database SHALL delete the push subscriptions linked to that device. (src: api/src/auth.rs:64-65, 86; comment: api/src/push.rs:433-435; doc: CHANGELOG.md v1.2.0; doc: SECURITY.md "Revoking and signing out")

### 3.7 Issuing pairing codes (`POST /api/auth/pairings`)
- **AUTH-070** When `POST /api/auth/pairings` is called by the owner key or a full device with `{"scope": "full"|"read", "device_ttl_days"?: <int>}`, the system SHALL store a new code that expires 10 minutes later and answer 201 with `{"code": "XXXX-XXXX", "expires_at": <timestamp>}`. (src: api/src/auth.rs:28, 633-660; test: api/src/main.rs auth_tests::db_device_flow; doc: docs/install.md "Managing devices")
- **AUTH-071** When `scope` is neither `full` nor `read`, the system SHALL answer 400 `invalid_scope`; when `device_ttl_days` is given with scope `full`, 400 `ttl_requires_read`; when it is outside 1–365, 400 `invalid_ttl`. (src: api/src/auth.rs:636-640; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-072** When a pairing code is generated, the system SHALL produce 8 characters from the Crockford Base32 alphabet (`0-9`, `A-Z` without `I`, `L`, `O`, `U`) out of 40 random bits, and display it as two groups of four joined by `-`. (src: api/src/auth.rs:24-25, 120-124, 131; test: api/src/auth.rs tests::pairing_codes)
- **AUTH-073** When a pairing code is stored, the system SHALL store only the SHA-256 digest of its normalized form, the scope, the device TTL, the issuing device id (null for the owner key) and the expiry. (src: api/src/auth.rs:57-63, 645-648; comment: api/src/auth.rs:6-7; doc: SECURITY.md "Device tokens")
- **AUTH-074** When a pairing code is issued, the system SHALL first delete expired codes and afterwards keep only the 5 most recently issued codes, deleting older ones regardless of who issued them. (src: api/src/auth.rs:27, 641, 655-657; comment: api/src/auth.rs:655)
- **AUTH-075** When a generated code collides with an existing one, the system SHALL retry with a new code, up to 3 attempts, and fail with 500 after that. (src: api/src/auth.rs:642-662)

### 3.8 Redeeming a pairing code (`POST /api/auth/pair`)
- **AUTH-080** When `POST /api/auth/pair` receives `{"code", "name"}` with a valid, unexpired code, the system SHALL delete the code, create a device with the code's scope, `created_via` `pairing` and `expires_at` = now + `device_ttl_days` days when the code has a TTL, and answer 201 `{"token", "device"}`. (src: api/src/auth.rs:520-547, 668-691; test: api/src/main.rs auth_tests::db_device_flow)
- **AUTH-081** When a code is redeemed a second time, the system SHALL answer 400 `invalid_code`. (src: api/src/auth.rs:527-530; test: api/src/main.rs auth_tests::db_device_flow; doc: docs/install.md "Managing devices")
- **AUTH-082** When the submitted code is normalized, the system SHALL drop whitespace and `-`, upper-case it, map `I` and `L` to `1` and `O` to `0`, and treat it as malformed unless exactly 8 Crockford characters remain. (src: api/src/auth.rs:125-130; test: api/src/auth.rs tests::pairing_codes)
- **AUTH-083** When the code is malformed, unknown, used or expired, the system SHALL count one pairing failure for the client key, wait 300 ms and answer 400 `invalid_code`. (src: api/src/auth.rs:681-689)
- **AUTH-084** When the name is invalid, the system SHALL answer 400 `invalid_name` without counting a pairing failure. (src: api/src/auth.rs:680)
- **AUTH-085** When the client key has 5 or more pairing failures in its window, or all clients together have 20 or more in the global window, the system SHALL wait 1 s and answer 429 `rate_limited` with `Retry-After: 600` without evaluating the code. (src: api/src/auth.rs:37-39, 431-437, 675-679; test: api/src/auth.rs tests::pairing_failure_limits; doc: SECURITY.md "Device tokens")
- **AUTH-086** When pairing failures are counted, the system SHALL keep them separate from token authentication failures. (src: api/src/auth.rs:287-290; test: api/src/auth.rs tests::pairing_failure_limits)
- **AUTH-087** When a valid code cannot be turned into a device because the device limit is reached, the system SHALL answer 409 `too_many_devices` and leave the code unused. (src: api/src/auth.rs:520-535; comment: api/src/auth.rs:520-521)
- **AUTH-088** When device auth is not available, `POST /api/auth/pair` SHALL answer 503 `device_auth_unavailable`. (src: api/src/auth.rs:672; test: api/src/main.rs auth_tests::only_pair_is_public)

### 3.9 Device index lifecycle
- **AUTH-090** When the API starts, the system SHALL create `drivelens.devices` and `drivelens.pairing_codes` if they are missing and add `drivelens.push_subscriptions.device_id` (FK to `drivelens.devices`, `ON DELETE CASCADE`) if that table exists without the column; when a step fails, it SHALL log a warning and continue. (src: api/src/auth.rs:46-94; comment: api/src/auth.rs:76-77)
- **AUTH-091** When the API starts, the system SHALL mark device auth available only if both tables exist and the API role has SELECT, INSERT, UPDATE and DELETE on them and USAGE on their id sequences, and SHALL then load all devices into memory. (src: api/src/auth.rs:96-103, 321-334, 343-372; doc: docs/install.md "Upgrading to 0.14.0")
- **AUTH-093** When the table probe of a reload fails with a database error other than a missing table, schema or privilege (SQLSTATE classes 42 and 3F), the system SHALL keep the current device index and availability and log a warning; only a probe that reports unusable tables turns device auth off. A token that is unknown or revoked still gets 401 `{"error": "unauthorized"}`. (src: api/src/auth.rs `tables_ok`, `schema_error`, `refresh`; test: api/src/auth.rs tests::reload_db_error_keeps_devices, api/src/main.rs auth_tests::db_journey_note_and_auth_reload)
- **AUTH-092** When device auth becomes available or unavailable, the system SHALL log `device auth enabled: N device(s)` or a warning. (src: api/src/auth.rs:326, 347, 369-371; doc: docs/install.md "Upgrading to 0.14.0")
- **AUTH-093** When 300 s have passed since the last reload, the system SHALL delete expired devices and pairing codes and reload the device index from the database, keeping in-memory usage data that is newer than the database. (src: api/src/auth.rs:33-34, 341-372, 440-448; comment: api/src/auth.rs:33)
- **AUTH-094** When the reload query itself fails, the system SHALL keep the current device index. (src: api/src/auth.rs:353-356; comment: api/src/auth.rs:342)
- **AUTH-095** When a device token is accepted, the system SHALL record `last_used_at` and the client address as `last_ip` in memory, and write them to the database at most once every 300 s per device. (src: api/src/auth.rs:31-32, 381-400; test: api/src/auth.rs tests::owner_and_device_tokens)
- **AUTH-096** When a device has expired, the system SHALL reject its token even before the next reload deletes it. (src: api/src/auth.rs:271, 386; test: api/src/auth.rs tests::owner_and_device_tokens)
- **AUTH-097** When the API restarts, the system SHALL accept the device tokens stored before the restart and SHALL NOT bring back revoked devices. (test: api/src/main.rs auth_tests::db_device_flow)

### 3.10 Logging
- **AUTH-100** When a device is created, renamed or revoked, or a pairing code is issued, the system SHALL log an info line that names devices by id and name and SHALL NOT include any token or code value. (src: api/src/auth.rs:545, 580, 600, 626, 658-659; comment: api/src/auth.rs:9; doc: SECURITY.md "Device tokens")
- **AUTH-101** When the API starts, the system SHALL log the effective owner-key mode. (src: api/src/auth.rs:332)

## 4. Key design decisions

- **D-1 Two kinds of credentials.** The owner key (`API_TOKEN`) stays the recovery and management credential; per-device tokens do day-to-day access. Rotating `API_TOKEN` does not sign devices out. Rationale: a lost device can be disconnected alone (doc: CHANGELOG.md v1.2.0; doc: docs/install.md "Managing devices").
- **D-2 Only hashes are stored.** Device tokens and pairing codes are stored as SHA-256 digests. Tokens carry 256 random bits, so a fast unsalted hash suffices for lookup. Confirmed (design): salting and slow hashing protect low-entropy secrets; a 256-bit random token cannot be brute-forced or found in a rainbow table, and an unsalted digest is what makes the O(1) index lookup possible. (src: api/src/auth.rs:46-63; comment: api/src/auth.rs:5-7; doc: SECURITY.md)
- **D-3 Constant-time owner-key check on digests.** The owner key is hashed first and the 32-byte digests are compared without early exit, so timing does not depend on the candidate's length. (comment: api/src/auth.rs:113; test: api/src/auth.rs tests::owner_key_compared_as_digest)
- **D-4 In-memory index with database as source of truth.** Lookups hit a `HashMap` keyed by token digest. Revocations update memory at once; a full reload every 5 minutes follows manual database edits and removes expired rows. Last-use writes are throttled to one per 5 minutes per device. Confirmed from code: the reason is fewer database writes (comment at `TOUCH_EVERY_SECS`). (src: api/src/auth.rs:279-294, 341-372; comment: api/src/auth.rs:31-34)
- **D-5 Device auth is optional and degrades.** If the API role cannot create or use its tables, device auth is off and the owner key works everywhere as before 0.14.0. `pair-only` falls back to `full` at startup so the owner is not locked out. (comment: api/src/auth.rs:10-11, 319-320; doc: docs/install.md "Managing devices", "Environment variables")
- **D-6 Lockout safety over strictness.** Device tokens are evaluated even while a client is blocked; in `full` mode a correct owner key is too. `pair-only` trades this for brute-force resistance on the owner key. (comment: api/src/auth.rs:160-164, 476-480; doc: docs/install.md "Environment variables")
- **D-7 Rate-limit key = TCP peer by default.** Proxy headers are trusted only on opt-in and only from local/private peers, because any client can set them. Behind a proxy without opt-in all clients share one bucket. IPv6 is grouped by /64. The bucket table is bounded. (comment: api/src/auth.rs:160-164, 176, 185, 199; doc: CHANGELOG.md v1.1.2 server 0.13.1)
- **D-8 Pairing has its own, stricter limits.** 5 failures per client and 20 overall per 10 minutes; beyond that codes are not evaluated. This keeps 40-bit codes with a 10-minute life hard to guess. Confirmed by calculation: at most 20 evaluated guesses per 10 minutes against at most 5 live codes gives a success chance of about 20 × 5 / 2^40 ≈ 1e-10 per window. (comment: api/src/auth.rs:37, 668-669; doc: SECURITY.md "Device tokens")
- **D-9 Human-friendly codes.** Crockford Base32 without ambiguous letters, tolerant input (`I`/`L`→`1`, `O`→`0`, dashes and spaces ignored). (comment: api/src/auth.rs:24, 120, 125)
- **D-10 Public pairing route by router construction.** The auth middleware is a `route_layer`, which only wraps routes added before it; `/auth/pair` is merged afterwards. A test checks that no other route is public. (comment: api/src/main.rs:871-872; test: api/src/main.rs auth_tests::only_pair_is_public)
- **D-11 Read-only devices may still manage themselves.** They may change their own push subscriptions, rename themselves and sign themselves out. (src: api/src/auth.rs:460-463; doc: SECURITY.md "Revoking and signing out")
- **D-12 Failure delays.** 300 ms on a 401, 1 s on a 429. Confirmed (design): the delays slow down online guessing on top of the counters. (src: api/src/auth.rs:414-429; comment: api/src/auth.rs:292, 422)
- **D-13 Codes are not used up on failure.** Consuming the code and inserting the device run in one transaction, so a device-limit refusal leaves the code valid. (comment: api/src/auth.rs:520-521)
- **D-14 Revocation removes notifications.** Push subscriptions reference the device with `ON DELETE CASCADE`. (comment: api/src/auth.rs:86; comment: api/src/push.rs:433-435; doc: CHANGELOG.md v1.2.0)

## 5. Constraints

- Owner key: at least 16 characters, enforced at startup by `api-core`; 32+ random characters recommended (src: api/src/main.rs:932-935; doc: docs/install.md "Environment variables").
- Device token: `dlt_` + 43 base64url characters (47 total), 256 random bits (test: api/src/auth.rs tests::token_format; doc: SECURITY.md).
- Device name: 1–60 characters after removing control characters and trimming (src: api/src/auth.rs:29, 133-138; database CHECK at api/src/auth.rs:48).
- Stored user agent: at most 200 characters (src: api/src/auth.rs:30).
- At most 50 unexpired devices (src: api/src/auth.rs:26).
- Pairing code: 8 Crockford characters (40 bits), valid 10 minutes, single use; at most 5 stored codes (src: api/src/auth.rs:27-28, 120-124).
- Read-only device lifetime: 1–365 days or unlimited (src: api/src/auth.rs:61, 639).
- Token failure limit: more than 10 failures per client key per 10 minutes → 429; key table bounded at 4096 entries plus one overflow bucket (src: api/src/auth.rs:199-202).
- `pair-only` global owner-key limit: 50 failures per 10 minutes (src: api/src/auth.rs:35-36).
- Pairing limits: 5 per client, 20 overall per 10 minutes (src: api/src/auth.rs:37-39).
- Device index reload and last-use flush interval: 300 s (src: api/src/auth.rs:31-34).
- Device auth needs `CREATE` on schema `drivelens` and API-owned tables (doc: docs/install.md "Upgrading to 0.14.0").
- The `Authorization` header must use the exact prefix `Bearer ` (src: api/src/auth.rs:474).

## 6. Non-goals

- No cookies or sessions; authentication is a bearer token only. (comment: api/src/main.rs:629-630)
- No user accounts or multiple owners; one owner key per server. Confirmed from code (single `API_TOKEN`) and by the product scope: one TeslaMate owner per server.
- No per-car, per-endpoint or per-feature permissions beyond `full` and `read`. Confirmed from code; finer permissions are not planned.
- No rotation of `API_TOKEN` through the API; it is changed in `.env` and the API restarted. (doc: docs/install.md "Managing devices")
- No protection against attackers who already hold the server token or a valid device token, and no TLS; the API expects to run behind HTTPS. (doc: SECURITY.md "Scope notes")
- Tokens and codes are never logged. (comment: api/src/auth.rs:9; doc: SECURITY.md)

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `refresh` treats any error of the `tables_ok` query (for example the database being briefly unreachable during the 5-minute reload) as "tables unusable": it sets device auth unavailable and clears the whole device index (src: api/src/auth.rs:96-103 `unwrap_or(false)`, 344-349). Until a later reload succeeds, every device token gets 401, and failures are counted. `app-connection` treats a 401 on a device token as revocation and deletes its saved credentials (src: app/src/api.ts:67-71). | The doc comment says "On a database error the current index is kept" (comment: api/src/auth.rs:342), and that is only implemented for the reload query (src: api/src/auth.rs:353-356). A short database outage can therefore sign out every device. Likely. | A database error while probing the tables keeps the current index and availability; only a successful probe that reports missing tables or privileges disables device auth. **Review:** real issue, verified at 9b1c39c. **Fixed in v1.2.3 / API 0.14.1:** a database error while probing keeps the index and availability (AUTH-093); a device token while device auth is off gets 503, not 401 (AUTH-004); the app signs out only on a 401 `unauthorized` (app-connection CONN-013). |
| CB-2 | If device auth becomes unavailable at runtime (reload finds the tables unusable) while `DRIVELENS_OWNER_KEY_MODE=pair-only` is active, `pair_only` stays set (src: api/src/auth.rs:343-349; fallback only in `init` at 328-331). The owner key then gets 403 `owner_key_pair_only` on data routes and 503 on `/api/auth/*`, and device tokens get 401. | The startup fallback exists "so nobody is locked out" (comment: api/src/auth.rs:319-320); the runtime path locks everybody out until the next successful reload (≤ 5 minutes; "until a restart" corrected in review), and app clients will already have deleted their credentials on the first 401. Possible (needs tables to break at runtime). | Losing device auth at runtime also falls back to `full` mode (or keeps the last known index), as at startup. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Correction to the row: availability is not lost "until a restart": the next successful refresh (≤ 5 min) restores the index and availability. With `pair-only` the lock-out lasts until then; the root cause is CB-1, and fixing CB-1 removes the transient case. **Partly fixed in v1.2.3 / API 0.14.1:** the transient case is gone (CB-1), and device tokens now get 503, so apps keep their credentials. Tables that really become unusable at runtime with `pair-only` still lock out the owner key until the next successful reload (not changed). |
| CB-3 | The bearer scheme is matched case-sensitively with `strip_prefix("Bearer ")` (src: api/src/auth.rs:474). `Authorization: bearer <token>` is rejected with 401 and counted as a failure. | HTTP authentication scheme names are case-insensitive (RFC 7235). The DriveLens app always sends `Bearer`, so the impact is limited to scripts. Possible. | Accept the scheme name case-insensitively. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: only scripts that send a lower-case scheme are affected. |
