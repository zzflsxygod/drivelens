# DriveLens install guide

**English** · [中文](install.zh.md) · [日本語](install.ja.md)

DriveLens has two parts:

- **drivelens-api**, a small Docker container next to TeslaMate on your server. It reads the TeslaMate database through a read-only account.
- **The DriveLens web app** at **[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)**. You connect it once with your server address and the server token, or with a pairing code from a device that is already connected.

> DriveLens **never modifies TeslaMate's tables**. Its database account can only read them. DriveLens' own data (place names, manual charging costs, journeys, covers, push subscriptions, weather cache, connected devices) lives in a separate `drivelens` schema.

Contents: [Requirements](#requirements) · [1. Files](#1-download-two-files) · [2. Password and token](#2-create-a-password-and-a-token) · [3. Database account](#3-create-the-database-account-once) · [4. Start](#4-start-drivelens-api) · [5. https](#5-give-the-server-an-https-address) · [6. Connect](#6-connect-the-web-app) · [Devices](#devices) · [7. Notifications](#7-notifications) · [8. Updates](#8-updates) · [Reference](#environment-variables) · [Troubleshooting](#troubleshooting) · [Uninstall](#uninstall) · [Appendix: LAN only](#lan-selfhost) · [Auth proxy (unofficial)](#auth-proxy)

## Requirements

- TeslaMate running with Docker Compose (the official `docker-compose.yml`: the database service is called `database`, the database and its admin user are `teslamate`).
- An x86_64 or ARM64 server (a Raspberry Pi works). The image `ghcr.io/zzflsxygod/drivelens-api` is published for linux/amd64 and linux/arm64.
- A way to reach the server over **https**: Cloudflare Tunnel (you need a domain on Cloudflare) or Tailscale (no domain needed). See step 5.

## 1. Download two files

In TeslaMate's compose directory:

```bash
cd teslamate   # the directory with TeslaMate's docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/docker-compose.drivelens.yml
```

```
teslamate/
├── docker-compose.yml               # TeslaMate's file (unchanged)
├── docker-compose.drivelens.yml     # the drivelens-api service
├── setup.sql                        # one-time database setup
└── .env
```

## 2. Create a password and a token

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS`: the password of the read-only database account `drivelens_ro`.
- `DRIVELENS_API_TOKEN`: the token you enter in the app. The API refuses to start with fewer than 16 characters and logs a warning below 32 characters or for simple tokens. Use a random one like the command above.

## 3. Create the database account (once)

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
```

[`setup.sql`](../deploy/setup.sql) is safe to run again (it then only updates the password). It:

1. creates the login role `drivelens_ro`;
2. grants **SELECT** on TeslaMate's tables, including tables that future TeslaMate upgrades add;
3. grants REFERENCES on `cars`, `addresses`, `drives` and `charging_processes`, so DriveLens tables can point to them with foreign keys and DriveLens data is cleaned up when TeslaMate deletes a drive (this is not write access);
4. creates the `drivelens` schema and grants `drivelens_ro` `USAGE` and `CREATE` on it (also when the schema already exists);
5. makes `drivelens_ro` the owner of DriveLens tables that an admin created with older SQL files (only tables in the `drivelens` schema).

It does not create, change or delete anything in TeslaMate's tables. On every start the API creates and upgrades its own tables in the `drivelens` schema; no further SQL is ever needed.

> Different database name or admin user? Change `-U` / `-d` above and add `DRIVELENS_DB_NAME=yourdb` to `.env`.

## 4. Start drivelens-api

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

The log should show:

```
INFO drivelens_api: all features enabled (API level 16)
INFO drivelens_api: listening on 0.0.0.0:8080
```

If it shows `disabled features: …` or `cannot read TeslaMate tables`, step 3 did not work: run `setup.sql` again, then `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api`.

Check on the server: `curl http://127.0.0.1:8080/health` returns `{"status":"ok","version":"…","api_level":16}`.

By default the compose file publishes the API on `127.0.0.1:8080` only, so it is not reachable from other machines. **Don't expose port 8080 to the internet**; use one of the https options below.

## 5. Give the server an https address

The web app is served over https, so browsers block `http://` server addresses (mixed content), **including LAN and Tailscale IPs** such as `http://192.168.x.x:8080` or `http://100.x.y.z:8080`. Pick one option:

> LAN-only over http (self-hosting the web app, unofficial): see [Appendix: LAN-only use](#lan-selfhost).

<a id="cloudflare-tunnel"></a>
### Option A: Cloudflare Tunnel (you have a domain on Cloudflare)

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token.
2. Either run cloudflared in the same compose project: uncomment the `cloudflared` service in `docker-compose.drivelens.yml`, add `CLOUDFLARE_TUNNEL_TOKEN=…` to `.env`, and start it with `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d cloudflared`. You can then remove the `ports:` lines from `drivelens-api`.
   Or use cloudflared already installed on the host.
3. Add a public hostname, e.g. `drivelens.your-domain`, with the service `http://drivelens-api:8080` (cloudflared in compose) or `http://127.0.0.1:8080` (cloudflared on the host).
4. Your server address is `https://drivelens.your-domain`.

When you use the **official web app** ([https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)), don't put a login page such as Cloudflare Access in front of the API: that app is on a different origin, so the browser would not send the Access cookie with API requests and they would be blocked. The API is protected by the token. **Same-origin self-hosting** (web app and API on one host) is different — see [Behind an auth proxy](#auth-proxy) (unofficial, untested).

<a id="tailscale"></a>
### Option B: Tailscale (no domain, private to your devices)

`tailscale serve` gives the server an https address that only devices in your tailnet can reach:

1. Install Tailscale on the server (the normal host install) and on your phone / computer, signed in to the same tailnet.
2. In the Tailscale admin console → [DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates** (once per tailnet).
3. On the server run:
   ```bash
   sudo tailscale serve --bg 8080
   ```
   This forwards `https://<machine>.<tailnet>.ts.net` to `http://127.0.0.1:8080` and keeps running after reboots. `tailscale serve status` shows the address. Keep the compose file's default `127.0.0.1:8080:8080`. The first request can take a few seconds while the certificate is issued.
4. Your server address is `https://<machine>.<tailnet>.ts.net` (no port). The device you use DriveLens on must be connected to Tailscale.

Notes:

- No CORS setting is needed: the API allows the official web app by default. The server's own address never goes into `DRIVELENS_CORS_ORIGINS`.
- Chrome / Edge may ask to let the site *access devices on your local network* (the ts.net name points to a 100.x address). Choose **Allow**. If you blocked it, allow it again in the site settings (icon left of the address bar).
- The certificate puts the machine name (`<machine>.<tailnet>.ts.net`) into the public Certificate Transparency logs. Rename the machine first if that matters to you.
- To stop: `sudo tailscale serve --https=443 off`.

## 6. Connect the web app

1. Open **[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)** (or try the demo first from the welcome screen).
2. Enter the **server URL** from step 5 and, in the second field, either
   - the **server token** (`DRIVELENS_API_TOKEN` from `.env`), or
   - a **pairing code** such as `7KQ2-M9XD` from a device that is already connected (Settings → Devices → Add device, see [Managing devices](#devices)).
3. Tap **Test connection & start**. The app checks `/health`, then loads your cars.

With drivelens-api 0.14.0 or later the app exchanges the server token for a token of its own for this device (a *device token*) and does not keep the server token. Apps 1.2.0+ that saved the server token earlier switch to a device token by themselves on the next start.

| Message | What to do |
| --- | --- |
| Wrong token (401) | Copy `DRIVELENS_API_TOKEN` again, without spaces or quotes |
| The browser blocks http server addresses | Use an https address (step 5) |
| Can't reach / timed out | Check the address, that the tunnel or Tailscale is running and that the certificate is valid |
| Isn't a DriveLens API | You entered the TeslaMate or Grafana address; use the drivelens-api address |
| Server does not allow this site (CORS) | Update drivelens-api; if you set `DRIVELENS_CORS_ORIGINS`, include `https://drivelens-app.oharuru.com`, pass it through the compose `environment:` line, and recreate the container |
| Server is too old | Update drivelens-api (step 8) |
| Pairing code is wrong or no longer valid | Codes work once within 10 minutes. Create a new one on a connected device |
| Update the server to v0.14.0 or later (pairing code) | The server is older than 0.14.0: update drivelens-api (step 8) or connect with the server token |
| Too many wrong tokens (429) | After 10 failed attempts within 10 minutes the server answers 429 for a while; wait 10 minutes. Devices that are already connected keep working |

You can change the server later in Settings → Server (leave the code / token field empty to keep the current connection). Language, theme, map label language and default currency are in Settings too.

**Install to the home screen:** on Android and desktop Chrome / Edge use "Install as an app" in Settings or the browser menu → Install. On iPhone / iPad (Safari): Share → Add to Home Screen.

The server address and this device's token are stored only in this browser's local storage and are sent only to your server, always in a request header (never in a URL). **Settings → Sign out of this device** removes them together with the cached data and the notification subscription (with a device token it is also disconnected on the server). The offline cache holds only the app itself; API responses are never cached.

### Managing devices <a id="devices"></a>

With drivelens-api 0.14.0+ and app 1.2.0+ every phone, tablet or browser has its own device token. **Settings → Devices** lists them with the last use and address; ⋯ on a row renames or disconnects it.

- **Add a device without the server token:** tap **Add device**, choose **Full access** or **Read-only** (read-only devices can expire after 7 or 30 days, or never), then **Create pairing code**. On the new device enter the server address and the code. A code is valid for 10 minutes and works once.
- **Read-only** devices can see everything but cannot rename places, edit charging costs or journeys, or manage devices. Good for family members or a car screen.
- **Lost a phone?** Disconnect it from another device. It is signed out on its next request and its cached data is removed.
- **Disconnect all other devices** signs out everything except the device you are using.
- **Change the server token** (if it may have leaked): put a new `DRIVELENS_API_TOKEN` into `.env` and run `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api`. Devices with a device token stay connected. Only apps older than 1.2.0, which still use the server token, need the new one.
- Optional hardening: set `DRIVELENS_OWNER_KEY_MODE=pair-only` in `.env`, uncomment the matching line under `environment:` in `docker-compose.drivelens.yml`, and recreate the container (see [Environment variables](#environment-variables)). That makes the server token usable only for adding and managing devices.

The device list needs `CREATE` on the `drivelens` schema and DriveLens tables owned by `drivelens_ro` (`deploy/setup.sql` sets this up). Without it the API logs `device auth disabled` and everything keeps working with the server token as before; see [Upgrading to 0.14.0](#upgrading-to-0140) for the one-time fix.

## 7. Notifications

Settings → Notifications turns on push notifications for the current device: a **trip summary** when a drive ends (distance, time, energy, from → to) and a **monthly report** reminder on the 1st (from 9:00 in the device's time zone). Each can be switched off; tapping a notification opens the trip or report.

- Your server checks TeslaMate for finished drives every minute and sends the notification itself, end-to-end encrypted, through the browser's push service (Google, Apple or Mozilla). The container needs outbound https access to them.
- No setup needed: the signing key (VAPID) is generated on first start and stored in the `drivelens` schema. If it is lost (e.g. a new database), turn notifications on again on each device.
- iPhone / iPad: iOS 16.4 or later, with DriveLens added to the Home Screen and opened from there.
- Android / desktop: Chrome, Edge or Firefox. If notifications were blocked, allow them in the site settings.

## 8. Updates

**Automatic (recommended):** uncomment the `watchtower` service at the end of `docker-compose.drivelens.yml` and start it with `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d watchtower`. It checks every 6 hours and only updates containers labelled `com.centurylinklabs.watchtower.enable=true`, which is only drivelens-api; TeslaMate, its database and Grafana are left alone.

**Manual:**

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

The API upgrades its own tables on start. To stay on a version, set e.g. `DRIVELENS_IMAGE=ghcr.io/zzflsxygod/drivelens-api:v1.1.1` in `.env`. Release notes: [Releases](https://github.com/zzflsxygod/drivelens/releases). The web app always runs the latest version and tells you when the server should be updated.

### Upgrading to 0.14.0

If your server was set up with the older SQL files (or `setup.sql` from before 0.14.0), the `drivelens` schema and tables may belong to the TeslaMate admin and `drivelens_ro` may lack `CREATE` on the schema. Then device auth stays off (the log shows `device auth disabled`); everything else keeps working with the server token. Fix it once: download the current `setup.sql` and run step 3 again, or run just these two statements, then restart and check the log:

```bash
docker compose exec -T database psql -U teslamate -d teslamate <<'SQL'
GRANT USAGE, CREATE ON SCHEMA drivelens TO drivelens_ro;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'drivelens' AND tableowner <> 'drivelens_ro' LOOP
    EXECUTE format('ALTER TABLE drivelens.%I OWNER TO drivelens_ro', t);
  END LOOP;
END $$;
SQL
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api | grep 'device auth'
```

The log should now show `device auth enabled: N device(s)`.

## Environment variables

Read by drivelens-api:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:…@database:5432/teslamate`; the compose file builds it from `.env` |
| `API_TOKEN` | ✅ | The server token (owner key): signs in a device for the first time and manages devices (16+ characters, 32+ random characters recommended); the compose file takes it from `DRIVELENS_API_TOKEN` |
| `DRIVELENS_OWNER_KEY_MODE` | | `full` (default): the server token works for every request, as before. `pair-only`: the server token only works for adding and managing devices (`/api/auth/*`, anything else answers 403 `owner_key_pair_only`), and after too many failures it is not even checked until the 10-minute window ends — guessing it becomes useless while your devices keep working. Needs device auth; otherwise the API falls back to `full` and logs an error. With the compose file: set it in `.env` **and** uncomment `- DRIVELENS_OWNER_KEY_MODE=${DRIVELENS_OWNER_KEY_MODE}` under `environment:` |
| `BIND_ADDR` | | Listen address; `0.0.0.0:8080` in the image |
| `DRIVELENS_CORS_ORIGINS` | | Comma-separated web origins allowed to call the API from a browser; `*` = any. Default: the official web app only (plus the origins of the paused native apps). The older name `CORS_ORIGINS` also works. With the compose file: set it in `.env` **and** uncomment `- DRIVELENS_CORS_ORIGINS=${DRIVELENS_CORS_ORIGINS}` under `environment:` (leaving it commented keeps the default; an empty value would clear it) |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | Push signing key (base64url P-256). Normally unset: generated on first start and kept in the database |
| `DRIVELENS_VAPID_SUBJECT` | | Contact sent to push services (`mailto:you@example.com` or an https URL). Default: the DriveLens project page |
| `DRIVELENS_TRUST_PROXY_HEADERS` | | `true` = for the failed-login limit, take the client address from `CF-Connecting-IP` / `X-Forwarded-For` (only for requests that come from a local/private address, i.e. your tunnel or proxy). Default: off — the connection's own address is used, so behind a tunnel all clients share one limit. Device tokens are always checked, so connected devices are never locked out; in the default mode a correct server token is accepted too |
| `DRIVELENS_PUSH_HOSTS` | | Extra push-service hosts allowed for notifications (comma-separated), for browsers that use their own push server. The push services of Chrome/Edge, Firefox and Safari are always allowed |
| `RUST_LOG` | | Log level, default `info` |

In `.env` (used by `docker-compose.drivelens.yml`): `DRIVELENS_DB_PASS`, `DRIVELENS_API_TOKEN`, optional `DRIVELENS_DB_NAME` (default `teslamate`), `DRIVELENS_IMAGE` (default `ghcr.io/zzflsxygod/drivelens-api:latest`) and `CLOUDFLARE_TUNNEL_TOKEN` (only for the cloudflared service).

Optional variables that the API reads (`DRIVELENS_CORS_ORIGINS`, `DRIVELENS_OWNER_KEY_MODE`, and similarly `DRIVELENS_TRUST_PROXY_HEADERS` / `DRIVELENS_VAPID_*` / `DRIVELENS_PUSH_HOSTS` if you set them) are **not** passed through by default: put the value in `.env`, add or uncomment the matching `- NAME=${NAME}` line under `drivelens-api` → `environment:` in `docker-compose.drivelens.yml`, then run `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api`. Leave those lines commented when unused — an empty value would clear the API default.

## Troubleshooting

- **`password authentication failed for user "drivelens_ro"`**: `DRIVELENS_DB_PASS` differs from the password used with `setup.sql`. Run step 3 again (it updates the password) and restart drivelens-api.
- **`API_TOKEN must be at least 16 characters`** (container keeps restarting) or **`API_TOKEN looks weak`**: create a new token with `openssl rand -hex 24`, put it in `.env`, run `up -d drivelens-api` again and enter it in the app.
- **`cannot read TeslaMate tables`** or **`disabled features: …`**: the database account is incomplete. Run `setup.sql` again (step 3) and restart drivelens-api. With only `disabled features`, drives, charging and reports keep working meanwhile.
- **The setup screen says the server is unreachable**: on the server, `curl http://127.0.0.1:8080/health` must work. Then check the tunnel (`docker compose … logs cloudflared`) or `tailscale serve status`.
- **`/health` works but loading data fails**: a reverse proxy in between must pass the `Authorization` header unchanged.
- **403 `owner_key_pair_only`**: the server runs with `DRIVELENS_OWNER_KEY_MODE=pair-only`, so the server token only adds and manages devices. Apps 1.2.0+ handle this by themselves; for scripts, create a device token with `POST /api/auth/devices` or remove the variable.
- **429 (too many failed attempts)**: 10 failures within 10 minutes from one address. Wait 10 minutes. Connected devices keep working; with `pair-only` the server token is not checked during that time (also after 50 failures from all addresses together).
- **No notifications**: check Settings → Notifications on that device, the browser's notification permission, and that the container can reach the internet over https.

## Uninstall

1. Stop and remove the container:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.drivelens.yml rm -sf drivelens-api
   ```
   (also `cloudflared` / `watchtower` if you enabled them for DriveLens), then delete `docker-compose.drivelens.yml`, `setup.sql` and the `DRIVELENS_*` lines in `.env`.
2. Optionally remove DriveLens' data and account (TeslaMate's data is not touched):
   ```bash
   docker compose exec -T database psql -U teslamate -d teslamate \
     -c "DROP SCHEMA drivelens CASCADE" -c "DROP OWNED BY drivelens_ro" -c "DROP ROLE drivelens_ro"
   ```
3. With Tailscale: `sudo tailscale serve --https=443 off`.

## Feedback

Bugs and feature requests: [Issues](https://github.com/zzflsxygod/drivelens/issues). Please never post your server address or token.

<a id="lan-selfhost"></a>
## Appendix: LAN-only use (self-hosting the web app over http, unofficial)

> ⚠️ **Unofficial, unsupported and untested. Use at your own risk.** The supported way is the web app at [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) with an https server address (step 5). Problems with this setup cannot be supported.

If you only use DriveLens on your home LAN and want neither Cloudflare Tunnel nor Tailscale, you can build the web app yourself and serve it over http from **the same address (same origin)** as drivelens-api: Caddy serves the web app files and forwards `/api/` and `/health` to drivelens-api. Because it is the same origin, `DRIVELENS_CORS_ORIGINS` is not needed.

**What does not work over http, and caveats**

- **Push notifications:** not available (Settings → Notifications says "Notifications need the web app to be opened over https.").
- **Offline start** (service worker): not available; the app does not open when the server is unreachable.
- **Install as an app** (Chrome / Edge / Android): not available. On iPhone / iPad, "Add to Home Screen" works as a shortcut.
- **Share card:** "Copy image" and "Share…" are not shown; "Save image" works.
- **No encryption:** your token and driving data travel in plain text on the LAN, so anyone on the same network could read them. Use it only on a home network you trust.
- **Map:** map tiles (OpenFreeMap / OpenStreetMap) are loaded from the internet.
- **Never expose the ports to the internet** (no port forwarding on your router).
- The web app does not update itself (see Updating below).

### Build the web app

With git and Docker you can build in the `node:22` image without installing Node.js. Set `TAG` to the latest release from [Releases](https://github.com/zzflsxygod/drivelens/releases) (the same version as your server).

```bash
cd teslamate
TAG=v1.3.1   # replace with the latest release
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
mkdir -p drivelens-web && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

With Node.js installed (22, i.e. 22.12+, or 20.19+): `cd drivelens-src/app && npm ci && npm run build:web`. The output is `app/dist-web/`. No environment variables are needed. `dist-web/_headers` is for Cloudflare Pages and is ignored by Caddy (the Caddyfile below covers what is needed).

### Caddy

Create `teslamate/Caddyfile.drivelens`:

```caddyfile
:80 {
	encode zstd gzip
	@api path /api/* /health
	handle @api {
		reverse_proxy drivelens-api:8080
	}
	handle {
		root * /srv
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@other not path /assets/*
		header @other Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
	}
}
```

Add this under `services:` in `docker-compose.drivelens.yml` (`drivelens-api` can keep its default `127.0.0.1:8080:8080` port):

```yaml
  drivelens-web:
    image: caddy:2
    restart: always
    depends_on:
      - drivelens-api
    ports:
      - "8081:80"   # or "192.168.1.10:8081:80" to listen on the LAN address only
    volumes:
      - ./Caddyfile.drivelens:/etc/caddy/Caddyfile:ro
      - ./drivelens-web:/srv:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-web
```

Downloading `docker-compose.drivelens.yml` again removes this addition.

Optional: behind Caddy every device appears to come from the same address. To count failed sign-ins per device, add `- DRIVELENS_TRUST_PROXY_HEADERS=true` to the `environment:` of `drivelens-api`.

### Connect

1. Open `http://<server LAN IP>:8081` in the browser (e.g. `http://192.168.1.10:8081`; a fixed IP for the server, set in your router, helps).
2. In **Server URL**, enter **the same address**, `http://192.168.1.10:8081`. Do not leave out `http://` (without it the app assumes `https://`).
3. In **Pairing code or server token**, enter the server token (`DRIVELENS_API_TOKEN`) or a pairing code from Settings → Devices → Add device on a connected device, then press **Test connection & start**.
4. The warning "This is an unencrypted http connection: …" is expected here. The "The web app needs" box on the welcome screen (https required) is about the official web app.

The official web app has a different address, so its connection is stored separately. You can change the address later in Settings → Server → **API URL**.

### Updating

After updating the server (drivelens-api), rebuild the web app from the same release tag. With Watchtower the server is always on the latest release, so use the latest tag (to keep both in step, pin `DRIVELENS_IMAGE` in `.env` to the same tag).

```bash
cd teslamate
TAG=v1.3.1   # the new release
rm -rf drivelens-src
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
rm -rf drivelens-web/* && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

Do not delete the `drivelens-web` folder itself (the container would lose its mount; if you did, run `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-web`). Reload the page to get the new version. A web app older or newer than the server generally still works, and the app tells you when a feature needs a server update.

<a id="auth-proxy"></a>
### Behind an auth proxy (same-origin, unofficial)

> ⚠️ **Unofficial, unsupported and untested by DriveLens.** The notes below are for people who already self-host the web app and API on the **same origin** (as in this appendix) and want an extra login such as oauth2-proxy or Cloudflare Access in front. DriveLens does not test these setups; use them at your own risk.

The warning in [step 5](#cloudflare-tunnel) ("don't put Cloudflare Access in front of the API") applies to the **official web app**, which lives on a different origin. When the self-hosted web app and `drivelens-api` share one host, the browser sends the proxy's session cookie with page loads **and** with `/api/` requests, so an auth proxy in front of that host can work. DriveLens still checks its own device token (`Authorization: Bearer …`); the proxy is an extra gate, not a replacement.

**Recommended pattern: ForwardAuth (session check only)**

Have the reverse proxy ask oauth2-proxy whether the request is authenticated, then pass the request through unchanged. oauth2-proxy only answers the check (`/oauth2/auth`); it does not rewrite the request body or the `Authorization` header.

- For **`/api/`** (and preferably for every path the app fetches as JSON), an unauthenticated request must get **401**, not a **302** redirect to a login HTML page. In oauth2-proxy terms that is the `/oauth2/auth` endpoint (used by Traefik `forwardAuth` / Caddy `forward_auth`). Redirect browsers to the IdP only for normal page loads if you want a login UX.
- If the auth backend is down, **fail closed** (return 5xx / deny), do not let the request through.
- Forward the client's `Authorization: Bearer <DriveLens device token>` **unchanged**. Do **not** enable `--set-authorization-header` (it would replace the Bearer token with an IdP token). `--pass-authorization-header` only matters when oauth2-proxy itself proxies to an upstream; with ForwardAuth it does not proxy the app request, so leave it off. DriveLens validates its own token.
- When using ForwardAuth, run oauth2-proxy with `--reverse-proxy=true` and an upstream of `static://202` (or equivalent) so it only answers `/oauth2/auth` and does not proxy application traffic.
- Serve DriveLens at the **root of its own (sub)domain** (e.g. `https://drivelens.example.com/`). Paths such as `/drivelens/` are **not supported**: `manifest.webmanifest`, the service worker (`/sw.js`, scope `/`) and asset URLs are root-absolute.
- `manifest.webmanifest` is sometimes fetched without cookies — exclude it from auth if the install-as-app flow fails. Excluding `/health` is optional (useful for uptime checks).

**Traefik** (sketch — replace the host and URLs with yours):

```yaml
http:
  middlewares:
    oauth2-auth:
      forwardAuth:
        address: "http://oauth2-proxy:4180/oauth2/auth"
        trustForwardHeader: true
        # Do not put Authorization in authResponseHeaders —
        # DriveLens needs the client's Bearer token unchanged.
  routers:
    # Login/callback without the auth middleware (higher priority).
    oauth2:
      rule: "Host(`drivelens.example.com`) && PathPrefix(`/oauth2/`)"
      priority: 100
      service: oauth2-proxy
    drivelens:
      rule: "Host(`drivelens.example.com`)"
      priority: 1
      middlewares: ["oauth2-auth"]
      service: drivelens
  services:
    oauth2-proxy:
      loadBalancer:
        servers:
          - url: "http://oauth2-proxy:4180"
    drivelens:
      loadBalancer:
        servers:
          - url: "http://drivelens-web:80"
```

To send browsers to the login page on first visit, catch 401 on non-API paths and redirect to oauth2-proxy's start URL (e.g. `/oauth2/start`); keep `/api/` on a plain 401.

**Caddy** (sketch — same-origin web + API; `/oauth2/*` must bypass `forward_auth`):

```caddyfile
drivelens.example.com {
	# Login/callback must reach oauth2-proxy without forward_auth
	# (otherwise the callback loops).
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180
	}

	# Optional: leave /health unauthenticated for uptime checks.
	handle /health {
		reverse_proxy drivelens-api:8080
	}

	handle {
		# /oauth2/auth → 401 when there is no session (good for /api/).
		# oauth2-proxy: --reverse-proxy=true --upstream=static://202;
		# leave --set-authorization-header off.
		forward_auth oauth2-proxy:4180 {
			uri /oauth2/auth
		}

		handle /api/* {
			reverse_proxy drivelens-api:8080
		}
		handle {
			root * /srv
			try_files {path} /index.html
			file_server
		}
	}
}
```

**Cloudflare Access** on the same hostname is the same idea (a session on that host). Prefer an Access policy that answers API clients with 401 rather than an HTML login redirect when the session is missing, and do not strip or replace `Authorization`.

**What the app does when the proxy session expires**

A 401 from the proxy does **not** sign the device out. The app only clears the saved connection when **drivelens-api** itself answers `401` with JSON `{"error":"unauthorized"}` (revoked or expired device token). A proxy 401/5xx or a network error keeps the connection and shows an error; sign in to the IdP again and reload the page.
