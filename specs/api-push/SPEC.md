# api-push — Web Push notifications (server side)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `api/src/push.rs`; wiring in `api/src/main.rs` (`AppState.vapid` / `AppState.http`, `push::spawn`, routes, `/api/health`); the push-related parts of `api/src/auth.rs` (`PUSH_LINK_DDL`, scope check); `deploy/drivelens-v0.16.0.sql`; `docs/install.md` §7 and "Environment variables"; `SECURITY.md`; `CHANGELOG.md`.
> In this document, "the system" means the drivelens-api web-push component: its `/api/push/*` endpoints, its background notifier task and its delivery client.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

drivelens-api sends Web Push notifications to the browsers where the user turned notifications on. It sends a trip summary when a TeslaMate drive ends, a reminder on the 1st of each month that last month's report is ready, and an on-demand test notification. The user's own server detects the events and sends the pushes itself. Each push travels end-to-end encrypted through the browser's push service, with no DriveLens relay in between (doc: docs/install.md "7. Notifications"; doc: SECURITY.md "Privacy promise"; comment: api/src/push.rs:1-4).

## 2. Responsibility boundaries

### 2.1 In scope
- The VAPID signing key: an environment override, or a key generated once and stored in the database. Also the VAPID subject.
- The HTTP endpoints `/api/push/key`, `/api/push/subscription`, `/api/push/subscription/status`, `/api/push/unsubscribe` and `/api/push/test`.
- Subscription records and per-subscription preferences in `drivelens.push_subscriptions`, and notifier state in `drivelens.push_state`.
- The background notifier, which detects finished drives and sends the monthly reminder.
- Message texts (zh / en / ja) and the JSON payload format.
- Delivery: RFC 8291 encryption, RFC 8292 VAPID, the push-service host allow-list, public-address-only DNS resolution, no redirects, timeouts and failure bookkeeping.
- The availability probe `push_ok`.

