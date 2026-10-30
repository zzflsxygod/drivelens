# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: go to the repository's **Security** tab → **Report a vulnerability** (a [private security advisory](https://github.com/zzflsxygod/drivelens/security/advisories/new)). Please include:

- what is affected (drivelens-api, the web app, or both) and which version
- steps to reproduce or a proof of concept
- the impact you expect

You should get a first reply within a few days. Once a fix is released, the advisory will be published, with credit to you if you want it.

## Supported versions

Only the latest release is supported. drivelens-api is normally kept up to date automatically (Watchtower), and the official web app at [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) always runs the latest version.

## Privacy promise

- DriveLens **never sends your server URL or your API token anywhere except your own server.** They are stored only on your device (in the browser's localStorage) and are only used for requests to the server you entered. They are never put in URLs, and DriveLens will not add features that share them with anyone else.
- **No telemetry, analytics or tracking.** DriveLens does not collect usage data, crash reports or identifiers.
- **Device tokens (drivelens-api 0.14.0+):** each device gets its own random token (`dlt_…`, 256 bits). The server stores only its SHA-256 hash; apps 1.2.0+ exchange the server token (`API_TOKEN`) for a device token and do not keep it. Pairing codes are short-lived (10 minutes), single use, stored only as hashes and rate-limited separately. Tokens and codes are never written to logs.
- **Revoking and signing out:** a device can be disconnected at any time from another device (Settings → Devices, or `DELETE /api/auth/devices/:id`); this takes effect immediately and also removes its push subscriptions. The disconnected app returns to the setup screen and deletes its saved token and cached data. **Settings → Sign out of this device** does the same on purpose (and disconnects the device on the server). Read-only devices can view data but cannot change anything except their own notification settings and name, or disconnect themselves (Sign out of this device).
- Your TeslaMate data stays on your server. The app requests it directly from your drivelens-api; there is no DriveLens backend in between.
- The only third-party requests the app makes are for map tiles (OpenFreeMap, falling back to OpenStreetMap).
- Your own drivelens-api fetches weather for your drives from Open-Meteo using coordinates rounded to 0.1° (about 10 km) and dates; no token or identifier is sent. Web push notifications are sent by your own server through your browser's push service (for example Google, Apple or Mozilla) and are encrypted end to end.
- drivelens-api only has read access to TeslaMate's tables and never modifies them.

## Scope notes

drivelens-api is designed to run behind HTTPS (Cloudflare Tunnel, Tailscale Serve or a reverse proxy) and to be protected by a long random server token (`API_TOKEN`) and per-device tokens. With `DRIVELENS_OWNER_KEY_MODE=pair-only` the server token only works for device management and is not evaluated while a client is over the failure limit. Problems that require an attacker to already have the server token or a valid device token, or that come from exposing PostgreSQL or the API over plain HTTP against the install guide, are generally out of scope, but reports are still welcome.
