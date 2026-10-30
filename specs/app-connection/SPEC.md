# app-connection — Server connection, credentials and device auth (client)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `app/src/api.ts`, `app/src/setup.ts`, `app/src/version.ts`, `app/src/urlguard.ts`, `app/src/auth.ts`, `app/src/devices.ts`, and the call sites in `app/src/main.ts` (Settings › Server save handler, sign-out / revocation handling, start-up); visible texts from `app/src/locales/en.ts`; `README.md` "Privacy", `SECURITY.md`, `docs/install.md` "6. Connect the web app" and "Managing devices", `CHANGELOG.md` v1.1.1–v1.2.0.
> In this document, "the system" means the part of the DriveLens app (web/PWA and Tauri) that stores the server connection, sends API requests, checks the server version, runs the first-run wizard, manages device tokens and the Settings › Server / Devices / Sign-out sections.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

The DriveLens app is a static client that talks directly to the user's own drivelens-api. The system lets the user connect it to that server once, keeps the connection on this device only, and sends every API request with the right credentials. It turns a server token or a pairing code into a per-device token, so the server token does not have to stay on the device (doc: CHANGELOG.md v1.2.0). It tells the rest of the app which server features exist, and it handles disconnecting: user sign-out and revocation from another device.

## 2. Responsibility boundaries

### 2.1 In scope
- The connection fields of the settings object in `localStorage` (`apiUrl`, `token`, `tokenKind`, `deviceId`, `deviceScope`) and the load/save functions for the whole settings object.
- The request layer `api()` and its error mapping.
- Server version / API level detection and the feature-level API (`checkServer`, `lacks`, `featureText`, `globalBanner`, `serverLabel`).
- The URL privacy guard that strips `api`, `token`, `key` parameters from the address.
- The first-run setup wizard and `testConnection` (also used by Settings › Server).
- Device auth on the client: owner-key exchange, pairing, silent migration of saved owner keys, `whoAmI`, `canWrite`, device list / rename / disconnect / pairing UI, sign-out, handling of revocation, clearing server-scoped caches.
- The behavior of the Settings › Server card (save & test, status row) and the Devices and Sign-out cards.

