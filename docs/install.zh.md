# DriveLens 安装指南

[English](install.md) · **中文** · [日本語](install.ja.md)

DriveLens 由两部分组成：

- **drivelens-api**：放在服务器上、和 TeslaMate 一起运行的小型 Docker 容器，通过只读账号读取 TeslaMate 数据库。
- **DriveLens 网页版**：**[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)** 。用服务器地址和服务器 Token（或者已连接设备生成的配对码）连接一次即可。

> DriveLens **绝不修改 TeslaMate 的表**，它的数据库账号对这些表只有读取权限。DriveLens 自己的数据（地点名称、手动录入的充电费用、旅程、封面、推送订阅、天气缓存、已连接的设备）放在独立的 `drivelens` schema 里。

目录：[前提条件](#前提条件) · [1. 下载文件](#1-下载两个文件) · [2. 密码和 Token](#2-生成密码和-token) · [3. 数据库账号](#3-创建数据库账号只需一次) · [4. 启动](#4-启动-drivelens-api) · [5. https](#5-给服务器配-https-地址) · [6. 连接](#6-在网页版里连接) · [设备](#devices) · [7. 通知](#7-通知) · [8. 更新](#8-更新) · [环境变量](#环境变量) · [常见问题](#常见问题) · [卸载](#卸载) · [附录：只在局域网内使用](#lan-selfhost) · [认证代理（非官方）](#auth-proxy)

## 前提条件

- TeslaMate 用 Docker Compose 运行（官方 `docker-compose.yml`：数据库服务名为 `database`，数据库名和管理员用户都是 `teslamate`）。
- x86_64 或 ARM64 服务器（树莓派也可以）。镜像 `ghcr.io/zzflsxygod/drivelens-api` 提供 linux/amd64 和 linux/arm64 版本。
- 能用 **https** 访问服务器的方式：Cloudflare Tunnel（需要托管在 Cloudflare 上的域名）或 Tailscale（不需要域名），见第 5 步。

## 1. 下载两个文件

在 TeslaMate 的 compose 目录里执行：

```bash
cd teslamate   # TeslaMate 的 docker-compose.yml 所在目录
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/docker-compose.drivelens.yml
```

```
teslamate/
├── docker-compose.yml               # TeslaMate 原有文件（不用改）
├── docker-compose.drivelens.yml     # drivelens-api 服务
├── setup.sql                        # 一次性的数据库设置
└── .env
```

## 2. 生成密码和 Token

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS`：只读数据库账号 `drivelens_ro` 的密码。
- `DRIVELENS_API_TOKEN`：在 App 里填写的 Token。少于 16 个字符时 API 拒绝启动；少于 32 个字符或过于简单时日志会警告。请像上面的命令一样随机生成。

## 3. 创建数据库账号（只需一次）

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
```

[`setup.sql`](../deploy/setup.sql) 可以重复执行（再次执行只会更新密码）。它会：

1. 创建登录角色 `drivelens_ro`；
2. 授予 TeslaMate 各表的 **SELECT** 权限，包括以后 TeslaMate 升级新增的表；
3. 授予 `cars`、`addresses`、`drives`、`charging_processes` 的 REFERENCES 权限，让 DriveLens 的表可以用外键引用它们，TeslaMate 删除行程时 DriveLens 的相关数据也会一起清理（这不是写权限）；
4. 创建 `drivelens` schema，并授予 `drivelens_ro` 该 schema 的 `USAGE` 和 `CREATE` 权限（schema 已存在时也会授予）；
5. 把管理员用旧 SQL 文件创建的 DriveLens 表的所有者改为 `drivelens_ro`（只涉及 `drivelens` schema 里的表）。

它不会在 TeslaMate 的表里新建、修改或删除任何东西。API 每次启动时会在 `drivelens` schema 里自动创建和升级自己的表，之后不需要再执行任何 SQL。

> 数据库名或管理员用户不是 `teslamate`？修改上面的 `-U` / `-d`，并在 `.env` 里加上 `DRIVELENS_DB_NAME=你的库名`。

## 4. 启动 drivelens-api

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

日志里应该看到：

```
INFO drivelens_api: all features enabled (API level 15)
INFO drivelens_api: listening on 0.0.0.0:8080
```

如果出现 `disabled features: …` 或 `cannot read TeslaMate tables`，说明第 3 步没有成功：重新执行 `setup.sql`，然后 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api`。

在服务器上检查：`curl http://127.0.0.1:8080/health` 返回 `{"status":"ok","version":"…","api_level":16}`。

compose 文件默认只把 API 发布在 `127.0.0.1:8080`，其他机器访问不到。**不要把 8080 端口直接暴露到公网**，请用下面的 https 方式之一。

## 5. 给服务器配 https 地址

网页版运行在 https 上，所以浏览器会拦截 `http://` 的服务器地址（混合内容），**局域网和 Tailscale 的 IP 也一样**，比如 `http://192.168.x.x:8080`、`http://100.x.y.z:8080`。二选一：

> 只想在局域网内用 http（自行托管网页版，非官方）：见[附录：只在局域网内使用](#lan-selfhost)。

<a id="cloudflare-tunnel"></a>
### 方式 A：Cloudflare Tunnel（有托管在 Cloudflare 上的域名）

1. 在 Cloudflare Zero Trust → Networks → Tunnels 创建一个 Tunnel，复制它的 token。
2. 可以让 cloudflared 跑在同一个 compose 项目里：取消 `docker-compose.drivelens.yml` 里 `cloudflared` 服务的注释，在 `.env` 里加上 `CLOUDFLARE_TUNNEL_TOKEN=…`，然后用 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d cloudflared` 启动。之后可以删掉 `drivelens-api` 的 `ports:`。
   也可以用宿主机上已经装好的 cloudflared。
3. 添加一个 Public Hostname，例如 `drivelens.你的域名`，服务填 `http://drivelens-api:8080`（cloudflared 在 compose 里）或 `http://127.0.0.1:8080`（cloudflared 在宿主机上）。
4. 服务器地址就是 `https://drivelens.你的域名`。

使用**官方网页版**（[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)）时，不要在 API 前面加 Cloudflare Access 之类的登录页：官方网页版在另一个源上，浏览器不会把 Access 的 Cookie 带给 API，请求会被拦截。API 本身由 Token 保护。**同源自行托管**（网页版和 API 在同一主机）不一样——见[认证代理后面](#auth-proxy)（非官方、未测试）。

<a id="tailscale"></a>
### 方式 B：Tailscale（不需要域名，只有自己的设备能访问）

`tailscale serve` 会给服务器一个只有你的 tailnet 内设备能访问的 https 地址：

1. 在服务器（宿主机正常安装）和手机 / 电脑上安装 Tailscale，登录同一个 tailnet。
2. 在 Tailscale 管理后台 → [DNS](https://login.tailscale.com/admin/dns) 开启 **MagicDNS** 和 **HTTPS Certificates**（每个 tailnet 只需一次）。
3. 在服务器上执行：
   ```bash
   sudo tailscale serve --bg 8080
   ```
   它把 `https://<机器名>.<tailnet>.ts.net` 转发到 `http://127.0.0.1:8080`，重启后也会继续生效。`tailscale serve status` 可以查看地址。compose 文件保持默认的 `127.0.0.1:8080:8080` 即可。第一次访问时要签发证书，可能需要几秒。
4. 服务器地址就是 `https://<机器名>.<tailnet>.ts.net`（不带端口）。使用 DriveLens 的设备需要连着 Tailscale。

注意：

- 不需要设置 CORS：API 默认允许官方网页版。服务器自己的地址不要填进 `DRIVELENS_CORS_ORIGINS`。
- Chrome / Edge 可能会询问是否允许该网站*访问本地网络上的设备*（ts.net 域名指向 100.x 地址），请选择**允许**。如果之前拒绝了，可以在网站设置（地址栏左侧的图标）里重新允许。
- 证书会把机器名（`<机器名>.<tailnet>.ts.net`）写进公开的证书透明度（CT）日志。如果介意，请先改机器名。
- 停止：`sudo tailscale serve --https=443 off`。

## 6. 在网页版里连接

1. 打开 **[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)**（也可以先在欢迎页体验演示）。
2. 填写第 5 步得到的**服务器地址**，第二栏填下面任意一个：
   - **服务器 Token**（`.env` 里的 `DRIVELENS_API_TOKEN`）；
   - 已连接设备生成的**配对码**，例如 `7KQ2-M9XD`（设置 → 设备 → 添加设备，见[管理设备](#devices)）。
3. 点「测试连接并开始」。App 会先检查 `/health`，再读取你的车辆。

drivelens-api 0.14.0 以上时，App 会用服务器 Token 换一个这台设备专用的 Token（设备 Token），并且不保存服务器 Token。之前保存了服务器 Token 的 App（1.2.0 以上）会在下次启动时自动换成设备 Token。

| 提示 | 处理方法 |
| --- | --- |
| Token 错误（401） | 重新复制 `DRIVELENS_API_TOKEN`，不要带空格或引号 |
| 浏览器拦截了 http 服务器地址 | 改用 https 地址（第 5 步） |
| 连不上 / 超时 | 检查地址、Tunnel 或 Tailscale 是否在运行、证书是否有效 |
| 不是 DriveLens API | 你填的是 TeslaMate 或 Grafana 的地址，请填 drivelens-api 的地址 |
| 服务器不允许此网站（CORS） | 更新 drivelens-api；如果设置了 `DRIVELENS_CORS_ORIGINS`，需要包含 `https://drivelens-app.oharuru.com` |
| 服务器版本太旧 | 更新 drivelens-api（第 8 步） |
| 配对码不正确或已失效 | 配对码 10 分钟内有效，只能用一次。请在已连接的设备上重新生成 |
| 请把服务器更新到 v0.14.0 以上（配对码） | 服务器版本低于 0.14.0：更新 drivelens-api（第 8 步），或者改用服务器 Token 连接 |
| Token 错误次数过多（429） | 10 分钟内失败 10 次后，服务器会暂时返回 429；等 10 分钟再试。已连接的设备不受影响 |

服务器之后可以在「设置 → 服务器」里修改（配对码 / Token 一栏留空则保持当前连接）。语言、主题、地图标注语言和默认币种也在设置里。

**添加到主屏幕：** Android 和电脑上的 Chrome / Edge，用设置里的「安装为应用」或浏览器菜单 → 安装。iPhone / iPad（Safari）：分享 → 添加到主屏幕。

服务器地址和这台设备的 Token 只保存在这个浏览器的本地存储里，只会发送到你的服务器，而且总是放在请求头里（不会出现在 URL 里）。**设置 → 退出此设备**会把它们连同缓存的数据和通知订阅一起删除（设备 Token 还会在服务器上同时解除）。离线缓存只包含 App 本身，API 返回的数据从不缓存。

### 管理设备 <a id="devices"></a>

drivelens-api 0.14.0 以上配合 App 1.2.0 以上时，每台手机、平板或浏览器都有自己的设备 Token。**设置 → 设备**会列出它们以及最后使用的时间和地址；点每行的 ⋯ 可以改名或解除连接。

- **不用服务器 Token 添加设备：**点**添加设备**，选择**完全访问**或**只读**（只读设备可以设置 7 天或 30 天后失效，或不过期），再点**生成配对码**。在新设备上填服务器地址和配对码即可。配对码 10 分钟内有效，只能用一次。
- **只读**设备可以查看所有数据，但不能改地点名、充电费用和旅程，也不能管理设备。适合给家人或车载屏幕使用。
- **手机丢了？**在另一台设备上解除它的连接。它在下一次请求时就会退出，缓存的数据也会被删除。
- **解除其他所有设备**会让除当前设备以外的所有设备退出。
- **更换服务器 Token**（怀疑泄露时）：把新的 `DRIVELENS_API_TOKEN` 写进 `.env`，执行 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api`。使用设备 Token 的设备保持连接，只有还在用服务器 Token 的旧版 App（1.2.0 之前）需要填新 Token。
- 可选加固：`DRIVELENS_OWNER_KEY_MODE=pair-only` 让服务器 Token 只能用来添加和管理设备（见[环境变量](#环境变量)）。

设备列表需要 `drivelens` schema 的 `CREATE` 权限，并且 DriveLens 的表属于 `drivelens_ro`（`deploy/setup.sql` 会设置好）。不满足时 API 会在日志里输出 `device auth disabled`，其他功能照常使用服务器 Token；一次性的修复方法见[升级到 0.14.0](#升级到-0140)。

## 7. 通知

「设置 → 通知」为当前设备开启推送通知：行程结束时推送**行程小结**（里程、时间、电量、起点 → 终点），每月 1 日推送**月报提醒**（设备所在时区 9:00 起）。两项都可以单独关闭，点通知会打开对应的行程或报告。

- 你的服务器每分钟检查一次 TeslaMate 里结束的行程，自己发送通知，经浏览器的推送服务（Google、Apple 或 Mozilla）端到端加密传送。容器需要能通过 https 访问这些服务。
- 不需要任何设置：签名密钥（VAPID）在第一次启动时自动生成并保存在 `drivelens` schema 里。如果它丢失（例如换了数据库），需要在每台设备上重新开启通知。
- iPhone / iPad：需要 iOS 16.4 或更高版本，并且要把 DriveLens 添加到主屏幕、从主屏幕打开。
- Android / 电脑：Chrome、Edge 或 Firefox。如果通知被拦截了，请在网站设置里允许。

## 8. 更新

**自动更新（推荐）：** 取消 `docker-compose.drivelens.yml` 末尾 `watchtower` 服务的注释，用 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d watchtower` 启动。它每 6 小时检查一次，只更新带有 `com.centurylinklabs.watchtower.enable=true` 标签的容器，也就是只有 drivelens-api；TeslaMate、数据库和 Grafana 不受影响。

**手动更新：**

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

API 启动时会自动升级自己的表。想固定在某个版本，可以在 `.env` 里设置例如 `DRIVELENS_IMAGE=ghcr.io/zzflsxygod/drivelens-api:v1.1.1`。更新说明见 [Releases](https://github.com/zzflsxygod/drivelens/releases)。网页版始终是最新版本，服务器需要更新时会提示你。

### 升级到 0.14.0

如果服务器是用旧的 SQL 文件（或 0.14.0 之前的 `setup.sql`）设置的，`drivelens` schema 和表可能属于 TeslaMate 的管理员账号，`drivelens_ro` 也可能没有该 schema 的 `CREATE` 权限。这时设备认证不会开启（日志里有 `device auth disabled`），其他功能照常使用服务器 Token。只需修复一次：下载最新的 `setup.sql` 重新执行第 3 步，或者只执行下面两条语句，然后重启并查看日志：

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

日志里应出现 `device auth enabled: N device(s)`。

## 环境变量

drivelens-api 读取的变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:…@database:5432/teslamate`；compose 文件根据 `.env` 生成 |
| `API_TOKEN` | ✅ | 服务器 Token（主密钥）：用于设备首次登录和管理设备（至少 16 个字符，建议 32 个以上随机字符）；compose 文件取自 `DRIVELENS_API_TOKEN` |
| `DRIVELENS_OWNER_KEY_MODE` | | `full`（默认）：服务器 Token 对所有请求都有效，和以前一样。`pair-only`：服务器 Token 只能用来添加和管理设备（`/api/auth/*`，其他请求返回 403 `owner_key_pair_only`），失败次数过多后在 10 分钟内连检查都不做，猜测它就没有意义了，而你的设备照常可用。需要设备认证可用，否则 API 会退回 `full` 并在日志里报错 |
| `BIND_ADDR` | | 监听地址；镜像内为 `0.0.0.0:8080` |
| `DRIVELENS_CORS_ORIGINS` | | 允许从浏览器调用 API 的网页来源，逗号分隔；`*` 表示任意来源。默认只允许官方网页版（以及已暂停的原生 App 的来源）。旧名称 `CORS_ORIGINS` 仍然有效 |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | 推送签名密钥（base64url P-256）。通常不用设置：第一次启动时自动生成并保存在数据库里 |
| `DRIVELENS_VAPID_SUBJECT` | | 发给推送服务的联系方式（`mailto:you@example.com` 或 https 网址）。默认是 DriveLens 项目页 |
| `DRIVELENS_TRUST_PROXY_HEADERS` | | `true` = 登录失败次数限制按 `CF-Connecting-IP` / `X-Forwarded-For` 区分客户端（只认来自本机 / 内网地址的请求，即你的隧道或反向代理）。默认关闭：按连接本身的地址计算，隧道后面所有客户端共用一个限制。设备 Token 始终会被检查，已连接的设备不会被拦在外面；默认模式下正确的服务器 Token 也会被接受 |
| `DRIVELENS_PUSH_HOSTS` | | 额外允许的推送服务主机（逗号分隔），用于使用自有推送服务器的浏览器。Chrome / Edge、Firefox、Safari 的推送服务始终允许 |
| `RUST_LOG` | | 日志级别，默认 `info` |

`.env` 里（`docker-compose.drivelens.yml` 使用）：`DRIVELENS_DB_PASS`、`DRIVELENS_API_TOKEN`，可选的 `DRIVELENS_DB_NAME`（默认 `teslamate`）、`DRIVELENS_IMAGE`（默认 `ghcr.io/zzflsxygod/drivelens-api:latest`）和 `CLOUDFLARE_TUNNEL_TOKEN`（只给 cloudflared 服务用）。

## 常见问题

- **`password authentication failed for user "drivelens_ro"`**：`DRIVELENS_DB_PASS` 和执行 `setup.sql` 时用的密码不一致。重新执行第 3 步（会更新密码），然后重启 drivelens-api。
- **`API_TOKEN must be at least 16 characters`**（容器反复重启）或 **`API_TOKEN looks weak`**：用 `openssl rand -hex 24` 生成新 Token，写进 `.env`，重新执行 `up -d drivelens-api`，并在 App 里填入新 Token。
- **`cannot read TeslaMate tables`** 或 **`disabled features: …`**：数据库账号设置不完整。重新执行 `setup.sql`（第 3 步）并重启 drivelens-api。如果只是 `disabled features`，行程、充电和报告在此期间仍然可用。
- **设置页提示连不上服务器**：先在服务器上确认 `curl http://127.0.0.1:8080/health` 正常，再检查 Tunnel（`docker compose … logs cloudflared`）或 `tailscale serve status`。
- **`/health` 正常但读取数据失败**：中间如果有反向代理，必须原样转发 `Authorization` 请求头。
- **403 `owner_key_pair_only`**：服务器设置了 `DRIVELENS_OWNER_KEY_MODE=pair-only`，服务器 Token 只能添加和管理设备。App 1.2.0 以上会自动处理；如果是脚本，用 `POST /api/auth/devices` 换一个设备 Token，或者去掉这个变量。
- **429（失败次数过多）**：同一地址 10 分钟内失败 10 次。等 10 分钟再试。已连接的设备不受影响；`pair-only` 模式下这段时间内不检查服务器 Token（所有地址合计失败 50 次时也一样）。
- **收不到通知**：检查该设备上的「设置 → 通知」、浏览器的通知权限，以及容器能否通过 https 访问互联网。

## 卸载

1. 停止并删除容器：
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.drivelens.yml rm -sf drivelens-api
   ```
   （如果为 DriveLens 开启了 `cloudflared` / `watchtower`，也一并删除），然后删除 `docker-compose.drivelens.yml`、`setup.sql` 以及 `.env` 里的 `DRIVELENS_*` 行。
2. 需要的话，删除 DriveLens 的数据和账号（TeslaMate 的数据不受影响）：
   ```bash
   docker compose exec -T database psql -U teslamate -d teslamate \
     -c "DROP SCHEMA drivelens CASCADE" -c "DROP OWNED BY drivelens_ro" -c "DROP ROLE drivelens_ro"
   ```
3. 使用 Tailscale 的话：`sudo tailscale serve --https=443 off`。

## 反馈

问题和功能建议请提交到 [Issues](https://github.com/zzflsxygod/drivelens/issues)。请不要贴出你的服务器地址或 Token。

<a id="lan-selfhost"></a>
## 附录：只在局域网内使用（自行托管网页版，http，非官方）

> ⚠️ **非官方、不在支持范围内、未经测试，风险自负。** 官方的使用方式是网页版 [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) 加上第 5 步的 https 地址。这种部署方式出现的问题无法提供支持。

如果只在家里局域网使用，也不想用 Cloudflare Tunnel 或 Tailscale，可以自己构建网页版，并和 drivelens-api 从**同一个地址（同源）**通过 http 提供：由 Caddy 提供网页版文件，并把 `/api/` 和 `/health` 转发给 drivelens-api。因为是同源，不需要设置 `DRIVELENS_CORS_ORIGINS`。

**http 下不可用的功能和注意事项**

- **推送通知**：不可用（「设置 → 通知」会显示「通知需要通过 https 打开网页版。」）。
- **离线启动**（Service Worker）：不可用；连不上服务器时应用本身也打不开。
- **安装为应用**（Chrome / Edge / Android）：不可用。iPhone / iPad 的「添加到主屏幕」可以作为快捷方式使用。
- **分享卡片**：不显示「复制图片」和「分享…」，「保存图片」可以用。
- **不加密**：Token 和行车数据在局域网内明文传输，同一网络里的人可能看到。只在可信的家庭网络里使用。
- **地图**：地图瓦片（OpenFreeMap / OpenStreetMap）需要从互联网加载。
- **不要把端口暴露到互联网**（不要在路由器上做端口转发）。
- 网页版不会自动更新（见下面的「更新」）。

### 构建网页版

有 git 和 Docker 就可以用 `node:22` 镜像构建，不用安装 Node.js。`TAG` 填 [Releases](https://github.com/zzflsxygod/drivelens/releases) 里的最新版本（和服务器同一个版本）。

```bash
cd teslamate
TAG=v1.2.0   # 换成 Releases 里的最新版本
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
mkdir -p drivelens-web && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

如果直接用 Node.js（22，即 22.12 以上，或 20.19 以上）：`cd drivelens-src/app && npm ci && npm run build:web`。产物在 `app/dist-web/`。不需要环境变量。`dist-web/_headers` 是给 Cloudflare Pages 用的，Caddy 不读它（需要的设置已经写在下面的 Caddyfile 里）。

### Caddy 配置

创建 `teslamate/Caddyfile.drivelens`：

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

在 `docker-compose.drivelens.yml` 的 `services:` 下加上（`drivelens-api` 的 `ports:` 保持默认的 `127.0.0.1:8080:8080` 即可）：

```yaml
  drivelens-web:
    image: caddy:2
    restart: always
    depends_on:
      - drivelens-api
    ports:
      - "8081:80"   # 只监听局域网 IP 的话写成 "192.168.1.10:8081:80"
    volumes:
      - ./Caddyfile.drivelens:/etc/caddy/Caddyfile:ro
      - ./drivelens-web:/srv:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-web
```

重新下载 `docker-compose.drivelens.yml` 会把这段覆盖掉。

可选：经过 Caddy 后所有设备看起来都来自同一个地址。想按设备分别统计登录失败次数，可以在 `drivelens-api` 的 `environment:` 里加上 `- DRIVELENS_TRUST_PROXY_HEADERS=true`。

### 连接

1. 在浏览器打开 `http://<服务器局域网 IP>:8081`（例如 `http://192.168.1.10:8081`；最好在路由器上给服务器固定 IP）。
2. 「服务器地址」填**同一个地址** `http://192.168.1.10:8081`。不要省略 `http://`（省略的话会被当成 `https://`）。
3. 「配对码或服务器 Token」填服务器 Token（`DRIVELENS_API_TOKEN`），或者已连接设备在「设置 → 设备 → 添加设备」里生成的配对码，然后点「测试连接并开始」。
4. 会出现「这是未加密的 http 连接：…」的提示，这种部署下属于正常。欢迎页上的「网页版需要」（要求 https）说的是官方网页版。

官方网页版的地址不同，所以连接信息是分开保存的。之后可以在「设置 → 服务器」的「API 地址」里修改地址。

### 更新

更新服务器（drivelens-api）后，用同一个版本的 tag 重新构建网页版。用 Watchtower 的话服务器总是最新版本，网页版也用最新的 tag（想保持一致，可以在 `.env` 里用 `DRIVELENS_IMAGE` 把服务器固定到同一个 tag）。

```bash
cd teslamate
TAG=v1.2.3   # 新版本
rm -rf drivelens-src
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
rm -rf drivelens-web/* && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

不要删除 `drivelens-web` 文件夹本身（容器的挂载会失效；如果已经删了，执行 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-web`）。刷新页面就是新版本。网页版比服务器旧或新时一般也能用，需要更新服务器的功能应用会提示。

<a id="auth-proxy"></a>
### 认证代理后面（同源，非官方）

> ⚠️ **非官方、不在支持范围内、DriveLens 未测试。** 下面给的是：已经按本附录把网页版和 API 放在**同一源**上，并想在前面再加一层 oauth2-proxy 或 Cloudflare Access 之类登录的人看的。DriveLens 不测试这类配置，风险自负。

[第 5 步](#cloudflare-tunnel)里「不要在 API 前面加 Cloudflare Access」针对的是**官方网页版**（另一个源）。自行托管时网页版和 `drivelens-api` 共用一个主机，浏览器会把代理的会话 Cookie 既带给页面，也带给 `/api/`，所以可以在这台主机前面放认证代理。DriveLens 仍然校验自己的设备令牌（`Authorization: Bearer …`）；代理是额外门槛，不能代替设备令牌。

**推荐做法：ForwardAuth（只做会话检查）**

让反向代理去问 oauth2-proxy「这次请求有没有登录」，通过后再把请求原样转给后端。oauth2-proxy 只负责回答检查（`/oauth2/auth`），不改写请求体，也不改写 `Authorization` 头。

- 对 **`/api/`**（以及应用以 JSON 拉取的路径），未登录时必须返回 **401**，不要 **302** 跳到登录 HTML。在 oauth2-proxy 里就是 `/oauth2/auth`（配合 Traefik `forwardAuth` / Caddy `forward_auth`）。若需要登录页体验，只对普通页面跳转到 IdP。
- 认证服务挂掉时要**拒绝放行**（返回 5xx / 拒绝），不能放行。
- 把客户端的 `Authorization: Bearer <DriveLens 设备令牌>` **原样转发**。不要打开 `--set-authorization-header`（它会用 IdP 令牌替换 Bearer）。`--pass-authorization-header` 只在 oauth2-proxy **自己**代理上游时才有意义；用 ForwardAuth 时它不代理应用请求，保持关闭即可。DriveLens 会自己校验设备令牌。
- 使用 ForwardAuth 时，oauth2-proxy 需要 `--reverse-proxy=true`，以及上游 `static://202`（或等价配置），让它只回答 `/oauth2/auth`，不代理应用流量。
- DriveLens 必须放在**自己（子）域名的根路径**（例如 `https://drivelens.example.com/`）。不支持 `/drivelens/` 这类子路径：`manifest.webmanifest`、Service Worker（`/sw.js`，作用范围 `/`）和静态资源路径都是根路径绝对地址。
- `manifest.webmanifest` 有时会在没有 Cookie 的情况下被拉取——若「安装为应用」失败，可把它排除在认证之外。`/health` 是否排除可自定（方便做存活检查）。

**Traefik**（示意——主机名和 URL 请换成你的）：

```yaml
http:
  middlewares:
    oauth2-auth:
      forwardAuth:
        address: "http://oauth2-proxy:4180/oauth2/auth"
        trustForwardHeader: true
        # 不要把 Authorization 放进 authResponseHeaders —
        # DriveLens 需要客户端原来的 Bearer 令牌。
  routers:
    # 登录/回调不要挂认证中间件（更高优先级）。
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

若希望浏览器首次访问时跳到登录页，可对非 API 路径捕获 401 并重定向到 oauth2-proxy 的起始地址（例如 `/oauth2/start`）；`/api/` 继续直接返回 401。

**Caddy**（示意——同源网页 + API；`/oauth2/*` 必须绕过 `forward_auth`）：

```caddyfile
drivelens.example.com {
	# 登录/回调必须直达 oauth2-proxy，不能经过 forward_auth
	# （否则回调会循环）。
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180
	}

	# 可选：/health 不做认证，方便存活检查。
	handle /health {
		reverse_proxy drivelens-api:8080
	}

	handle {
		# /oauth2/auth → 无会话时返回 401（适合 /api/）。
		# oauth2-proxy: --reverse-proxy=true --upstream=static://202；
		# 不要打开 --set-authorization-header。
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

同一主机名上的 **Cloudflare Access** 思路相同（该主机上的会话）。尽量让 Access 在缺少会话时对 API 返回 401，而不是 HTML 登录跳转，并且不要剥掉或替换 `Authorization`。

**代理会话过期时应用的行为**

代理返回的 401 **不会**登出设备。只有 **drivelens-api** 自己返回 `401` 且 JSON 为 `{"error":"unauthorized"}`（设备令牌被吊销或过期）时，应用才会清除已保存的连接。代理的 401/5xx 或网络错误只会提示错误并保留连接；重新登录 IdP 后刷新页面即可。
