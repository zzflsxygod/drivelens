# DriveLens install guide

**English** · [中文](install.zh.md) · [日本語](install.ja.md)

DriveLens has two parts:

- **drivelens-api**, a small Docker container next to TeslaMate on your server. It reads the TeslaMate database through a read-only account.
- **The DriveLens web app** at **[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)**. You enter your server address and token there once.

> DriveLens **never modifies TeslaMate's tables**. Its database account can only read them. DriveLens' own data (place names, manual charging costs, journeys, covers, push subscriptions, weather cache) lives in a separate `drivelens` schema.

Contents: [Requirements](#requirements) · [1. Files](#1-download-two-files) · [2. Password and token](#2-create-a-password-and-a-token) · [3. Database account](#3-create-the-database-account-once) · [4. Start](#4-start-drivelens-api) · [5. https](#5-give-the-server-an-https-address) · [6. Connect](#6-connect-the-web-app) · [7. Notifications](#7-notifications) · [8. Updates](#8-updates) · [Reference](#environment-variables) · [Troubleshooting](#troubleshooting) · [Uninstall](#uninstall)

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
4. creates the `drivelens` schema, owned by `drivelens_ro`.

It does not create, change or delete anything in TeslaMate's tables. On every start the API creates and upgrades its own tables in the `drivelens` schema; no further SQL is ever needed.

> Different database name or admin user? Change `-U` / `-d` above and add `DRIVELENS_DB_NAME=yourdb` to `.env`.

## 4. Start drivelens-api

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

The log should show:

```
INFO drivelens_api: all features enabled (API level 14)
INFO drivelens_api: listening on 0.0.0.0:8080
```

If it shows `disabled features: …` or `cannot read TeslaMate tables`, step 3 did not work: run `setup.sql` again, then `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api`.

Check on the server: `curl http://127.0.0.1:8080/health` returns `{"status":"ok","version":"…","api_level":14}`.

By default the compose file publishes the API on `127.0.0.1:8080` only, so it is not reachable from other machines. **Don't expose port 8080 to the internet**; use one of the https options below.

## 5. Give the server an https address

The web app is served over https, so browsers block `http://` server addresses (mixed content), **including LAN and Tailscale IPs** such as `http://192.168.x.x:8080` or `http://100.x.y.z:8080`. Pick one option:

<a id="cloudflare-tunnel"></a>
### Option A: Cloudflare Tunnel (you have a domain on Cloudflare)

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token.
2. Either run cloudflared in the same compose project: uncomment the `cloudflared` service in `docker-compose.drivelens.yml`, add `CLOUDFLARE_TUNNEL_TOKEN=…` to `.env`, and start it with `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d cloudflared`. You can then remove the `ports:` lines from `drivelens-api`.
   Or use cloudflared already installed on the host.
3. Add a public hostname, e.g. `drivelens.your-domain`, with the service `http://drivelens-api:8080` (cloudflared in compose) or `http://127.0.0.1:8080` (cloudflared on the host).
4. Your server address is `https://drivelens.your-domain`.

Don't put a login page such as Cloudflare Access in front of the API: the browser's requests from the web app would be blocked. The API is protected by the token.

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
2. Enter the **server URL** from step 5 and the **API token** (`DRIVELENS_API_TOKEN` from `.env`).
3. Tap **Test connection & start**. The app checks `/health`, then loads your cars with the token.

| Message | What to do |
| --- | --- |
| Wrong token (401) | Copy `DRIVELENS_API_TOKEN` again, without spaces or quotes |
| The browser blocks http server addresses | Use an https address (step 5) |
| Can't reach / timed out | Check the address, that the tunnel or Tailscale is running and that the certificate is valid |
| Isn't a DriveLens API | You entered the TeslaMate or Grafana address; use the drivelens-api address |
| Server does not allow this site (CORS) | Update drivelens-api; if you set `DRIVELENS_CORS_ORIGINS`, include `https://drivelens-app.oharuru.com` |
| Server is too old | Update drivelens-api (step 8) |
| Too many wrong tokens (429) | 10 failed attempts within 10 minutes block that address for a while; wait 10 minutes |

You can change the server and token later in Settings → Server. Language, theme, map label language and default currency are in Settings too.

**Install to the home screen:** on Android and desktop Chrome / Edge use "Install as an app" in Settings or the browser menu → Install. On iPhone / iPad (Safari): Share → Add to Home Screen.

The server address and token are stored only in this browser's local storage and are sent only to your server. On a shared computer, remove them by clearing this site's data in the browser. The offline cache holds only the app itself; API responses are never cached.

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

## Environment variables

Read by drivelens-api:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:…@database:5432/teslamate`; the compose file builds it from `.env` |
| `API_TOKEN` | ✅ | The token for the app (16+ characters, 32+ random characters recommended); the compose file takes it from `DRIVELENS_API_TOKEN` |
| `BIND_ADDR` | | Listen address; `0.0.0.0:8080` in the image |
| `DRIVELENS_CORS_ORIGINS` | | Comma-separated web origins allowed to call the API from a browser; `*` = any. Default: the official web app only (plus the origins of the paused native apps). The older name `CORS_ORIGINS` also works |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | Push signing key (base64url P-256). Normally unset: generated on first start and kept in the database |
| `DRIVELENS_VAPID_SUBJECT` | | Contact sent to push services (`mailto:you@example.com` or an https URL). Default: the DriveLens project page |
| `RUST_LOG` | | Log level, default `info` |

In `.env` (used by `docker-compose.drivelens.yml`): `DRIVELENS_DB_PASS`, `DRIVELENS_API_TOKEN`, optional `DRIVELENS_DB_NAME` (default `teslamate`), `DRIVELENS_IMAGE` (default `ghcr.io/zzflsxygod/drivelens-api:latest`) and `CLOUDFLARE_TUNNEL_TOKEN` (only for the cloudflared service).

## Troubleshooting

- **`password authentication failed for user "drivelens_ro"`**: `DRIVELENS_DB_PASS` differs from the password used with `setup.sql`. Run step 3 again (it updates the password) and restart drivelens-api.
- **`API_TOKEN must be at least 16 characters`** (container keeps restarting) or **`API_TOKEN looks weak`**: create a new token with `openssl rand -hex 24`, put it in `.env`, run `up -d drivelens-api` again and enter it in the app.
- **`cannot read TeslaMate tables`** or **`disabled features: …`**: the database account is incomplete. Run `setup.sql` again (step 3) and restart drivelens-api. With only `disabled features`, drives, charging and reports keep working meanwhile.
- **The setup screen says the server is unreachable**: on the server, `curl http://127.0.0.1:8080/health` must work. Then check the tunnel (`docker compose … logs cloudflared`) or `tailscale serve status`.
- **`/health` works but loading data fails**: a reverse proxy in between must pass the `Authorization` header unchanged.
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