### 2.2 Out of scope
- Composition and layout of the Settings screen, other settings (theme, language, currency, journeys), banners rendering, tab navigation → `app-shell`.
- Bottom-sheet keyboard handling, popover menus (`popMenu`), focus helpers → `app-ui-kit`.
- The demo URL/token, demo fetch interception and demo storage namespace (`skey`) → `app-demo`.
- Browser push subscription and its `disable()` function → `app-notifications`.
- The service worker that never caches API requests and answers addresses with `api`/`token`/`key` parameters from cache → `app-platforms`.
- Feature screens that call `api()` and gate entry points with `lacks()` / `canWrite()` → `app-home`, `app-records`, `app-journeys`, `app-insights`, `app-notifications`.
- Wrappers `setAlias`, `resetAlias`, `setCost`, `resetCost` (defined in `api.ts`, used by place-rename and cost dialogs) → behavior specified in `app-records`.
- Server-side authentication rules → `api-auth`.
- Translations of the texts quoted here → `app-i18n`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-auth` — `/api/auth/me`, `/api/auth/devices`, `/api/auth/devices/current`, `/api/auth/devices/{id}`, `/api/auth/devices?except=current`, `/api/auth/pairings`, `/api/auth/pair`, error codes (`read_only`, `owner_key_pair_only`, `invalid_code`, `too_many_devices`, `device_auth_unavailable`, `rate_limited`).
  - `api-core` — unauthenticated `GET /health` returning `{"status", "version", "api_level"}`; error body `{"error": …}`.
  - `api-records` — `GET /api/cars` as the authenticated connection check.
  - `app-i18n` — `t()`, `langSetting()`, `currentLang()`, `ago()`, `fmtDay()`.
  - `app-demo` — `isDemo()`, `DEMO_URL`, `DEMO_TOKEN`, `enterDemo()`, `exitDemo()`.
  - `app-notifications` — `disable()` to drop the push subscription on sign-out.
  - `app-ui-kit` — `popMenu`, `focusField`, `ic()`.
  - `app-platforms` — `isTauri()`, `isAndroid()`.
  - `app-shell` — `links.installGuideUrl()`, the Settings screen that hosts the cards, `leftServer()` (full reload into the wizard).
  - `ext:browser` — `fetch`, `localStorage`, `sessionStorage`, `history.replaceState`, `navigator.onLine`, `navigator.locks` (optional), `AbortController`.
- **Used by:**
  - `app-shell` — start-up (`checkServer` → `initDeviceAuth`), setup wizard, Settings › Server, banners (`globalBanner`, `tooOldText`), `SIGNED_OUT_EVENT` handling, feature gates.
  - All feature modules — `api()`, `loadSettings()` / `saveSettings()`, `lacks()`, `featureText()`, `canWrite()`, `fmtMoney()`, `defaultCurrency()`.
  - `app-demo` — `FEATURE_LEVEL`, `LATEST_SERVER` (to report the newest server level).
- **Provided interface:**
  - Storage: `localStorage["drivelens-settings"]` (JSON `Settings`), `sessionStorage["drivelens-setup-draft"]`, `sessionStorage["drivelens-left-notice"]` (written by `app-shell`'s `leftServer`, read by the wizard start-up).
  - Window events: `drivelens-signed-out` (`SIGNED_OUT_EVENT`), `drivelens-server-error`.
  - Web Lock name: `drivelens-upgrade`.
  - Functions: `api`, `loadSettings`, `saveSettings`, `realServer`, `fmtMoney`, `localeCurrency`, `defaultCurrency`, `defaultLabelLang`, `CURRENCIES`; `checkServer`, `serverReady`, `serverInfo`, `onServerInfo`, `lacks`, `featureText`, `tooOldText`, `globalBanner`, `serverLabel`, `APP_VERSION`, `MIN_API_LEVEL`, `FEATURE_LEVEL`, `LEGACY_LEVEL`; `testConnection`, `normalizeUrl`, `renderResult`, `showSetupWizard`, `LATEST_SERVER`; `whoAmI`, `cachedMe`, `onMeChange`, `canWrite`, `saveConnection`, `forgetServer`, `signOut`, `revokeOldDevice`, `initDeviceAuth`, `isLeaving`, `clearServerCaches`; `mountDevices`, `signOutCardHTML`, `bindSignOut`, `thisDeviceText`, `confirmSheet`; `stripSensitiveParams`.

| Settings field (`drivelens-settings`) | Owner | Meaning |
|---|---|---|
| `apiUrl`, `token` | `app-connection` | Server base URL and the bearer token (owner key or `dlt_` device token) |
| `tokenKind` | `app-connection` | `"device"` = device token, `"owner"` = owner key on a server without device auth, absent = unknown (pre-1.2.0 or older server) |
| `deviceId`, `deviceScope` | `app-connection` | The device's id and scope (`full`/`read`), cached from the server |
| `uiLang`, `theme`, `labelLang`, `currency` | `app-shell` / `app-i18n` | Display preferences |
| `journeyGap`, `speedColor`, `speedColorMax` (integer km/h, 30–250, default 120), `suggestionsOff`, `suggestionsCollapsed`, `dismissedDrives` | `app-journeys` / `app-records` | Feature preferences (speed color shared by drive + journey maps) |

## 3. External behavior

### 3.1 Stored settings
- **CONN-001** When settings are loaded, the system SHALL read the JSON object in `localStorage["drivelens-settings"]`, default `apiUrl` and `token` to `""`, and return `{apiUrl: "", token: ""}` when the stored value is not valid JSON. (src: app/src/api.ts:12-16)
- **CONN-002** When demo mode is active, the system SHALL return the demo URL and demo token from `loadSettings()` and SHALL keep the stored real `apiUrl`, `token`, `tokenKind`, `deviceId` and `deviceScope` unchanged when settings are saved. (src: app/src/api.ts:17-28; comment: app/src/api.ts:25)
- **CONN-003** When the server URL or token is stored, the system SHALL keep it only in this browser's `localStorage` and send it only to that server. (comment: app/src/auth.ts:3, app/src/urlguard.ts:3; doc: README.md "Privacy"; doc: SECURITY.md "Privacy promise")

### 3.2 Request layer (`api()`)
- **CONN-010** When `api(path, method, body)` is called without a configured `apiUrl`, the system SHALL throw "Enter the API URL and token in Settings first". (src: app/src/api.ts:55; src: app/src/locales/en.ts:131)
- **CONN-011** When `api()` sends a request, the system SHALL send it to `apiUrl` (trailing slashes removed) + `path`, with header `Authorization: Bearer <token>`, and with `Content-Type: application/json` and a JSON body only when a body is given. (src: app/src/api.ts:56-61; doc: docs/install.md "6. Connect the web app" "always in a request header (never in a URL)")
- **CONN-012** When `fetch` itself fails, the system SHALL rethrow an `AbortError` unchanged, and otherwise throw "This device is offline" when the browser is offline, the Tauri network message in the Tauri app, or the web message that mentions CORS in the web app. (src: app/src/api.ts:62-66; src: app/src/locales/en.ts:459-461)
- **CONN-013** When the server answers 401 to a request made with a saved device token (`tokenKind` `"device"`), outside demo mode, the saved token is still the one that was sent, and the response body is `{"error": "unauthorized"}` (a real authentication rejection from drivelens-api; v1.2.3+), the system SHALL dispatch the window event `drivelens-signed-out` and throw "This device has been disconnected". A 401 page from a proxy in front of the API (or any non-JSON 401) SHALL NOT sign the device out. (src: app/src/api.ts:69-76; comment: app/src/api.ts:70-72; src: app/src/api.ts:101-103; src: app/src/locales/en.ts:499; doc: docs/install.md "Behind an auth proxy")
- **CONN-014** When the server answers 5xx (including 503 `device_auth_unavailable`) or the request fails on the network, the system SHALL keep the saved connection. When the server answers 401 in any other case, the system SHALL throw "Invalid token (401). Check it in Settings". (src: app/src/api.ts:71; src: app/src/locales/en.ts:132)
- **CONN-015** When the server answers 429, the system SHALL throw the "Too many failed token attempts … Try again in 10 minutes" message. (src: app/src/api.ts:73; src: app/src/locales/en.ts:133)
- **CONN-016** When the server answers 403 with `code` `read_only` or `owner_key_pair_only`, the system SHALL throw the read-only message or the pair-only message respectively. (src: app/src/api.ts:78-79; src: app/src/locales/en.ts:497-498)
- **CONN-017** When the server answers 503 and the `error` text mentions `charge_costs`, `v0.7.0`/`cover_image`/`weather_hourly`, or `journey`, the system SHALL throw the matching "… aren't enabled on the server: run deploy/setup.sql …" message. (src: app/src/api.ts:80-85; src: app/src/locales/en.ts:134-136)
- **CONN-018** When the server answers any other non-2xx status, the system SHALL throw `Request failed: HTTP <status> (<error>)` with the numeric status attached as `err.status`. (src: app/src/api.ts:86-87, 90; src: app/src/locales/en.ts:137-138)
- **CONN-019** When the non-2xx status is 404, 502 or 503, the system SHALL also dispatch the window event `drivelens-server-error`. (src: app/src/api.ts:88-89)
- **CONN-020** When the server answers 204, the system SHALL resolve with `undefined`; for other 2xx statuses it SHALL resolve with the parsed JSON body. (src: app/src/api.ts:92-93)

### 3.3 Server version and feature levels
- **CONN-030** When `checkServer()` runs with a configured `apiUrl`, the system SHALL request `GET <apiUrl>/health` without credentials and without HTTP cache, abort it after 8 s, and notify all `onServerInfo` listeners when it finishes. (src: app/src/version.ts:27-49)
- **CONN-031** When `/health` answers 2xx with JSON containing a numeric `api_level`, the system SHALL set the server state to `ok` with that level and the `version` string. (src: app/src/version.ts:41-42)
- **CONN-032** When `/health` answers 2xx without a numeric `api_level` (servers before v0.5.1 answer plain `ok`), the system SHALL set the state to `legacy` with level 6. (src: app/src/version.ts:21-22, 43; comment: app/src/version.ts:21)
- **CONN-033** When `/health` fails, times out or answers non-2xx, the system SHALL set the state to `unreachable` and keep the previously known version and level. (src: app/src/version.ts:44-46)
- **CONN-034** When no `apiUrl` is configured, `checkServer()` SHALL return the current info without a request. (src: app/src/version.ts:33)
- **CONN-035** When `lacks(feature)` is called, the system SHALL return true only if the server level is known and lower than the feature's level: `chargePower` 4, `costs` 5, `report` 6, `journeys` 8, `dismiss` 9, `paging` 10, `journey2` 11, `insights` 12, `push` 13, `tmHealth` 14, `devices` 15. With an unknown level it SHALL return false. (src: app/src/version.ts:10, 51-52; comment: app/src/version.ts:51; src: api/src/main.rs:300-303)
- **CONN-036** When `featureText(feature)` or `tooOldText(level)` is called, the system SHALL return "The server is updating or too old (server <have>, needs v<release>+). …", where the release comes from the level→release table (3→0.3.1 … 15→0.14.0). (src: app/src/version.ts:13, 53-56; src: app/src/locales/en.ts:151)
- **CONN-037** When `globalBanner()` is called, the system SHALL return the "updating or unreachable" text for state `unreachable`, the too-old text for state `ok` with a level below 3, and `null` otherwise. (src: app/src/version.ts:57-62; src: app/src/locales/en.ts:151-152)
- **CONN-038** When `serverLabel()` is called, the system SHALL return `v<version> (API level <level>)` for `ok`, the legacy text for `legacy`, "unreachable" for `unreachable` and the checking text otherwise. (src: app/src/version.ts:63-66; src: app/src/locales/en.ts:149-154, 448)
- **CONN-039** When an `api()` call dispatches `drivelens-server-error` and no check ran in the last 10 s, the app SHALL re-check the server and show the too-old banner for level 7 if the server turns out to be `legacy`. When the window gains focus more than 5 minutes after the last such check, it SHALL re-check the server. (src: app/src/main.ts:881-886)

### 3.4 URL privacy guard
- **CONN-040** When the app loads, the system SHALL run the URL guard before any other app module code. (src: app/src/main.ts:14; comment: app/src/urlguard.ts:2)
- **CONN-041** When the page address has query parameters, or a hash containing `=` with parameters, named `api`, `token` or `key` (case-insensitive), the system SHALL remove exactly those parameters from the address with `history.replaceState`, keep the other parameters, the path and the history state, and never read or save their values. (src: app/src/urlguard.ts:6-18; comment: app/src/urlguard.ts:3-5; doc: CHANGELOG.md v1.1.1)
- **CONN-042** When the server URL or token is needed, the system SHALL NOT take it from the page address. (comment: app/src/main.ts:933; doc: CHANGELOG.md v1.1.1)

### 3.5 Connection test (`testConnection`)
- **CONN-050** When a server URL is entered, the system SHALL normalize it by trimming, removing trailing slashes, adding `https://` when no scheme is given, and removing a trailing `/health` or `/api` (case-insensitive). (src: app/src/setup.ts:20-25)
- **CONN-051** When the input in the credential field, trimmed, matches `^[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4}$`, the system SHALL treat it as a pairing code; otherwise as the server token. (src: app/src/auth.ts:22-24, app/src/setup.ts:45; comment: app/src/auth.ts:22)
- **CONN-052** When the URL is empty, unparsable, or not `http:`/`https:`, or when both the credential field and the saved credentials are empty, the system SHALL fail with the matching message (`su.noUrl`, `su.badUrl`, `su.scheme`, `su.noToken`) before any request. (src: app/src/setup.ts:49-53; src: app/src/locales/en.ts:157-160)
- **CONN-053** When the server URL is `http:` and the app page is served over `https:`, the system SHALL fail with the mixed-content message. (src: app/src/setup.ts:59; src: app/src/locales/en.ts:161)
- **CONN-054** When the server URL is `http:` to a host that is not local (localhost, RFC 1918, 100.64/10, link-local, loopback, IPv6 ULA/link-local, `*.ts.net`, `*.local`, `*.lan`, `*.home.arpa`, `*.internal`, or a name without a dot), the system SHALL fail on Android and otherwise add the plain-http warning; for a local http host it SHALL add the LAN warning. (src: app/src/setup.ts:56-63; src: app/src/locales/en.ts:162, 192-193)
- **CONN-055** When the owner key (not a pairing code and not a device token) is shorter than 32 characters, the system SHALL add a "token is only N characters" warning; when it is 32+ characters but has fewer than 10 distinct characters, a repeated-characters warning. (src: app/src/setup.ts:27-32, 46-47; src: app/src/locales/en.ts:155-156)
- **CONN-056** When testing, the system SHALL first request `GET <url>/health` with an 8 s timeout and without HTTP cache. (src: app/src/setup.ts:34-37, 66-67)
- **CONN-057** When that request times out, the system SHALL fail with the timeout message naming the host. When it fails otherwise in the web app, the system SHALL report "offline" if the browser is offline, else send an opaque `no-cors` probe to `/health` (6 s timeout) and report a CORS problem if the probe completes, a timeout if it aborts, or "can't reach" otherwise. In the Tauri app it SHALL report "can't reach" with an http- or https-specific hint. (src: app/src/setup.ts:68-74, 132-145; comment: app/src/setup.ts:132-135; src: app/src/locales/en.ts:163-165, 450-452)
- **CONN-058** When `/health` answers 404, the system SHALL fail with "There's no DriveLens API at this address"; for a non-2xx status ≥ 500 with the server-error message; for other non-2xx statuses with the `/health returned HTTP <s>` message. (src: app/src/setup.ts:76-77; src: app/src/locales/en.ts:166-168)
- **CONN-059** When `/health` answers 2xx but not JSON with a numeric `api_level`, the system SHALL fail with "too old (before v0.5.1)" if the body is `ok`, else with "This address isn't a DriveLens API". (src: app/src/setup.ts:78-83; src: app/src/locales/en.ts:169-170)
- **CONN-060** When the server's `api_level` is below 3, the system SHALL fail with the "server is too old" message; when it is below the newest level the app knows (15), it SHALL add a warning recommending server v0.14.1 (`LATEST_SERVER`). (src: app/src/setup.ts:13-14, 84-85; src: app/src/locales/en.ts:171-172)
- **CONN-061** When a pairing code is entered and the server level is below 15, the system SHALL fail with "doesn't support pairing codes yet". (src: app/src/setup.ts:91; src: app/src/locales/en.ts:503)
- **CONN-062** When a pairing code is entered and the server level is 15 or higher, the system SHALL `POST /api/auth/pair` without `Authorization`, with the code trimmed, upper-cased and inner whitespace replaced by `-`, and a default device name; on success it SHALL use the returned device token. (src: app/src/auth.ts:65-67, app/src/setup.ts:92)
- **CONN-063** When the server token is entered and the server level is 15 or higher, the system SHALL `POST /api/auth/devices` with the token as bearer and a default device name, and on success use the returned device token instead of the server token. (src: app/src/auth.ts:62-64, app/src/setup.ts:94-95; comment: app/src/setup.ts:16, 87; doc: docs/install.md "6. Connect the web app")
- **CONN-064** When that exchange fails with 503 `device_auth_unavailable`, the system SHALL keep the server token as the credential with `tokenKind` `"owner"`. (src: app/src/setup.ts:96-98; comment: app/src/setup.ts:97)
- **CONN-065** When the server level is below 15, the system SHALL use the server token as the credential without a `tokenKind`. (src: app/src/setup.ts:101)
- **CONN-066** When a pairing or exchange call fails, the system SHALL report: a network message for no response; the pairing or token rate-limit message for 429/`rate_limited`; the invalid-code message for `invalid_code`; the device-limit message for `too_many_devices`; the "device auth isn't available" message for `device_auth_unavailable`; the wrong-token message for 401; else the generic "loading cars failed (HTTP …)" message. (src: app/src/setup.ts:120-130, app/src/auth.ts:51-61; src: app/src/locales/en.ts:174-176, 504-507)
- **CONN-067** When credentials are obtained, the system SHALL check them with `GET <url>/api/cars` (bearer, 8 s timeout) and fail with: a header/CORS hint on a network error; the device-specific or server-token 401 message on 401; the rate-limit message on 429; the pair-only message on 403 `owner_key_pair_only`; the "loading cars failed" message on other errors. (src: app/src/setup.ts:104-113; src: app/src/locales/en.ts:173-176, 453, 508-509)
- **CONN-068** When the check succeeds, the system SHALL report "Connected: server v<version>, N cars found" (or the no-cars variant) and, for a new device, "Connected as “<name>”." with "(read-only)" for a read device. (src: app/src/setup.ts:114-117; src: app/src/locales/en.ts:177-178, 510-511)
- **CONN-069** When a default device name is needed, the system SHALL build `<OS> · <browser>` from the user agent (OS: iPhone, iPad, Android, ChromeOS, Windows, Mac, Linux; browser: Edge, Opera, Samsung Internet, Firefox, Chrome, Safari), use `DriveLens` instead of the browser in the Tauri app, and fall back to "Browser". (src: app/src/auth.ts:77-85; src: app/src/locales/en.ts:524)