### 2.2 Out of scope
- When tables are created, the idempotent migration policy, and the degrade-instead-of-fail rule → `api-storage`. The table DDL text itself is defined in `push.rs` (`DDL`).
- Authentication, the `Principal` extension, scope checks (read-only devices may call `/api/push/*`), the `device_id` column and its `ON DELETE CASCADE` foreign key → `api-auth`.
- Route registration, the generic 500 error envelope and the `web_push` field of `GET /api/health` → `api-core`.
- Notification permission, the browser `PushSubscription`, the Settings UI, and how the service worker displays a push and handles a click → `app-notifications`.
- Place aliases (`drivelens.address_aliases`) and the drive energy formula used by other endpoints → `api-records`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-core`: `AppState` (database pool, VAPID cache `vapid`, delivery client `http`), `ApiError` → 500 envelope, router, startup sequence (src: api/src/main.rs:37-53, 86-95, 903-907, 944-946).
  - `api-storage`: `push::try_migrate` is run by `migrate()`, and the tables must exist and be writable (src: api/src/main.rs:591; api/src/push.rs:45-50).
  - `api-auth`: the `Principal` request extension and `AuthState::push_link()` (whether `push_subscriptions.device_id` exists) (src: api/src/auth.rs:337, 489; api/src/push.rs:448-449).
  - ext:TeslaMate tables `drives`, `cars`, `addresses`, `geofences` (read only, polled) (src: api/src/push.rs:256, 262-264, 300-312, 331-335).
  - ext:`drivelens.address_aliases`, read when it exists and is readable (src: api/src/push.rs:294-299, 314-317).
  - ext:PostgreSQL `pg_timezone_names` and `AT TIME ZONE` conversions (src: api/src/push.rs:322-324, 442).
  - ext:browser push services: FCM, Mozilla autopush, Apple, WNS (src: api/src/push.rs:368-370).
  - ext:crate `web-push-native` (RFC 8291 / RFC 8292) (comment: api/src/push.rs:3).
- **Used by:**
  - `app-notifications`: all five endpoints, plus the payload format that its service worker displays.
  - `api-core`: `push_ok` for `/api/health` and the startup feature log, and `push::spawn` / `push::push_client` at startup (src: api/src/main.rs:361, 607, 944, 946).
  - `api-auth`: revoking a device deletes its subscriptions through the foreign key on `push_subscriptions.device_id` (src: api/src/auth.rs:64-65).
- **Provided interface:**

| Method | Path | Auth | Body | Success response |
|---|---|---|---|---|
| GET | `/api/push/key` | owner key or device token (any scope) | — | 200 `{"public_key": "<base64url>"}` |
| POST | `/api/push/subscription` | any | `{endpoint, keys:{p256dh, auth}, trip_summary?, monthly_report?, tz?, locale?, car_ids?, user_agent?}` | 200 Prefs |
| POST | `/api/push/subscription/status` | any | `{endpoint}` | 200 Prefs, or 200 `{"subscribed": false}` |
| POST | `/api/push/unsubscribe` | any | `{endpoint}` | 204 |
| POST | `/api/push/test` | any | `{endpoint}` | 200 `{"sent": true}` |

  Prefs = `{subscribed: true, trip_summary, monthly_report, tz, locale, car_ids, created_at, last_success_at, last_error}` (src: api/src/push.rs:359-366).
  - Environment variables: `DRIVELENS_VAPID_PRIVATE_KEY`, `DRIVELENS_VAPID_SUBJECT` and `DRIVELENS_PUSH_HOSTS` (doc: docs/install.md "Environment variables").
  - Tables: `drivelens.push_subscriptions` and `drivelens.push_state`. The `push_state` keys are `vapid_private_key`, `drive_watermark` and `drive_sent` (src: api/src/push.rs:21-43, 94-96, 254-261, 289-290).
  - Push payload: JSON `{title, body, tag, url, kind}` with `kind` ∈ `trip` | `report` | `test` (src: api/src/push.rs:105-106).

## 3. External behavior

### 3.1 Availability
- **PUSH-001** When `drivelens.push_subscriptions` or `drivelens.push_state` is missing, or the API role lacks `SELECT, INSERT, UPDATE, DELETE` on either table or `USAGE` on `drivelens.push_subscriptions_id_seq`, the system SHALL treat web push as unavailable. (src: api/src/push.rs:52-62)
- **PUSH-002** When web push is unavailable and any `/api/push/*` endpoint is called, the system SHALL answer 503 with `{"error": "<setup hint>"}`. (src: api/src/push.rs:343, 346-347, 437, 469, 476, 482-483)
- **PUSH-003** When web push has been found available once, the system SHALL keep treating it as available until the process restarts, without querying the catalog again. (src: api/src/push.rs:53, 60)
- **PUSH-004** When web push is unavailable at startup and the tables later become usable, the system SHALL start notifying within one notifier tick, without a restart. (src: api/src/push.rs:242; comment: api/src/push.rs:10)
- **PUSH-005** When `GET /api/health` is called with valid authorization, the system SHALL report the availability as the boolean field `web_push`. (src: api/src/main.rs:361)

### 3.2 VAPID key and subject
- **PUSH-010** When `DRIVELENS_VAPID_PRIVATE_KEY` is set to a non-blank value, the system SHALL use it as the VAPID private key. The value is a base64url P-256 private scalar, and trailing `=` padding and surrounding whitespace are accepted. (src: api/src/push.rs:67-73, 84, 88-89; doc: docs/install.md "Environment variables")
- **PUSH-011** When `DRIVELENS_VAPID_PRIVATE_KEY` is unset or blank and web push is available, the system SHALL generate a P-256 key and store it in `drivelens.push_state` under `vapid_private_key`. If that row already exists, the stored key SHALL be kept and used instead. (src: api/src/push.rs:90-97; comment: api/src/push.rs:84-85, 93; doc: docs/install.md "7. Notifications")
- **PUSH-012** When the VAPID key has been loaded once, the system SHALL reuse the same key for the rest of the process lifetime. (src: api/src/push.rs:87, 99-101)
- **PUSH-013** When `GET /api/push/key` is called and web push is available, the system SHALL answer 200 `{"public_key": …}`. The value is the unpadded base64url encoding of the 65-byte uncompressed P-256 public key. (src: api/src/push.rs:71, 345-349; test: api/src/push.rs tests::vapid_roundtrip_and_encrypt)
- **PUSH-014** When `DRIVELENS_VAPID_SUBJECT` is set to a value that starts with `mailto:` or `https://`, the system SHALL send that value as the VAPID subject. Otherwise it SHALL use `https://github.com/zzflsxygod/drivelens`, and it SHALL log a warning if a non-blank invalid value was given. (src: api/src/push.rs:11, 75-82; doc: docs/install.md "Environment variables"; doc: CHANGELOG.md v1.1.2)
- **PUSH-015** When `DRIVELENS_VAPID_PRIVATE_KEY` cannot be decoded as a P-256 key and `GET /api/push/key` or `POST /api/push/test` needs the key, the system SHALL answer 500 `{"error": "internal error"}`. The notifier SHALL log a warning on each tick and send nothing. (src: api/src/push.rs:69-70, 89, 243, 347, 483; api/src/main.rs:90-95; test: api/src/push.rs tests::vapid_roundtrip_and_encrypt)

### 3.3 Subscribing and preferences
- **PUSH-020** When `POST /api/push/subscription` carries an `endpoint` that fails the endpoint rule (PUSH-070), the system SHALL answer 400 `{"error": "endpoint must be an https URL of a known push service"}`. (src: api/src/push.rs:438)
- **PUSH-021** When `keys.p256dh` is not a base64url SEC1 P-256 public key, or `keys.auth` does not decode to exactly 16 bytes, the system SHALL answer 400 `{"error": "invalid subscription keys"}`. (src: api/src/push.rs:113-119, 439-440)
- **PUSH-022** When the endpoint is not stored yet, the system SHALL create a subscription. `trip_summary` and `monthly_report` take the request values, and default to `true` when omitted. (src: api/src/push.rs:452-453; comment: api/src/push.rs:433)
- **PUSH-023** When the endpoint is already stored, the system SHALL make these changes to that subscription:
  - replace `p256dh`, `auth`, `tz`, `locale` and `car_ids`;
  - keep the stored `trip_summary` / `monthly_report` when the request omits them;
  - keep the stored `user_agent` when the request omits it;
  - reset `fail_count` to 0 and `last_error` to `NULL`.

  (src: api/src/push.rs:454-457)
- **PUSH-024** When `tz` is missing, blank, longer than 64 bytes, or not a name in `pg_timezone_names`, the system SHALL store `UTC`. Otherwise it SHALL store the trimmed `tz`. (src: api/src/push.rs:441-443)
- **PUSH-025** When the first two characters of `locale` are exactly `zh` or `ja` (case-sensitive), the system SHALL store that language. For any other or missing value (including `ZH-…`) it SHALL store `en`. (src: api/src/push.rs:164, 444)
- **PUSH-026** When `user_agent` is given, the system SHALL store at most its first 300 characters. (src: api/src/push.rs:445)
- **PUSH-027** When `car_ids` has between 1 and 50 entries, the system SHALL store it, and only drives of those cars SHALL produce notifications for that subscription. When `car_ids` is absent or empty, the system SHALL store `NULL`, meaning all cars. (src: api/src/push.rs:275, 334, 446; comment: deploy/drivelens-v0.16.0.sql:16)
- **PUSH-028** When a new subscription is created, the system SHALL set its `last_monthly` to the previous month in the subscription's time zone. Subscribing on the 1st therefore does not trigger a reminder for a month that is already over. (src: api/src/push.rs:453; comment: api/src/push.rs:447)
- **PUSH-029** When the caller authenticated with a device token and `drivelens.push_subscriptions.device_id` exists, the system SHALL store the device's id in `device_id`. When the caller used the owner key, it SHALL store `NULL`. On an update, `device_id` SHALL be replaced by the current caller's value. (src: api/src/push.rs:448-450, 457, 461; comment: api/src/push.rs:434-435)
- **PUSH-030** When a device is revoked, the system SHALL delete the subscriptions linked to it. (src: api/src/auth.rs:64-65; comment: api/src/push.rs:434-435; doc: SECURITY.md "Privacy promise"; doc: CHANGELOG.md v1.2.0)
- **PUSH-031** When a subscribe request succeeds, the system SHALL answer 200 with Prefs for that endpoint:
  - `subscribed` is always `true`;
  - `created_at` and `last_success_at` are `YYYY-MM-DDTHH:MM:SSZ` strings in UTC, or `null`;
  - `last_error` is a string or `null`.

  (src: api/src/push.rs:359-366, 462-463; api/src/main.rs:121)

### 3.4 Status and unsubscribe
- **PUSH-040** When `POST /api/push/subscription/status` is called with an `endpoint` that is stored, the system SHALL answer 200 with that subscription's Prefs. When the endpoint is unknown, it SHALL answer 200 `{"subscribed": false}`, not 404. (src: api/src/push.rs:468-473; comment: api/src/push.rs:466-467)
- **PUSH-041** When `POST /api/push/unsubscribe` is called with an `endpoint`, the system SHALL delete any subscription with that endpoint. It SHALL answer 204 whether or not a row existed. (src: api/src/push.rs:475-479)
- **PUSH-042** When status, unsubscribe or test is called, the system SHALL select the subscription by `endpoint` alone, without checking which device created it. (src: api/src/push.rs:470, 477, 484)

### 3.5 Test notification
- **PUSH-050** When `POST /api/push/test` is called with an `endpoint` that is not stored, the system SHALL answer 404 `{"error": "subscription not found"}`. (src: api/src/push.rs:484-485)
- **PUSH-051** When the endpoint is stored, the system SHALL send the test message in the subscription's language with a validity of 600 seconds. On success it SHALL answer 200 `{"sent": true}`. (src: api/src/push.rs:217-224, 486-487)
- **PUSH-052** When the push service answers 404 or 410 to the test, the system SHALL delete the subscription and answer 410 with an error text that names the status. (src: api/src/push.rs:133, 145-148, 488)
- **PUSH-053** When the test delivery fails for any other reason, the system SHALL answer 502 `{"error": "push service: <reason>"}`. `<reason>` is one of `HTTP <status>`, `timeout`, `connection failed`, `network error`, `encrypt: …` or `endpoint is not a known push service`. The failure SHALL be counted as in PUSH-076. (src: api/src/push.rs:125-126, 135-136, 149-156, 489)

### 3.6 Message content
- **PUSH-060** When any notification is sent, the system SHALL encrypt a JSON payload `{title, body, tag, url, kind}`. (src: api/src/push.rs:105-106, 124)
- **PUSH-061** When a trip notification is built, its title SHALL be `<car name> · <head> · <distance> km`. `<head>` is `Trip finished` / `行程结束` / `走行終了` and `<distance>` has one decimal, or is `—` when unknown. The `<car name> · ` prefix SHALL appear only when the database has more than one car and the car has a name. (src: api/src/push.rs:184-188, 202, 270; test: api/src/push.rs tests::trip_texts)
- **PUSH-062** When a trip notification is built, its body SHALL be one to two lines:
  - **Route line:** `<start> → <end>`; just `<start>` when both places are equal; `→ <end>` or `<start> →` when one is unknown; no line when both are unknown.
  - **Stats line:** joined with ` · `: the duration; the energy as `x.x kWh` when finite and > 0; the efficiency as `n Wh/km` when finite and > 0.

  (src: api/src/push.rs:189-201; test: api/src/push.rs tests::trip_texts)
- **PUSH-063** When a trip notification is built, `tag` SHALL be `drive-<drive id>`, `url` SHALL be `/?view=drive:<drive id>&car=<car id>` and `kind` SHALL be `trip`. (src: api/src/push.rs:202-203; test: api/src/push.rs tests::trip_texts)
- **PUSH-064** When a monthly reminder is built for month `YYYY-MM`, the system SHALL use these texts:
  - **Title:** `Your <Month name> report is ready`, `<m> 月月报已生成` or `<m>月のレポートができました`.
  - **Body with drives:** names the distance, rounded to whole km with `,` thousands separators, and the drive count. English uses the plural "drives" for more than one.
  - **Body without data:** a generic "open last month's report" text when there are no drives or the distance is unknown.
  - **Fields:** `tag` `report-<YYYY-MM>`, `url` `/?view=report:<YYYY-MM>`, `kind` `report`.

  (src: api/src/push.rs:206-216; test: api/src/push.rs tests::monthly_texts)
- **PUSH-065** When a test notification is built, `tag` SHALL be `test`, `url` SHALL be `/?view=settings` and `kind` SHALL be `test`, with a fixed title and body per language. (src: api/src/push.rs:217-224)
- **PUSH-066** When a subscription's locale is not `zh` or `ja`, the system SHALL use English texts. (src: api/src/push.rs:164; test: api/src/push.rs tests::trip_texts)
- **PUSH-067** When a duration of `h` hours and `m` minutes is formatted, the system SHALL use these patterns. Each language's first pattern applies when `h = 0`.
  - zh: `{m} 分钟` / `{h} 小时 {m} 分钟`
  - ja: `{m}分` / `{h}時間{m}分`
  - en: `{m} min` / `{h} h {m} min`

  (src: api/src/push.rs:166-173; test: api/src/push.rs tests::endpoints; test: api/src/push.rs tests::trip_texts)

### 3.7 Delivery
- **PUSH-070** When an endpoint is checked, the system SHALL accept it only if all of these hold:
  - it is at most 2048 bytes and parses as a URI;
  - the scheme is `https`;
  - there is no port, or the port is 443;
  - the authority contains no `@`;
  - the host, case-insensitive and ignoring a trailing dot, equals one of the allowed hosts or ends with `.<allowed host>`.

  The allowed hosts are `fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com`, `notify.windows.com` and `android.googleapis.com`, plus every host in the comma-separated `DRIVELENS_PUSH_HOSTS` (whitespace and a leading `*.` are stripped). (src: api/src/push.rs:368-392; test: api/src/push.rs tests::endpoints; doc: docs/install.md "Environment variables"; doc: CHANGELOG.md v1.1.2)
- **PUSH-071** When a stored subscription's endpoint no longer passes the endpoint rule at send time, the system SHALL not contact it and SHALL record the failure `endpoint is not a known push service`. (src: api/src/push.rs:126)
- **PUSH-072** When the delivery client resolves a push host, it SHALL connect only to public unicast addresses. If no public address remains, the request SHALL fail. The rejected ranges are:
  - IPv4: loopback, private, link-local, unspecified, broadcast, multicast, documentation, `0.0.0.0/8`, `100.64.0.0/10`, `192.0.0.0/24`, `198.18.0.0/15` and `240.0.0.0/4`;
  - IPv6: loopback, unspecified, multicast, `fc00::/7`, `fe80::/10`, `2001:db8::/32`, `64:ff9b::/96`, and IPv4-mapped forms of rejected IPv4 addresses.

  (src: api/src/push.rs:394-425; test: api/src/push.rs tests::only_public_addresses; test: api/src/push.rs tests::push_client_refuses_internal_names)
- **PUSH-073** When the delivery client sends a request, it SHALL not follow redirects. It SHALL use a 10-second connect timeout and a 20-second overall timeout, and each delivery request SHALL also carry a 15-second timeout. (src: api/src/push.rs:128-129, 427-431; comment: api/src/main.rs:49)
- **PUSH-074** When a notification is delivered, the system SHALL `POST` to the endpoint with an `aes128gcm`-encrypted body, a VAPID `Authorization` header (`vapid t=…`) and the header `Urgency: normal`. (src: api/src/push.rs:121-130; test: api/src/push.rs tests::vapid_roundtrip_and_encrypt; test: api/src/push.rs tests::payload_decrypts_with_the_browser_key)
- **PUSH-075** When a notification is delivered, its validity SHALL be 24 hours for a trip summary, 3 days for a monthly reminder and 600 seconds for a test. These values become the HTTP `TTL` header only (`TTL_TRIP`, `TTL_MONTHLY`, `TTL_TEST`). The VAPID JWT is signed separately with an `exp` of 12 hours (`VAPID_VALIDITY`), independent of the `TTL`, because RFC 8292 caps `exp` at 24 h (API ≥ 0.14.1; before that `web-push-native`'s `with_valid_duration` also set the JWT `exp`, see CB-3). (src: api/src/push.rs `build_request`; test: api/src/push.rs tests::vapid_exp_is_short_and_ttl_is_kept, tests::real_push_service_accepts_the_monthly_ttl (opt-in, `DRIVELENS_PUSH_E2E`))
- **PUSH-076** When a delivery finishes, the system SHALL update the subscription by outcome:
  - **2xx:** set `last_success_at = now()`, `fail_count = 0` and `last_error = NULL`.
  - **404 or 410:** delete the subscription.
  - **Any other failure:** if this makes 10 consecutive failures, delete the subscription. Otherwise increment `fail_count` and store the reason in `last_error`.

  (src: api/src/push.rs:18-19, 140-161; comment: api/src/push.rs:140)
- **PUSH-077** When a delivery fails, the system SHALL record and return only the HTTP status or a generic network class. It SHALL never store or return the push service's response body. (src: api/src/push.rs:134-136; doc: CHANGELOG.md v1.1.2)

### 3.8 Notifier task
- **PUSH-080** When the API process starts, the system SHALL start the notifier about 5 seconds later. The notifier then runs every 60 seconds, and a late tick is delayed rather than run in a burst. (src: api/src/push.rs:13, 235-241; api/src/main.rs:946; doc: docs/install.md "7. Notifications")
- **PUSH-081** When a notifier tick runs, the system SHALL do nothing if web push is unavailable or no VAPID key can be loaded. Otherwise it SHALL run the trip check and then the monthly check. An error in either check SHALL be logged and SHALL not stop later ticks. (src: api/src/push.rs:241-246)

### 3.9 Trip summary detection
- **PUSH-090** When the trip check runs and `drive_watermark` does not exist in `push_state`, the system SHALL set it to the highest `drives.id`, or 0 when there are none, and send nothing. Past drives are not backfilled. (src: api/src/push.rs:254-259; comment: api/src/push.rs:251)
- **PUSH-091** When the trip check finds drives with `id > drive_watermark` that have an `end_date` and are not in `drive_sent`, the system SHALL send a trip summary for each such drive, provided:
  - the drive ended less than 6 hours ago;
  - its distance is at least 0.1 km.

  The summary goes to every subscription with `trip_summary = true` whose `car_ids` is `NULL`, empty, or contains the drive's car. (src: api/src/push.rs:15, 266-279, 307)
- **PUSH-092** When a finished drive above the watermark is processed, the system SHALL add it to `drive_sent` whether or not a notification was sent. Drives found after a long downtime are therefore marked as seen without a notification. (src: api/src/push.rs:271-282; comment: api/src/push.rs:14)
- **PUSH-093** When the trip check finishes, the system SHALL update its stored state:
  - Move `drive_watermark` to the last id of the longest run of drives above the old watermark, in id order, in which every drive either has an `end_date` or started more than 1 day ago.
  - Remove ids at or below the new watermark from `drive_sent`.
  - Store `drive_sent` as a sorted, de-duplicated comma-separated list.

  (src: api/src/push.rs:284-290; comment: api/src/push.rs:250-252)
- **PUSH-094** When a trip summary names a place, the system SHALL use the first value available in this order:
  1. the place alias, if `drivelens.address_aliases` exists and is readable;
  2. the geofence name;
  3. the address name;
  4. `<road> <house_number>`;
  5. the city.

  (src: api/src/push.rs:294-303, 314-317)
- **PUSH-095** When a trip summary shows energy and efficiency, the system SHALL compute energy as `(start_rated_range_km − end_rated_range_km) × cars.efficiency` in kWh. Efficiency SHALL be `energy × 1000 / distance` in Wh/km, only when the distance is greater than 0. (src: api/src/push.rs:305-306)

### 3.10 Monthly reminder
- **PUSH-100** When the monthly check runs, the system SHALL process every subscription for which all of these hold:
  - `monthly_report = true`;
  - in the subscription's time zone it is day 1 of the month and the hour is 9 or later;
  - `last_monthly` differs from the previous month (`YYYY-MM` in that time zone).

  (src: api/src/push.rs:17, 319-325; doc: docs/install.md "7. Notifications")
- **PUSH-101** When it processes such a subscription, the system SHALL first set `last_monthly` to the previous month. It SHALL then count the finished drives that started in that month in the subscription's time zone, limited to the subscription's cars when `car_ids` is non-empty, and send the monthly reminder with their total distance. (src: api/src/push.rs:326-337; comment: api/src/push.rs:329)
- **PUSH-102** When that month has no finished drives, the system SHALL send no reminder, and the month SHALL stay marked as handled. (src: api/src/push.rs:330, 336; comment: api/src/push.rs:336)

## 4. Key design decisions

- **D-1 The user's own server detects events and sends the pushes.** No DriveLens backend relays notifications, and the app does not need to be open. The server polls TeslaMate read-only (comment: api/src/push.rs:2-4; doc: docs/install.md "7. Notifications"; doc: SECURITY.md "Privacy promise"). Trade-off: the container needs outbound https access to the push services (doc: docs/install.md "7. Notifications").
- **D-2 A pure-Rust Web Push stack.** `web-push-native` provides RFC 8291 aes128gcm and RFC 8292 VAPID, so the image contains no OpenSSL (comment: api/src/push.rs:3).
- **D-3 The VAPID key is generated by the server and stored in the database.** A self-hoster needs no setup, and subscriptions survive restarts and image updates. `DRIVELENS_VAPID_PRIVATE_KEY` overrides it (comment: api/src/push.rs:84-85; doc: docs/install.md "7. Notifications"). Consequence: if the database is replaced, every device has to turn notifications on again (doc: docs/install.md "7. Notifications").
- **D-4 SSRF guard on outgoing pushes.** The guard combines the host allow-list, https on port 443 only, no userinfo, DNS resolution that keeps only public addresses (also against rebinding), no redirects, and errors that carry only the status. The server must not be usable to reach arbitrary or internal URLs (comment: api/src/push.rs:384-385, 394-395, 414-415, 427; doc: CHANGELOG.md v1.1.2).
- **D-5 Subscriptions are identified by their endpoint URL.** Status, unsubscribe and test take the endpoint in a POST body because it is a long URL (comment: api/src/push.rs:466). Confirmed (design): these calls are not limited to the calling device's own subscriptions. They rely on the endpoint being an unguessable capability URL that only that browser and its push service know, and they require an authenticated caller.
- **D-6 Finished-drive detection uses a watermark and a "sent" set instead of a per-drive table.** Several cars can finish drives out of id order. The first run does not backfill, and a drive that never gets an `end_date` stops holding the watermark after one day (comment: api/src/push.rs:250-252).
- **D-7 The monthly reminder is marked before it is sent.** A failing push service must not cause a reminder every minute (comment: api/src/push.rs:329). An empty month produces no "report is ready" message (comment: api/src/push.rs:336).
- **D-8 Subscriptions are linked to devices.** Revoking a device also removes its notifications (comment: api/src/push.rs:434-435; doc: CHANGELOG.md v1.2.0; doc: SECURITY.md "Privacy promise").
- **D-9 An unknown subscription is not reported as 404.** The status endpoint answers `{"subscribed": false}` because the app treats a 404 as "server too old" (comment: api/src/push.rs:466-467).
- **D-10 Dead subscriptions are dropped.** A 404/410 from the push service deletes the subscription at once. Ten consecutive other failures delete it too (comment: api/src/push.rs:18, 140).

## 5. Constraints

- Web push exists from API level 13 (drivelens-api 0.12.0). Clients gate the feature on that level (src: api/src/main.rs:301-303; app/src/version.ts:10).
- Every `/api/push/*` route requires an `Authorization` header (test: api/src/main.rs auth_tests::only_pair_is_public). Read-only devices may call all `/api/push/*` routes, including POST (src: api/src/auth.rs:460-462; test: api/src/auth.rs read_only_devices; test: api/src/auth.rs permissions_use_the_full_path; doc: SECURITY.md "Privacy promise").
- The component writes only `drivelens.push_subscriptions` and `drivelens.push_state`. TeslaMate tables are only read (comment: api/src/push.rs:4).
- Limits: endpoint ≤ 2048 bytes; `tz` ≤ 64 bytes; `user_agent` ≤ 300 characters; `car_ids` ≤ 50 entries; `locale` ∈ {`zh`, `en`, `ja`}, enforced by a CHECK constraint (src: api/src/push.rs:31, 388, 441, 445-446).
- Timing: tick 60 s; first tick about 5 s after start; trip freshness 6 h; stuck-drive release 1 day; monthly hour 09:00 local; at most 10 consecutive failures (src: api/src/push.rs:13-19, 237, 263).
- The monthly reminder is only sent on day 1 in the subscription's local time zone. If the notifier cannot run at any time between 09:00 and the end of that day, no reminder is sent for that month (src: api/src/push.rs:323).
- TeslaMate timestamps are treated as UTC (`now() AT TIME ZONE 'UTC'`, `start_date AT TIME ZONE 'UTC'`) (src: api/src/push.rs:263, 307, 333).
- Outbound https access to the push services is required (doc: docs/install.md "7. Notifications").

## 6. Non-goals

- No backfill: drives that ended before notifications were set up, or more than 6 hours before they were seen, produce no notification (comment: api/src/push.rs:14, 251).
- Pushes are never sent to URLs outside the push-service allow-list or to internal addresses (comment: api/src/push.rs:384-385, 394-395).
- No notification history or inbox is kept (confirmed, current scope). Only the subscription's last success and last error are stored (src: api/src/push.rs:21-38).
- There are no notifications for charging sessions, software updates or other events (confirmed, current scope; new types go through a GitHub issue first). Only trip summaries, monthly reminders and test notifications exist (src: api/src/push.rs:106, 184-224).
- Browser permission prompts, subscription creation and on-device display are not done by the server (comment: app/src/notify.ts:3-4).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | The 503 setup hint for missing push tables tells the admin to "run deploy/drivelens-v0.16.0.sql as the TeslaMate DB admin" (src: api/src/push.rs:10). | `deploy/setup.sql` says the older `drivelens-v0.x.sql` files "are no longer needed" (comment: deploy/setup.sql:18-19). The changelog says the API upgrades its own schema after the one-time `setup.sql` (doc: CHANGELOG.md, header). The v0.16.0 file itself is only for legacy installs (comment: deploy/drivelens-v0.16.0.sql:3-4). The other features' hints point to `setup.sql` (src: api/src/main.rs:514; api/src/journey.rs:7; api/src/phase2.rs:8-9). Likely a stale message. | The hint points to re-running `deploy/setup.sql` once and restarting, like the other features. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Text only (X-4). |
| CB-2 | A `car_ids` list with more than 50 entries is silently stored as `NULL`, which means all cars (src: api/src/push.rs:446). | A request that limits notifications to specific cars ends up with a wider scope than asked, and gets no error. Possible; low impact, because the app never sends `car_ids` (src: app/src/notify.ts:35-39). | Reject such a request with 400, or keep the limit without widening it. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (the app never sends `car_ids`). |
| CB-3 | Found in review. `with_valid_duration` also sets the `exp` of the VAPID JWT (web-push-native 0.5.0: `VapidSignature::sign(endpoint, valid_duration, …)` → `Claims::create(valid_duration)`), so the monthly reminder (3 days, api/src/push.rs:337) is signed with a JWT that expires 72 h after issue, and the trip summary (api/src/push.rs:276) with exactly 24 h. | RFC 8292 §2: the `exp` claim MUST NOT be more than 24 hours from the time of the request; push services (FCM, Mozilla autopush, Apple) reject such tokens with 401/403. Every monthly reminder would then fail and count toward `MAX_FAILS`; the trip summary sits exactly at the limit, so a server clock running ahead can be rejected too. Not observed yet: push shipped on 2026-10-20 (v0.16.0, API 0.12.0) and the first monthly reminder is due on 2026-11-01. Likely. | Keep the JWT `exp` ≤ 12 h, independent of the `TTL`. **Review:** real bug, confirmed against live push services on 2026-10-26: a 3-day JWT got HTTP 403 from FCM and 401 from Mozilla autopush. **Fixed in v1.2.3 / API 0.14.1:** the VAPID header is signed separately with a 12 h `exp`; `TTL` stays 24 h / 3 days / 600 s. With the fix both services answered 201 to a 3-day-TTL message (autopush echoed `TTL: 259200`). |
