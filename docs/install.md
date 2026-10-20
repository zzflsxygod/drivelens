# DriveLens installation guide (self-hosted TeslaMate)

**English** · [中文](install.zh.md) · [日本語](install.ja.md)

DriveLens has two parts:

- **drivelens-api** — a small service (Docker container) on your TeslaMate server that reads the TeslaMate database through a read-only account.
- **DriveLens app** — the phone / desktop client. On first launch you enter your server URL and token.

> DriveLens **never modifies TeslaMate's tables**. It only has SELECT on them; its own data (place names, manual charging costs, journeys, covers, weather cache) lives in a separate `drivelens` schema.

## Requirements

- TeslaMate running with Docker Compose (the official `docker-compose.yml`; the database service is called `database`, and the database name / admin user are `teslamate` by default).
- An x86_64 or ARM64 server (Raspberry Pi works).
- A safe way to reach the server from outside: **Cloudflare Tunnel or Tailscale is recommended** (step 5).

## 1. Download two files

In your TeslaMate compose directory (the one with TeslaMate's `docker-compose.yml`):

```bash
cd teslamate   # the directory with TeslaMate's docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/docker-compose.drivelens.yml
```

Nothing else is needed: drivelens-api is a prebuilt Docker image (`ghcr.io/zzflsxygod/drivelens-api`, linux/amd64 + linux/arm64) that Docker pulls in step 4.

```
teslamate/
├── docker-compose.yml               # TeslaMate's existing file
├── docker-compose.drivelens.yml     # DriveLens API service
├── setup.sql                        # one-time database setup
└── .env
```

## 2. Generate a password and a token in `.env`

In the TeslaMate compose directory:

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS` — password of the read-only database account `drivelens_ro`.
- `DRIVELENS_API_TOKEN` — the token the app uses (**at least 16 characters; 32+ random characters recommended**; the API log and the app warn when it is too short).

## 3. Create the database account (once)

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
```

`setup.sql` can be run again safely. It:

1. creates the login role `drivelens_ro` (or just updates its password);
2. grants **SELECT** on TeslaMate's tables (including tables added by future TeslaMate upgrades);
3. grants REFERENCES on `cars / addresses / drives / charging_processes` (DriveLens tables use foreign keys to them, so its data is cleaned up when TeslaMate deletes a drive; **no write access**);
4. creates the `drivelens` schema owned by `drivelens_ro`.

After that the API **creates and upgrades its tables in the `drivelens` schema automatically** on every start (idempotent). No further SQL is needed.

> If your database name or admin user isn't `teslamate`, change `-U` / `-d` and add `DRIVELENS_DB_NAME=yourdb` to `.env`.

## 4. Start drivelens-api

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

The image is small and starts within seconds. When the log shows

```
INFO drivelens_api: all features enabled (API level 12)
INFO drivelens_api: listening on 0.0.0.0:8080
```

everything is fine. If you see `disabled features: …` or `cannot read TeslaMate tables`, step 3 didn't succeed: run `setup.sql` again and `docker compose restart drivelens-api`. Read-only features (drives, charging, reports…) keep working in the meantime.

Local check: `curl http://127.0.0.1:8080/health` should return `{"status":"ok","version":"…","api_level":…}`.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:password@database:5432/teslamate` (the compose file builds it from `.env`) |
| `API_TOKEN` | ✅ | Bearer token for the app; at least 16 characters, 32+ recommended |
| `BIND_ADDR` | | Listen address, `0.0.0.0:8080` in the image |
| `DRIVELENS_CORS_ORIGINS` | | Comma-separated web origins allowed to call the API from a browser (v0.11.0+; the old name `CORS_ORIGINS` still works). Default: only the official web app `https://drivelens-app.oharuru.com`; the Windows / Android apps are always allowed. `*` allows any origin |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | Web push signing key (base64url P-256 private key, v0.12.0+). Normally leave unset: the API generates one on first start and keeps it in the `drivelens` schema |
| `DRIVELENS_VAPID_SUBJECT` | | Contact sent to the browser push services with each notification (`mailto:you@example.com` or an https URL). Default: the DriveLens project page |
| `RUST_LOG` | | Log level, default `info` |

`.env` variables used by the compose file: `DRIVELENS_DB_PASS`, `DRIVELENS_API_TOKEN`, optionally `DRIVELENS_DB_NAME` (default teslamate), and `DRIVELENS_IMAGE` (default `ghcr.io/zzflsxygod/drivelens-api:latest`; set e.g. `…:v0.15.1` to pin a version).

### Updating

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

The API upgrades its database schema automatically on start. New versions and their notes are listed on the [Releases](https://github.com/zzflsxygod/drivelens-releases/releases) page.

**Automatic updates (optional):** uncomment the `watchtower` service at the end of `docker-compose.drivelens.yml` and run `up -d` again. It only updates containers labelled `com.centurylinklabs.watchtower.enable=true` (drivelens-api is), checking every 6 hours.

## 5. Reaching the server securely (pick one)

**Don't expose port 8080 directly to the internet** (without https the token travels in plain text).

### Option A: Cloudflare Tunnel (recommended if you have a domain)

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token.
2. Uncomment the `cloudflared` section in `docker-compose.drivelens.yml` and add `CLOUDFLARE_TUNNEL_TOKEN=…` to `.env`; you can then remove `ports:` from `drivelens-api`.
3. Add a Public Hostname `drivelens.your-domain` → `http://drivelens-api:8080` (or `http://127.0.0.1:8080` if cloudflared runs on the host).
4. In the app, enter `https://drivelens.your-domain`.

<a id="tailscale"></a>
### Option B: Tailscale (no domain / private access)

The web app is served over https, so browsers block `http://` server addresses, **including LAN and Tailscale IPs** like `http://100.x.y.z:8080` (mixed content). `tailscale serve` gives the server a free https address that only your tailnet can reach:

1. Install Tailscale on the server (on the host, the normal install) and on your phone / computer, and sign in to the same tailnet.
2. In the Tailscale admin console → [DNS](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates** (needed once per tailnet).
3. On the server, run:
   ```bash
   sudo tailscale serve --bg 8080
   ```
   This proxies `https://<machine>.<tailnet>.ts.net` → `http://127.0.0.1:8080` and keeps running after reboots. `tailscale serve status` shows the address. Keep the compose file's default `127.0.0.1:8080:8080`, no port changes needed. The first request can take a few seconds while the certificate is issued.
4. In DriveLens, enter `https://<machine>.<tailnet>.ts.net` (no port). The device you use must be connected to Tailscale.

- **CORS**: nothing to add. The API allows the official web app by default; the API address itself never goes into `DRIVELENS_CORS_ORIGINS`.
- **Chrome / Edge** may ask to let the site *access devices on your local network* (the ts.net name points to a 100.x address). Choose **Allow**; if you blocked it, allow it again in the site settings (lock icon in the address bar).
- The certificate puts the machine name (`<machine>.<tailnet>.ts.net`) in the public Certificate Transparency logs; rename the machine first if that matters to you.
- To stop: `sudo tailscale serve --https=443 off`.

> Built-in protections: constant-time token comparison; 10 failed logins from one IP within 10 minutes → temporarily refused (HTTP 429); read-only access to TeslaMate's tables.

## 6. Install and set up the app

1. Open the web app **https://drivelens-app.oharuru.com** (works on any phone or computer and can be installed to the home screen, see step 7), or install the Windows / Android app from the [Releases](https://github.com/zzflsxygod/drivelens-releases/releases) page when an installer is available for your platform.
2. On first launch you'll see “Welcome to DriveLens” (the language follows your system and can be changed at the top right):
   - **Server URL** — from step 5, e.g. `https://drivelens.example.com`;
   - **API token** — `DRIVELENS_API_TOKEN` from `.env`.
3. Tap “Test connection & start”. The app checks `/health`, then reads your cars with the token, and explains what went wrong if it fails:

| Message | What to do |
| --- | --- |
| Wrong token (401) | Copy `DRIVELENS_API_TOKEN` again, without spaces or quotes |
| Can't reach / timed out | Check the URL and that the tunnel or Tailscale is running; the web app needs an `https://` address (Cloudflare Tunnel, or `tailscale serve` → `https://…ts.net`) |
| Isn't a DriveLens API | You entered the TeslaMate / Grafana URL; use the drivelens-api URL |
| Server is too old | Update drivelens-api (see “Updating”) |
| Too many wrong tokens (429) | Wait 10 minutes and try again |

You can change the server URL and token at any time in Settings (new values are saved only after a successful test). The app language, map label language and default currency follow your device and can also be changed in Settings.

## 7. Web app (PWA)

If you'd rather not install an app, open **https://drivelens-app.oharuru.com** in a browser and enter your server address and token (or try the demo first). The web app is just static files: your browser talks directly to **your own** drivelens-api; the token and your data never pass through the web host.

**Server requirements**

- **drivelens-api v0.11.0 or later**: allows the official web app (CORS) by default. If you set `DRIVELENS_CORS_ORIGINS`, include `https://drivelens-app.oharuru.com`, e.g.
  ```yaml
  environment:
    - DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com
  ```
- **https only**: browsers block calls from an https page to an `http://` address (mixed content). Cloudflare Tunnel (option A) works; with Tailscale use `tailscale serve` and `https://machine.your-tailnet.ts.net` instead of `http://100.x.y.z:8080` (see [option B](#tailscale)).
- Don't put a login page such as Cloudflare Access in front of the API — it blocks the browser's cross-origin requests.

**Install to the home screen**

- Android (Chrome) / desktop (Chrome, Edge): "Install as an app" at the bottom of Settings, or the browser menu → Install app.
- iPhone / iPad (Safari): Share → Add to Home Screen. Installed, it opens full-screen in portrait.

**Notifications (drivelens-api v0.12.0+)**

Settings → Notifications turns on push notifications for this device: a **trip summary** when a drive ends (distance, time, energy, from → to) and a **monthly report** reminder on the 1st (your device's time zone, from 9:00). Each can be switched off separately; tapping a notification opens that trip or report.

- Your server detects finished drives in TeslaMate's database (every minute) and sends the notification itself, encrypted, through the browser's push service (Google / Apple / Mozilla). The API container therefore needs outbound https access to those services.
- No setup is needed: the signing key is generated on the first start. Changing or losing it (e.g. a new database) means every device has to turn notifications on again.
- iPhone / iPad: iOS 16.4 or later, and DriveLens must be added to the Home Screen and opened from there.
- Android / desktop: Chrome, Edge or Firefox. If notifications were blocked, allow them in the site settings.

**Notes**

- The token is kept in this browser's local storage; clear it in Settings on shared computers.
- The offline cache holds only the app itself (HTML / JS / CSS / icons); API responses are never cached.

| Web app message | What to do |
| --- | --- |
| Server does not allow this site (CORS) | Update drivelens-api to v0.11.0+, check `DRIVELENS_CORS_ORIGINS` |
| Browser blocks the http server address | Use an https address (Cloudflare Tunnel / [`tailscale serve`](#tailscale)) |
| Can't reach (certificate / domain) | Check the domain, that the tunnel is running and the certificate is valid |

## Troubleshooting

- **Log shows `password authentication failed for user "drivelens_ro"`**: `DRIVELENS_DB_PASS` in `.env` differs from the password used with `setup.sql`. Run step 3 again (it updates the password).
- **Log shows `API_TOKEN looks weak`**: the token is short or simple. Replace it with one from `openssl rand -hex 24` and update the app settings.
- **Uninstall**: stop and remove the `drivelens-api` container, then (optionally) run as the admin
  `DROP SCHEMA drivelens CASCADE; DROP OWNED BY drivelens_ro; DROP ROLE drivelens_ro;` — TeslaMate's data is not affected.

## Feedback

Bugs and feature requests: [Issues](https://github.com/zzflsxygod/drivelens-releases/issues). Please don't post your server URL or token.