### 3.6 First-run setup wizard
- **CONN-070** When the app starts without a saved `apiUrl`, the system SHALL show the full-screen setup wizard, with the notice stored in `sessionStorage["drivelens-left-notice"]` (if any) shown once and then removed. (src: app/src/main.ts:956-958, app/src/setup.ts:152-161)
- **CONN-071** When the wizard is shown, it SHALL offer a language selector (Auto, 中文, English, 日本語), a link to the install guide, the server URL field, a password-type field for "Pairing code or server token", a "Show what I typed" checkbox, the "Test connection & start" button and a "Try demo" button; in the web app it SHALL also show the https and CORS requirements. (src: app/src/setup.ts:156-177; src: app/src/locales/en.ts:179-193, 454-458, 500-502)
- **CONN-072** When the language is changed in the wizard, the system SHALL save the new `uiLang`, keep what was typed in `sessionStorage["drivelens-setup-draft"]`, reload the page, restore the two fields from the draft and delete the draft. (src: app/src/setup.ts:180-190)
- **CONN-073** When "Test connection & start" succeeds, the system SHALL save the connection, clear the credential field, re-check the server and leave the wizard after 0.9 s, or, if there are warnings, show them and wait for a "Continue" tap. When the test fails, it SHALL show the error and warnings and save nothing. (src: app/src/setup.ts:193-207)
- **CONN-074** When the connection is saved after setup, the app SHALL start the server check followed by `initDeviceAuth`, load the cars and show Home. (src: app/src/main.ts:955-958)

### 3.7 Settings › Server
- **CONN-080** When Settings › Server is saved with an empty credential field and a URL that differs from the saved one, the system SHALL show "When changing the server address, also enter a pairing code or token for the new server" and change nothing. (src: app/src/main.ts:481-482; src: app/src/locales/en.ts:514)
- **CONN-081** When Settings › Server is saved with an empty credential field and the same URL, the system SHALL re-test the saved credentials without creating a new device. (src: app/src/main.ts:483, app/src/setup.ts:89; doc: docs/install.md "6. Connect the web app" "leave the code / token field empty to keep the current connection")
- **CONN-082** When the test fails, the system SHALL keep the old settings. (src: app/src/main.ts:485; comment: app/src/main.ts:485)
- **CONN-083** When the test succeeds with a newly typed credential that produced a different token, and the old connection used a device token, the system SHALL try to disconnect the old device on the old server first: `GET <old>/health` and, if its `api_level` ≥ 15, `DELETE <old>/api/auth/devices/current` with the old token, each with a 3 s timeout, ignoring all failures. (src: app/src/main.ts:487-488, app/src/auth.ts:106-123; comment: app/src/auth.ts:106-110)
- **CONN-084** When a new connection is saved and its URL differs from the saved one, the system SHALL first delete this server's cached data: every `localStorage` key that starts with `drivelens-home-` or `drivelens-list-`, and `drivelens-last-car`. (src: app/src/auth.ts:87-104; doc: CHANGELOG.md v1.2.0 "Switching to another server clears the old server's cached data")
- **CONN-085** When a new connection is saved, the system SHALL drop `tokenKind`, `deviceId` and `deviceScope` that the new credentials do not set, forget the cached `/api/auth/me` result, re-check the server, run `initDeviceAuth`, re-render Settings and reload the car list. (src: app/src/auth.ts:97-104, app/src/main.ts:489-491)
- **CONN-086** When Settings › Server is rendered, the system SHALL NOT show the saved token; the credential field SHALL be empty with the placeholder "Only fill in to change the connection" when a server is saved. (src: app/src/main.ts:364; src: app/src/locales/en.ts:513; doc: CHANGELOG.md v1.2.0)
- **CONN-087** When Settings › Server is rendered, the compact status row SHALL show a dot and text for "Connected" (state `ok` or `legacy`), "Can't connect" (`unreachable`), "Not set" (no URL or token) or checking, the host and the server version, and SHALL expand automatically when the state is "Can't connect" or "Not set" unless the user toggled it. In demo mode only the version line is shown. (src: app/src/main.ts:346-400; src: app/src/locales/en.ts:52-60)
- **CONN-088** When the device identity is known, the Server card SHALL show "This device: <name>" with " · Read-only" for a read device, "This device: …" while a saved device token's identity is not yet known, and nothing for an owner key. (src: app/src/devices.ts:217-222, app/src/main.ts:363, 879; src: app/src/locales/en.ts:518-519)

### 3.8 Device identity and automatic migration
- **CONN-090** When the app starts and the server level is 15 or higher with saved credentials, the system SHALL call `GET /api/auth/me`; if the saved credential is not marked as a device token (and not in demo mode), it SHALL run the automatic migration instead. (src: app/src/auth.ts:172-179, app/src/main.ts:955)
- **CONN-091** When `/api/auth/me` reports a device that differs from the saved `deviceId`, `deviceScope` or `tokenKind`, the system SHALL update the saved values and notify `onMeChange` listeners. (src: app/src/auth.ts:33-42)
- **CONN-092** When the automatic migration runs with a saved server token, the system SHALL call `GET /api/auth/me`; if the server has device auth it SHALL exchange the token via `POST /api/auth/devices` with a default device name and, only if the saved URL and token are unchanged, replace the saved token with the device token, `tokenKind` `"device"`, `deviceId` and `deviceScope`. If the server has no device auth, it SHALL mark the token as `"owner"`. (src: app/src/auth.ts:151-171; doc: CHANGELOG.md v1.2.0 "Automatic switch"; doc: docs/install.md "6. Connect the web app")
- **CONN-093** When the automatic migration fails, the system SHALL stay silent and try again on the next start. (src: app/src/auth.ts:152, 167-170; comment: app/src/auth.ts:152)
- **CONN-094** When `navigator.locks` is available, the system SHALL run the migration inside the Web Lock `drivelens-upgrade` and re-read the settings inside it, so two tabs do not both exchange the token. (src: app/src/auth.ts:155-156, 168-169; comment: app/src/auth.ts:156)
- **CONN-095** When the server level is below 15, the system SHALL forget any cached identity and SHALL NOT call `/api/auth/*`. (src: app/src/auth.ts:154, 174)
- **CONN-096** When `canWrite()` is asked, the system SHALL return true in demo mode; false when the known identity is a read-scope device; otherwise false only when the saved `deviceScope` is `"read"`. (src: app/src/auth.ts:43-48; comment: app/src/api.ts:10)

### 3.9 Settings › Devices
- **CONN-100** When Settings is shown, the system SHALL show the Devices card only if the server does not lack `devices`, a URL and token are saved, `/api/auth/me` reports `device_auth: true`, and the caller is not a read-only device; otherwise the card SHALL be empty. (src: app/src/devices.ts:147-157, 160-164, 201)
- **CONN-101** When the Devices card is shown, it SHALL list each device returned by `GET /api/auth/devices` with its name, a "This device" tag for the current one, a "Read-only" tag for read devices, and a line with "Last used <relative time>" or "Not used yet", the last IP address and "Expires <date>" when set; until the list arrives it SHALL show two skeleton rows. (src: app/src/devices.ts:135-145, 162-172; src: app/src/locales/en.ts:517-522)
- **CONN-102** When the caller is a device and at least one other device exists, the card SHALL offer "Disconnect all other devices"; after confirmation it SHALL call `DELETE /api/auth/devices?except=current` and show "Disconnected N devices". With the owner key this button SHALL NOT be shown. (src: app/src/devices.ts:169, 179-184; src: app/src/locales/en.ts:552-555)
- **CONN-103** When "Rename" is chosen from a row's ⋯ menu, the system SHALL show a sheet with the name (max 60 characters), refuse an empty name, and send `PATCH /api/auth/devices/current` for this device or `PATCH /api/auth/devices/{id}` for others, then reload the list (and the identity for this device). (src: app/src/devices.ts:32-54, 187-192)
- **CONN-104** When "Disconnect" is chosen for another device and confirmed, the system SHALL call `DELETE /api/auth/devices/{id}` and remove the row; on error it SHALL show the error in the card. (src: app/src/devices.ts:194-197; src: app/src/locales/en.ts:549-551)
- **CONN-105** When the ⋯ menu is opened on the current device, its second item SHALL be "Sign out of this device" and SHALL run the sign-out flow (3.10). (src: app/src/devices.ts:187, 193)
- **CONN-106** When "Add device" is tapped, the system SHALL show a sheet with a Full access / Read-only choice; for Read-only it SHALL show an expiry choice of 7 days, 30 days (default) or Never. "Create pairing code" SHALL call `POST /api/auth/pairings` with `{scope}` or, for read-only with an expiry, `{scope, device_ttl_days}`. (src: app/src/devices.ts:56-101, app/src/auth.ts:74-75; src: app/src/locales/en.ts:525-535; doc: docs/install.md "Managing devices")
- **CONN-107** When a code is issued, the sheet SHALL show the code, its access level, a countdown from the local clock (the server's remaining time when it is between 0 and 10 minutes, else 10 minutes), and the three steps to use it; at zero it SHALL mark the code expired and offer "New code". (src: app/src/devices.ts:105-116; comment: app/src/devices.ts:108; src: app/src/locales/en.ts:536-545)
- **CONN-108** When a code is shown outside demo mode, the system SHALL poll `GET /api/auth/devices` every 4 s and, when a device id not in the list at opening appears, stop the countdown, show "“<name>” is connected" and reload the device list. (src: app/src/devices.ts:117-126; src: app/src/locales/en.ts:546)
- **CONN-109** When the Add-device sheet is closed, the system SHALL stop the countdown and polling. (src: app/src/devices.ts:88-91)

### 3.10 Sign-out and revocation
- **CONN-110** When Settings is shown with a saved connection (or in demo mode), the system SHALL show a "Sign out of this device" card. (src: app/src/devices.ts:206-212; src: app/src/locales/en.ts:556-558)
- **CONN-111** When sign-out is confirmed in demo mode, the system SHALL only leave the demo. (src: app/src/auth.ts:142; src: app/src/locales/en.ts:560)
- **CONN-112** When sign-out is confirmed with a device token, the system SHALL first remove the push subscription while the token still works, then call `DELETE /api/auth/devices/current`, ignoring errors of both. (src: app/src/auth.ts:140-147; doc: SECURITY.md "Revoking and signing out"; doc: docs/install.md "6. Connect the web app")
- **CONN-113** When this device forgets its server (sign-out or revocation), the system SHALL, in this order: mark itself as leaving, delete the server caches (CONN-084 keys), delete `tokenKind`, `deviceId`, `deviceScope`, set `apiUrl` and `token` to `""`, forget the cached identity, and then try to remove the browser push subscription for at most 1.5 s. Display settings SHALL stay. (src: app/src/auth.ts:128-139; comment: app/src/auth.ts:131)
- **CONN-114** When sign-out finishes, the app SHALL reload the page at its path without query, which opens the setup wizard. (src: app/src/devices.ts:193, 215, app/src/main.ts:870-874)
- **CONN-115** When `drivelens-signed-out` is dispatched, outside demo mode and while not already leaving, the app SHALL forget the server (CONN-113) and reload into the setup wizard with the notice "This device was disconnected (from another device, or it expired). …". (src: app/src/main.ts:875-878; src: app/src/locales/en.ts:562; doc: SECURITY.md "Revoking and signing out")

### 3.11 Currency helpers hosted in `api.ts`
- **CONN-120** When a default currency is needed, the system SHALL use the saved `currency`, else derive it from the device locale's region (JP, CN, US, HK, TW, KR, GB, AU, CA, SG, CH, euro-area countries), else from the language (`zh-Hant` → TWD, `ja`, `zh`, `ko`, `de`, `fr`, `it`, `es`, `nl`), else USD. (src: app/src/api.ts:103-115)
- **CONN-121** When an amount is formatted, the system SHALL show `—` for null, use 0 decimals for JPY, KRW and TWD (1 decimal for per-kWh prices) and 2 decimals otherwise, with the currency symbol prefix when known (¥, CN¥, $, €, £, ₩, HK$, NT$, A$, C$, S$) or `<amount> <code>` otherwise. (src: app/src/api.ts:116-126)

## 4. Key design decisions

- **D-1 Credentials live only on the device.** URL and token are stored in `localStorage` and sent only to the user's server in the `Authorization` header, never in a URL; nothing goes to a DriveLens backend. (comment: app/src/auth.ts:3; doc: README.md "Privacy"; doc: SECURITY.md "Privacy promise")
- **D-2 Do not keep the owner key.** With device auth the owner key is exchanged right away and not stored; existing installs migrate silently on the next start. (comment: app/src/setup.ts:16, 87; doc: CHANGELOG.md v1.2.0; doc: docs/install.md "6. Connect the web app")
- **D-3 Only drivelens-api's JSON 401 signs the device out.** A device token cannot be mistyped, so `401 {"error":"unauthorized"}` from the API starts a local sign-out; the check that the saved token is still the one sent protects against races with a server switch. A 401 HTML page from an auth proxy in front (or any 5xx / network error) keeps the connection. (comment: app/src/api.ts:70-72; src: app/src/api.ts:101-103; doc: docs/install.md "Behind an auth proxy")
- **D-4 Local state is cleared before the network.** Sign-out deletes the URL and token first, so no later request can carry the old token; the push unsubscription follows. (comment: app/src/auth.ts:131, 137)
- **D-5 Full reload after leaving a server.** No in-memory data of the old server survives. (comment: app/src/main.ts:870)
- **D-6 Optimistic feature gating.** Entry points are hidden only when the server level is known to be too low; unknown levels are allowed and 404s are handled where they occur. The version check never throws. (comment: app/src/version.ts:2, 51)
- **D-7 Graceful fallback for servers without device auth.** If the server cannot store devices, the app keeps using the owner key as before 0.14.0. (comment: app/src/setup.ts:97; doc: docs/install.md "Managing devices")
- **D-8 Read-only scope is cached.** So read-only devices never briefly show edit controls before `/api/auth/me` answers. (comment: app/src/api.ts:10)
- **D-9 Explain fetch failures.** Browsers hide the cause of a failed fetch; an opaque `no-cors` probe distinguishes "server answered but CORS blocked" from "unreachable". (comment: app/src/setup.ts:132-135)
- **D-10 Server-scoped caches are cleared on server switch, and the old device is disconnected on its own server.** The old token is sent only to the old server's URL. (comment: app/src/auth.ts:96, 106-110; doc: CHANGELOG.md v1.2.0)
- **D-11 One credential field.** Pairing codes and server tokens share one field and are told apart by shape; owner keys are at least 16 characters, codes 8. (comment: app/src/auth.ts:22; doc: CHANGELOG.md v1.2.0 "Setup with a pairing code")
- **D-12 No credentials from the URL.** The legacy `?api=…&token=…` support was removed in 1.1.1; the guard strips such parameters before anything else runs. (comment: app/src/urlguard.ts:2-5; doc: CHANGELOG.md v1.1.1)
- **D-13 Pairing countdown uses the local clock.** The server clock may differ; the countdown is capped at 10 minutes. (comment: app/src/devices.ts:108)
- **D-14 Weak-token hints only for the owner key.** Codes and device tokens are generated by the server. (comment: app/src/setup.ts:47)

## 5. Constraints

- The web app runs on https, so it can only reach an https server; http is allowed in the Tauri apps, and on Android only for local/tailnet hosts. (src: app/src/setup.ts:54-63; doc: docs/install.md "6. Connect the web app")
- Timeouts: `/health` and `/api/cars` in the connection test 8 s, `no-cors` probe 6 s, version check 8 s, old-device revocation 3 s per request, push removal during sign-out 1.5 s. (src: app/src/setup.ts:34, 139; src: app/src/version.ts:35; src: app/src/auth.ts:115, 138)
- Pairing-code format accepted by the field: 4 + 4 alphanumeric characters with an optional `-` or space between. (src: app/src/auth.ts:23)
- Device name in the rename sheet: at most 60 characters (the server enforces 1–60). (src: app/src/devices.ts:36)
- Minimum server: API level 3 (v0.3.1); device features need level 15 (v0.14.0). (src: app/src/version.ts:8, 10, 13)
- Pairing poll interval 4 s; server re-check throttle 10 s after errors, 5 minutes on focus. (src: app/src/devices.ts:126; src: app/src/main.ts:883, 886)
- The server's failure limits apply (10 wrong tokens / 5 wrong codes per 10 minutes). (doc: docs/install.md "6. Connect the web app")

## 6. Non-goals

- Sending the server URL or token anywhere except the user's own server; telemetry, analytics or tracking. (doc: README.md "Privacy"; doc: SECURITY.md "Privacy promise")
- Reading credentials from the page address. (doc: CHANGELOG.md v1.1.1)
- Caching API responses offline (only the app shell is cached). (doc: docs/install.md "6. Connect the web app")
- Showing the saved token again. (doc: CHANGELOG.md v1.2.0)
- Several saved servers or profiles at the same time (confirmed, design: one server per device; switching servers replaces the connection).
- Encrypting the stored token in `localStorage`; on shared computers the user is told to clear the site data (confirmed, design: a browser offers no secret store that a page could use without the key being on the same device; the device token is revocable instead). (src: app/src/locales/en.ts:458)
- Automatic retries of failed API requests (confirmed from code: errors show a Retry button instead).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | The English sign-out confirmation says "…nothing on the server changes" (src: app/src/locales/en.ts:559), but with a device token sign-out calls `DELETE /api/auth/devices/current` (src: app/src/auth.ts:144-147). | SECURITY.md and docs/install.md state that sign-out also disconnects the device on the server. The Japanese and Chinese texts only say the server *data* stays. Likely (text vs. code and docs). | The text says that the device is also disconnected on the server and that server data is not affected. **Review:** real issue, verified at 9b1c39c. **Fixed in v1.2.3:** `dev.signOutText` (en/ja/zh) now says the device is disconnected on the server and its access revoked, local data is removed, and data on the server stays; a new `dev.signOutTextOwner` is shown for owner-key connections, where nothing is revoked. |
| CB-2 | `clearServerCaches()` removes only `drivelens-home-*`, `drivelens-list-*` and `drivelens-last-car` (src: app/src/auth.ts:89-94). Per-car battery values (`drivelens-battery-new-kwh`, `drivelens-battery-kwh-migrated-<id>`, `drivelens-battery-baseline`, src: app/src/insights.ts:28-37, 71-78) and `dismissedDrives` in the settings (src: app/src/journey.ts:404) stay when switching servers or signing out; they are keyed by car id, which can repeat on another server. | demo.ts lists "battery baseline" as per-server UI state (comment: app/src/demo.ts:19), and CHANGELOG v1.2.0 says switching servers clears the old server's cached data. Possible: these may be meant as user settings rather than caches. | Values tied to one server's car ids are cleared or namespaced per server. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: only users who switch servers and reuse a car id are affected. |
| CB-3 | `testConnection` creates the device (pairing or exchange) before the `/api/cars` check; if that check fails, the new token is discarded but the device stays registered on the server, and a pairing code is used up (src: app/src/setup.ts:87-113). | The user sees a failure, yet an unnamed extra device appears in Settings › Devices and counts toward the 50-device limit. Possible (the check rarely fails right after a successful pairing). | A failed check revokes the just-created device (`DELETE /api/auth/devices/current` with the new token), or the token is kept and the user is warned. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: a failed check leaves an extra device in Settings › Devices. |
| CB-4 | For an owner-key connection, `forgetServer()` clears `apiUrl` before calling the push `disable()` (src: app/src/auth.ts:132-138); `disable()` then cannot reach `/api/push/unsubscribe` (`api()` throws "no URL", caught in app/src/notify.ts:87) and only unsubscribes in the browser. The server row stays until a later delivery fails with 404/410. | The comment says "the server already dropped it with the device" (comment: app/src/auth.ts:137), which holds only for device tokens. Likely, low impact. | For an owner key, unsubscribe on the server before clearing the connection, as `signOut()` does for device tokens. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor and self-healing: the server row is removed on the next delivery (404/410 after the browser unsubscribed). |
