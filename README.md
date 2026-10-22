# DriveLens

DriveLens 是 [TeslaMate](https://github.com/teslamate-org/teslamate) 的第三方 App：读取 TeslaMate 数据库，展示**充电记录**、**行程列表**和**行程路线地图**。

```
手机 / 电脑 App (Tauri 2)  ──HTTPS + Bearer Token──>  Caddy/Nginx (443)  ──>  drivelens-api (127.0.0.1:8080)  ──>  PostgreSQL (TeslaMate)
```

## 目录结构

```
drivelens/
├── api/                      # Rust Axum API（部署到 Oracle 云服务器），含 Dockerfile
│   ├── src/main.rs
│   └── drivelens-api.service # systemd 单元示例
├── deploy/                   # docker-compose 片段 + 数据库初始化 SQL
├── app/                      # Tauri 2 App（桌面 + iOS + Android）
│   ├── index.html, src/      # 前端：Vite + TypeScript + Leaflet(OpenStreetMap)
│   └── src-tauri/            # Tauri Rust 壳
└── testdata/                 # 本地测试：TeslaMate 兼容表结构 + 东京周边示例数据
    ├── schema.sql
    ├── gen_sample.py
    └── sample_data.sql
```

## API

除 `/health` 外都需要请求头 `Authorization: Bearer <API_TOKEN>`。

| 接口 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /api/cars` | 车辆列表 |
| `GET /api/cars/:id/summary?tz=Asia/Tokyo` | 首页数据：车辆信息、状态（在线/休眠/离线）、最新电量/续航/里程/温度/位置、软件版本、最近行程和充电、累计和本月统计（按 `tz` 时区划分月份） |
| `GET /api/cars/:id/status` | 首页：车辆信息 + 状态 + 最新位置/电量/续航/里程 + 软件版本（只走索引，毫秒级） |
| `GET /api/cars/:id/last-activity` | 首页：最近行程、最近充电、当前位置名称 |
| `GET /api/cars/:id/stats?tz=Asia/Tokyo` | 首页：本月和累计统计（只聚合 drives / charging_processes，不扫描 positions） |
| `GET /api/charges?car_id=&limit=&offset=` | 充电记录（时间、地点、充入/消耗 kWh、费用、起止电量、时长） |
| `GET /api/charges/:id` | 单次充电详情 + 充电曲线（`charges` 表） |
| `GET /api/drives?car_id=&limit=&offset=` | 行程（起止时间/地址、距离、时长、能耗 kWh、效率 Wh/km） |
| `GET /api/drives/:id` | 单个行程 |
| `GET /api/drives/:id/path` | 行程 GPS 轨迹（`positions` 表） |
| `GET /api/addresses/aliases` | 所有自定义地点名称 |
| `PUT /api/addresses/:id/alias` | 设置地点自定义名称，body：`{"name":"我家车库"}`（1–200 字） |
| `DELETE /api/addresses/:id/alias` | 恢复默认名称 |

### 自定义地点名称

TeslaMate 自动识别的地名有时不准，可以在 App 的行程详情 / 充电详情里点击地点名称修改。

- 名称按 **地点（`addresses.id`）** 保存，同一地点的所有行程、充电记录都会显示新名称。
- 显示优先级：**自定义名称 > TeslaMate 地理围栏（Geo-Fence）名称 > TeslaMate 自动识别的地址**。
- 响应中带 `address_id`（充电）/ `start_address_id`、`end_address_id`（行程），以及 `alias` / `start_alias` / `end_alias`。
- **不修改 TeslaMate 自己的表**。数据保存在独立 schema：`drivelens.address_aliases(address_id, name, updated_at)`。API 启动时如果表不存在会自动创建。

环境变量：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 如 `postgres://drivelens_ro:密码@127.0.0.1:5432/teslamate` |
| `API_TOKEN` | 至少 16 位的随机字符串，生成：`openssl rand -hex 32` |
| `BIND_ADDR` | 默认 `127.0.0.1:8080`（只监听本机，由反向代理对外） |

> 能耗按 TeslaMate Grafana 的算法估算：`(起始额定续航 - 结束额定续航) × cars.efficiency`。

## 安装（v0.10.0 起）

**新用户请看安装指南：[English](docs/install.md) · [中文](docs/install.zh.md) · [日本語](docs/install.ja.md)**（公开版在 https://github.com/zzflsxygod/drivelens-releases ）：执行一次 `deploy/setup.sql`（只读账号 + drivelens schema），用 `deploy/docker-compose.drivelens.yml` 启动 API；API 启动时自动创建 / 升级 drivelens 的表，App 首次打开有连接向导。
下面的「部署方式一 / 二」是早期的手动步骤（旧 SQL 文件仍保留，已部署的服务器无需任何改动）。

## 部署方式一（推荐）：Docker + TeslaMate 同一个 Compose + Cloudflare Tunnel

镜像 `ghcr.io/zzflsxygod/drivelens-api` 支持 **linux/arm64**（Oracle Ampere）和 linux/amd64。镜像基于 distroless，非 root 用户运行，容器内监听 `0.0.0.0:8080`。

**获取镜像（二选一）：**

- **在服务器上直接构建（最简单）**：`git clone` 本仓库后执行 `docker build -t ghcr.io/zzflsxygod/drivelens-api:latest api/`，ARM 服务器上构建出来的就是 arm64 镜像。
- **GitHub Actions 自动构建并推送到 GHCR**：工作流文件在 `deploy/github-actions-docker.yml`，把它移动到 `.github/workflows/docker.yml` 并推送即可启用（推送 workflow 文件需要 token 带 `workflow` 权限，例如先执行 `gh auth refresh -s workflow`）。之后每次推送到 main 或打 `v*` tag 都会构建 amd64 + arm64 镜像。

> 用 GHCR 的话：仓库是私有的，镜像默认也是私有，服务器上需要先 `docker login ghcr.io -u zzflsxygod`（密码用一个只有 `read:packages` 权限的 Personal Access Token）。

### 1. 设置密码和 Token

在 TeslaMate 的 `docker-compose.yml` 同目录的 `.env` 里追加（没有 `.env` 就新建）：

```
DRIVELENS_DB_PASS=换成强密码（不要带单引号）
DRIVELENS_API_TOKEN=用 openssl rand -hex 32 生成
```

### 2. 创建数据库用户和 drivelens schema

把 `deploy/drivelens-init.sql` 复制到 TeslaMate 目录，执行（可重复执行）：

```bash
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="'和 DRIVELENS_DB_PASS 一样的密码'" < drivelens-init.sql
```

`drivelens_ro` 对 TeslaMate 的表只有 SELECT，只对 `drivelens` schema 可写。

**从 v0.3.x 升级到 v0.4.0（手动充电费用）**：用新版 `drivelens-init.sql` 替换旧文件，按上面的命令再执行一次（会新建 `drivelens.charge_costs` 表并授权），然后更新 API 镜像。
没执行的话 API 照常工作，只是录入费用会提示「服务器还没有启用手动费用」。执行后无需重启 API。

### 3. 添加服务

把 `deploy/docker-compose.drivelens.yml` 里的 `drivelens-api` 服务合并进 TeslaMate 的 `docker-compose.yml`（或者放在同目录，用 `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d`）。
根据下面 Cloudflare Tunnel 的方案决定是否保留 `ports`。**绝不要**发布 `5432`，也不要把 8080 映射到 `0.0.0.0`。

```bash
docker compose up -d drivelens-api
docker compose logs -f drivelens-api      # 看到 listening on 0.0.0.0:8080 即可
```

### 4. Cloudflare Tunnel

用了 Tunnel 之后服务器**不需要开放任何入站端口**（Oracle 安全列表里也不用放行 80/443）。

**方案 A：cloudflared 也是这个 compose 里的容器**（同一个网络）

- 删掉 `drivelens-api` 的 `ports`。
- 在 Cloudflare Zero Trust 控制台 → Networks → Tunnels → 你的 tunnel → Public Hostname，添加：
  `drivelens.你的域名.com` → Service：`HTTP`，URL：`drivelens-api:8080`
- 如果是用 `config.yml` 配置的：
  ```yaml
  ingress:
    - hostname: drivelens.example.com
      service: http://drivelens-api:8080
    # ...其他规则
    - service: http_status:404
  ```
- 如果 cloudflared 在另一个 compose 项目里，要让两者加入同一个 Docker 网络。

**方案 B：cloudflared 装在宿主机上**（systemd 服务）

- 保留 `ports: - "127.0.0.1:8080:8080"`（只监听本机）。
- Public Hostname 的 URL 填 `localhost:8080`（`config.yml` 里是 `service: http://localhost:8080`）。

**Cloudflare Access 注意事项**

如果给这个域名开启了 Cloudflare Access（Zero Trust 登录页），App 发出的 API 请求会被拦截（返回登录页 / 302），App 无法通过浏览器登录流程。可以：

- 给 `drivelens.你的域名.com` 加一条 **Bypass** 策略（或者不对这个子域名启用 Access），由 API 自己的 Bearer Token 鉴权；或者
- 使用 **Service Token**：请求需要额外带 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 请求头（当前 App 还没有这两个设置项，需要的话可以加）。

无论哪种方式，API 都**仍然要求** `Authorization: Bearer <DRIVELENS_API_TOKEN>`。

验证：

```bash
curl https://drivelens.你的域名.com/health
curl -H "Authorization: Bearer 你的TOKEN" "https://drivelens.你的域名.com/api/cars"
```

然后在 App「设置」里填 `https://drivelens.你的域名.com` 和 Token。

## 部署方式二：直接在宿主机运行（systemd）

### 1. 编译

在服务器上直接编译（Oracle 免费 ARM 实例也可以）：

```bash
curl https://sh.rustup.rs -sSf | sh
cd drivelens/api && cargo build --release
sudo cp target/release/drivelens-api /usr/local/bin/
```

### 2. 创建只读数据库用户（推荐）

TeslaMate 一般用 Docker Compose 运行。进入数据库容器：

```bash
docker compose exec database psql -U teslamate teslamate
```

```sql
CREATE ROLE drivelens_ro LOGIN PASSWORD '换成强密码';
GRANT CONNECT ON DATABASE teslamate TO drivelens_ro;
GRANT USAGE ON SCHEMA public TO drivelens_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drivelens_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO drivelens_ro;

-- 自定义地点名称：只在独立的 drivelens schema 里有写权限，TeslaMate 的表保持只读
CREATE SCHEMA IF NOT EXISTS drivelens;
CREATE TABLE IF NOT EXISTS drivelens.address_aliases (
  address_id integer PRIMARY KEY REFERENCES public.addresses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA drivelens TO drivelens_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON drivelens.address_aliases TO drivelens_ro;
```

> 表由管理员预先建好的话，API 启动时检测到表已存在就会跳过建表，所以 `drivelens_ro` 不需要建 schema 的权限（只读用户名字照旧，但它对 `drivelens` 有写权限）。

API 需要能连到数据库。在 `docker-compose.yml` 的 `database` 服务里**只映射到本机回环地址**：

```yaml
    ports:
      - "127.0.0.1:5432:5432"
```

⚠️ **不要**写成 `"5432:5432"`，也不要在 Oracle 安全列表 / 防火墙里放行 5432。PostgreSQL 绝不能暴露到公网。

### 3. systemd 服务

```bash
sudo tee /etc/drivelens-api.env >/dev/null <<EOF
DATABASE_URL=postgres://drivelens_ro:强密码@127.0.0.1:5432/teslamate
API_TOKEN=$(openssl rand -hex 32)
BIND_ADDR=127.0.0.1:8080
EOF
sudo chmod 600 /etc/drivelens-api.env
sudo cp api/drivelens-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now drivelens-api
sudo journalctl -u drivelens-api -f
sudo cat /etc/drivelens-api.env   # 记下 API_TOKEN，填到 App 里
```

### 4. HTTPS 反向代理（Caddy，自动申请证书）

先把域名（如 `drivelens.example.com`）解析到服务器公网 IP。

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
drivelens.example.com {
    reverse_proxy 127.0.0.1:8080
}
EOF
sudo systemctl reload caddy
```

用 Nginx 的话：`proxy_pass http://127.0.0.1:8080;` + certbot 申请证书即可。

### 5. 开放端口

Oracle 控制台 → VCN → 安全列表，放行 TCP 80、443（只这两个）。Oracle 的 Ubuntu 镜像还自带 iptables 规则，需要：

```bash
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

测试：

```bash
curl https://drivelens.example.com/health
curl -H "Authorization: Bearer 你的TOKEN" "https://drivelens.example.com/api/charges?limit=3"
```

## App 开发与构建

前置：Node.js 18+、Rust 最新 stable（`rustup update`，Tauri 依赖需要较新的 Rust）。

```bash
cd app
npm install
npm run tauri dev        # 桌面调试
npm run tauri build      # 打包桌面安装包（在哪个系统上打包就出哪个系统的包）
```

Linux 需先安装：`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev build-essential`。

首次打开 App 进入「设置」，填 API 地址（如 `https://drivelens.example.com`）和 Token，点「保存并测试连接」。
（Android App 连接公网服务器只允许 https；局域网 / Tailscale 地址可以用 http，但会提示数据未加密。）

### Android（v0.14.0 起）

发布版由 GitHub Actions（`.github/workflows/android.yml`）在打 `v*` tag 时构建：签名的通用 APK（arm64-v8a / armeabi-v7a / x86_64）和 AAB，附加到与 Windows 同一个 Release。`scripts/release.sh` 会等 Windows 和 Android 都完成后再发布。

- Android 工程已提交在 `app/src-tauri/gen/android`（Tauri 推荐做法）。改动集中在 `MainActivity.kt`（edge-to-edge 安全区、键盘、状态栏颜色、分享 / 保存图片桥接）、`network_security_config.xml` 和 `build.gradle.kts`（签名）。
- 签名：`keystore.properties` 的路径由 `DRIVELENS_KEYSTORE_PROPERTIES` 指定，否则读 `gen/android/keystore.properties`（已 gitignore）。CI 从 Secrets（`ANDROID_KEYSTORE_B64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`）生成该文件。**keystore 丢失就无法再给已安装的 App 推送更新，务必备份。**
- 本地构建：

  1. 准备 JDK 17+、Android SDK（platform 37、build-tools）、NDK 27，设置 `ANDROID_HOME`、`NDK_HOME`。
  2. 用 rustup 安装 stable 工具链，并执行 `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`。
  3. 执行：

     ```bash
     npx tauri android dev                      # 模拟器 / 手机调试
     npx tauri android build --apk --aab --target aarch64 armv7 x86_64
     ```

### 网页版 / PWA（v0.15.0 起）

- `cd app && npm run build:web` → `app/dist-web/`（同一套代码；运行时检测 Tauri / 浏览器，构建时 `--mode web` 额外生成 `manifest.webmanifest`、只缓存 App 外壳的 `sw.js`、图标和 Cloudflare Pages 用的 `_headers`）。本地预览：`npm run preview:web`（http://localhost:4174）。
- 构建变量：`VITE_DONATE_URL`（设置页底部「支持 DriveLens」卡片的链接，为空则不显示）、`VITE_DONATE_WEB_ONLY=1`（只在网页版显示）、`VITE_WEB_ORIGIN`（默认 `https://drivelens-app.oharuru.com`）。
- 官方地址 `https://drivelens-app.oharuru.com`：`.github/workflows/web.yml` 每次构建都上传 artifact，打 tag（或手动运行并勾选 deploy）时在有 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets 的情况下部署到 Cloudflare Pages（项目名默认 `drivelens-app`，可用仓库变量 `CF_PAGES_PROJECT` 修改；`DONATE_URL` 变量即 `VITE_DONATE_URL`）。没有 secrets 时跳过部署。
- API 默认 CORS 只允许官方网页版和 Tauri App（`DRIVELENS_CORS_ORIGINS` 可改，见 docs/install.md）。

### Windows / Android 打包暂停（v0.15.0 起）

`windows.yml` / `android.yml` 现在只能手动运行（Actions → Run workflow）。恢复自动打包：取消两个文件里 `push:` 段的注释，并把 `scripts/release.conf` 改为 `NATIVE_BUILDS=1`。

### iOS（需要 macOS + Xcode）

1. 安装 Xcode、`brew install cocoapods`
2. `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
3. 执行：
   ```bash
   npm run tauri ios init
   npm run tauri ios dev
   npm run tauri ios build            # 需要 Apple 开发者账号签名
   ```

## 本地测试（示例数据）

```bash
sudo apt install postgresql
sudo -u postgres psql -c "CREATE USER teslamate PASSWORD 'secret'" -c "CREATE DATABASE teslamate OWNER teslamate"
cd testdata && python3 gen_sample.py
PGPASSWORD=secret psql -h localhost -U teslamate teslamate -f schema.sql -f sample_data.sql

cd ../api
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate API_TOKEN=dev-token-1234567890 DRIVELENS_CORS_ORIGINS=http://localhost:1420,http://localhost:4174 cargo run
# 前端：cd app && npm run dev，然后浏览器打开
# http://localhost:1420/?api=http://127.0.0.1:8080&token=dev-token-1234567890
```

性能测试：在示例数据之后再执行 `testdata/bigdata.sql`，会生成约 300 万条 positions、6000 次行程、1500 次充电（约 30 秒）。

`testdata/schema.sql` 是按 TeslaMate 的 Ecto 表结构整理的子集（只含本应用用到的表），**仅用于测试**，不要在真实 TeslaMate 数据库上执行。


## 月度报告（v0.5.0）

首页「本月」卡片 → 查看月度报告 ›。接口：`GET /api/cars/:id/report?month=YYYY-MM&tz=Asia/Tokyo&currency=JPY`（只读，不需要改数据库）。

充电类型分类规则：
- **超充**：直流快充（`charges.fast_charger_present` 为真），且地点名称（自定义名称 / 地理围栏 / 地址）含 Supercharger、超充、スーパーチャージャー 或 Tesla。
- **家充**：交流充电，且地点名称含 home / 自宅 / 家 / うち，或者是过去 12 个月最常用的交流充电地点（平均功率 < 22 kW 的会话最多的地址）。
- **其他**：其余所有（其他交流充电、非特斯拉的直流快充）。


## 服务器自动更新与版本检查（v0.5.1）

- `GET /health`（无需 Token）返回 `{"status":"ok","version":"0.5.1","api_level":7}`；`GET /api/health`（需要 Token）额外检查数据库。
- App 启动时读取 `/health`：服务器版本过旧或正在更新时显示提示条「服务器正在更新或版本过旧…」并隐藏不支持的功能，不会崩溃。设置页显示服务器版本。
- 自动更新：`deploy/docker-compose.drivelens.yml` 里的 `watchtower` 服务（nickfedor/watchtower，只更新带 `com.centurylinklabs.watchtower.enable=true` 标签的 drivelens-api，每 5 分钟检查一次）。
- 发布流程：`scripts/release.sh [https://你的域名]` —— 推送 main → 等 Docker 镜像构建成功 → 等服务器 `/health` 显示新版本 → 打 tag 构建网页版（以及 `NATIVE_BUILDS=1` 时的 Windows / Android 安装包，草稿）→ 发布（v1.0.0 起：`X.Y.Z` 为正式版并标记 Latest；`0.x` 或带后缀的版本如 `1.1.0-beta.1` 为预发布；`DRIVELENS_PRERELEASE=1/0` 可强制；脚本创建的草稿使用 `distribution/CHANGELOG.md` 中该版本的段落作为说明。v0.16.0 起不再附带网页版 zip，网页版只在官方网址提供）。


## 旅程（v0.6.0）

把多段行程合并成一次「旅程」（只在 DriveLens 的 `drivelens` schema 里分组，不修改 TeslaMate 的 drives）。
「行程」页顶部切换「行程 | 旅程」；行程列表点「选择」多选后「合并为旅程」；旅程页有自动建议（相邻行程间隔小于设定值，默认 60 分钟；中途有充电时可到 2 小时；单个建议最长 3 天）。

**升级步骤（先执行 SQL，再更新镜像也可以，API 在表不存在时只会提示功能未启用）**：

```bash
docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.6.0.sql
```

`deploy/drivelens-v0.6.0.sql` 只新建 `drivelens.journeys` / `drivelens.journey_drives` 并授权（含序列 USAGE），可重复执行，不需要密码；`drivelens-init.sql` 也已包含这部分。

接口：`GET/POST /api/journeys`、`GET/PATCH/DELETE /api/journeys/:id`、`PUT /api/journeys/:id/drives`、`GET /api/journeys/suggestions`、`GET /api/journeys/:id/path`（最多约 3000 个点，含速度、海拔、累计距离）。API level 8。

### 忽略旅程建议（v0.6.1）

建议卡片上的「忽略」会记住这条建议里的所有行程：这些行程以后不再出现在任何建议里（和已属于旅程的行程一样会把建议「断开」），之后新记录的行程仍可能组成新的建议。
记录保存在服务器（`drivelens.dismissed_suggestions`，多设备同步）；服务器还没建表时自动退回保存在本机。设置里可以关闭建议、或「恢复已忽略的建议」。建议区可以折叠（本机记住）。

升级：`docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.6.1.sql`（只建这张表并授权，可重复执行）。API level 9。

### 旅程第二期（v0.7.0）

旅程详情页新增：封面（把当前地图设为封面，存在 `drivelens.journeys.cover_image`）、多行备注、分享卡片（客户端生成 1080×1350 PNG，可保存 / 复制 / 分享）、每段行程出发时的气温和降水（Open-Meteo，免费无需 key，缓存在 `drivelens.weather_hourly`），以及按车速分档（市区 <40、郊外 40–80、高速 >80 km/h）的能耗。

升级：`docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.7.0.sql`（只改 drivelens schema，可重复执行）。API level 11。API 容器需要能访问 `archive-api.open-meteo.com` 和 `api.open-meteo.com`。没执行 SQL 时，封面和天气会提示执行该文件，速度分档照常可用。

## v0.6.2 — 无限滚动

- 行程 / 充电列表改为无限滚动：API `GET /api/drives|charges?paged=true&before=<ISO~id>&limit=50` 返回 `{items, next_cursor}`（keyset 分页；旧的 `limit/offset` 仍可用）。
- 新增 `GET /api/cars/:id/months?tz=` 月度汇总，用于吸顶月份标题与「跳到月份」。`api_level` = 10。
- 从详情页返回时保留滚动位置与已加载内容；多选跨页有效；首页缓存秒开。
- 旧服务器（level < 10）回退为一次加载最近 100 条。
- 无需 SQL。可选索引建议（数据量很大时）：`CREATE INDEX ON drives (car_id, start_date);` — 仅建议，DriveLens 不会自动创建。

## v0.6.3 — 回到顶部（仅 App）

- 长页面滚动超过约 1.5 屏后右下角出现 ↑ 按钮（避开底部标签栏与多选合并栏，适配安全区/深色模式），平滑回到顶部。
- 列表处于「跳到月份」状态时，按钮会回到最新记录。
- 再次点击当前底部标签也会回到顶部。
- 无 API 变更，服务器仍为 0.6.2；`scripts/release.sh` 在 `api/` 无改动时自动跳过 /health 等待。

## v0.11.0 — 多语言（中文 / English / 日本語）

- 设置 →「语言 / Language」：跟随系统 / 中文 / English / 日本語；新安装默认跟随系统，已有安装保持中文。地图文字语言默认跟随界面语言。
- 文案在 `app/src/locales/{zh,en,ja}.ts`（中文为源），格式化（日期、时长、相对时间、月份）在 `app/src/i18n.ts`。
- `npm run check:i18n`（`npm run build` 会先执行）：缺少 key、占位符不一致、源码里残留硬编码中文时失败。
- 安装指南：[English](docs/install.md) · [中文](docs/install.zh.md) · [日本語](docs/install.ja.md)（v0.15.1 起英文为默认）。服务器无需更新（API 未变）。

## v0.14.1 — 弹出菜单定位修复

所有弹出菜单（引导页语言、车辆切换、行程月份跳转、设置里的下拉框、旅程 ⋯ 菜单）都改用 `ui.ts` 里同一个定位函数 `placePopover()` / `trackPopover()`：
- 按锚点所在的一侧对齐左边或右边，并限制在可视区域内。可视区域会扣掉安全区（刘海、手势条）、顶栏和底部导航。
- 根据上下哪边空间大，自动向上或向下弹出；内容超过可用高度时在菜单内部滚动。
- 窗口缩放、横竖屏切换、键盘弹出和页面滚动时自动重新定位；锚点滚出屏幕时自动关闭菜单。

## v0.14.2 — 演示模式顶栏固定、手机版锁定竖屏

- 演示模式的提示条（含“退出”按钮）现在是顶栏里的最后一行，跟顶栏一起固定在最上方，滚动时不再往上漂移。原因：提示条是顶栏外单独的 sticky 元素，`top` 写死为 49px，而 v0.12 起顶栏实际高 59px，一滚动就上移 10px、钻到顶栏下面。
- 顶栏的实际高度由 `ResizeObserver` 测量并写入 CSS 变量 `--hdr-h`（含安全区和演示提示条），服务器提示条、列表月份标题、页面返回栏都按它吸顶，不再被顶栏遮住一截。
- Android 版锁定竖屏（`AndroidManifest.xml` 里 `android:screenOrientation="portrait"`）。Windows 窗口不受影响，仍可自由缩放。服务器无需更新（API 未变）。

## v0.15.0 — 网页版（PWA）+ API 0.11.0（可配置 CORS）

- 网页版：`npm run build:web` 生成可安装的 PWA（manifest、竖屏、主题色、apple-touch-icon、只缓存 App 外壳的 service worker，API 响应从不缓存）。官方地址 https://drivelens-app.oharuru.com（部署见上文「网页版 / PWA」）。
- 网页版设置向导说明 https + CORS 要求，并区分 CORS 被拒、混合内容（http）、无法连接 / 证书、离线等错误。分享卡片用下载 / Web Share，封面照片用文件选择（仍转 JPG ≤1600px）。演示模式在网页版可用。
- 设置页底部「支持 DriveLens」卡片（`VITE_DONATE_URL`，为空时隐藏）；网页版显示「安装为应用」。
- API 0.11.0：`DRIVELENS_CORS_ORIGINS`（旧名 `CORS_ORIGINS`），默认允许官方网页版 + Tauri App 来源，`*` = 任意；预检缓存 10 分钟，支持 Private Network Access。api_level 不变（12），无数据库迁移。
- Windows / Android 打包暂停（workflow 只能手动运行；`scripts/release.conf` 的 `NATIVE_BUILDS=0`），v0.15.x 的 Release 附带过 `DriveLens_版本_web.zip`，v0.16.0 起不再附带。

## v0.15.1 — 公开发布仓库 drivelens-releases

源码仓库保持私有；面向用户的内容放在公开仓库 **https://github.com/zzflsxygod/drivelens-releases** ：
- README（English 默认 + README.zh.md / README.ja.md）、截图（演示模式）、CHANGELOG、LICENSE（免费使用的专有软件，非开源）、Issue 模板。
- `docs/install.md`（English）/ `install.zh.md` / `install.ja.md`、`deploy/setup.sql`、`deploy/docker-compose.drivelens.yml`（默认使用预构建镜像 `ghcr.io/zzflsxygod/drivelens-api:latest`，不再需要源码）。
- 这些文件的来源：本仓库 `distribution/`（README、LICENSE、CHANGELOG、截图、Issue 模板）+ `docs/install*.md` + `deploy/setup.sql` + `deploy/docker-compose.drivelens.yml`。
- 同步：`scripts/sync-public.sh <tag>`（`release.sh` 第 5 步自动执行，也可手动执行）把上述文件推送到公开仓库，并在公开仓库创建同名 Release；`NATIVE_BUILDS=1` 时附带 exe / msi / apk / aab。CI 里同样的步骤在 `.github/workflows/public-sync.yml`（需要 secret `RELEASES_REPO_TOKEN`，没有时跳过）。
- App：引导页「安装指南」链接、设置页「帮助与反馈」（安装指南 / 版本与更新日志 / 问题反馈）都指向公开仓库，安装指南按界面语言打开对应版本（英文为默认）。
- 镜像 `ghcr.io/zzflsxygod/drivelens-api` 需要在 GitHub 包设置里改为 Public，其他用户才能匿名 `docker pull`。


## v1.1.0 — 电池健康度与 TeslaMate「Battery Health」相同（API 0.13.0，api_level 14）

- 来源：teslamate-org/teslamate `grafana/dashboards/battery-health.json`（main @ 9f4098e）的变量 `aux` 与「Battery Capacity by Mileage」两条 SQL，逐条移植到 `api/src/insights.rs` `tm_health()`，`/api/cars/:id/battery` 新增 `tm` 对象（旧字段保留）。参数：`summary`、`tz`（半月 / 每日分组，非法时用 UTC）、`new_kwh`（20–250，等同 `custom_kwh_new`）。
- 公式：能耗系数 = `ROUND(charge_energy_added / (end_rated_range_km − start_rated_range_km), 3) × 100` 的众数（`duration_min > 10`、`end_battery_level <= 95`、两端额定续航非空、`charge_energy_added > 0`），没有时用 `cars.efficiency × 100`；采样容量 = `charges.rated_battery_range_km × 能耗系数 / charges.usable_battery_level`；合格充电 = 已结束且 `charge_energy_added >= 能耗系数`、`usable_battery_level > 0`；当前 = 最近 100 条 `charges` 行的 AVG（`ORDER BY end_date DESC, date DESC`）；新车 = 每次充电最后一行的 MAX；健康度 = `LEAST(100, 当前 / 新车 × 100)`，衰减 = `GREATEST(0, 100 − …)`，循环 = `FLOOR(SUM(charge_energy_added > 0.01) / 新车)`；每日点 = AVG(odometer)、AVG(最后一行容量)，半月 = MIN(odometer)、PERCENTILE_CONT(0.5)。
- 唯一偏差：20–150 kWh 以外的采样当作不存在（`SANE`），否则一条 `usable_battery_level = 1` 的坏数据会让 MAX 变成几千 kWh。众数并列时取较大值（TeslaMate 不确定）。
- 验证：`testdata/gen_battery_health.py` 生成 TeslaMate 结构的数据（260 次充电、14,934 条 charges），同一库上直接跑 Grafana 原 SQL（删掉坏行）：当前 75.01 / 最高 81.36 kWh / 能耗 15.3 / 循环 120 / 健康 92.2%，每日 237 点、半月 46 点与 API 完全一致（只差两位小数舍入）。10 倍数据（144k charges）`summary=true` 约 0.2 s。
- App：首页卡片（健康度大字、当前 / 新车 kWh、衰减、循环、「与 TeslaMate 算法相同」）；电池页 6 个指标、「容量 · 随里程」「容量 · 随时间」（每日点 + 半月中位数 + 新车参考线）、方法说明。「新车容量（kWh）」手动值存 localStorage（`drivelens-battery-new-kwh`），客户端按同一公式重算；旧的 km 基准自动换算 `km × 能耗 / 100` 后删除，并提示一次。旧服务器（无 `tm`）或数据不足时显示原来的续航法。演示模式同样模拟 `tm`。
- 只读 SELECT，无数据库迁移；`FEATURE_LEVEL.tmHealth = 14`，`LATEST_SERVER = 0.13.0`。

## v1.0.2 — iOS 状态栏区域的毛玻璃带（仅网页版）

- 原因：PWA 使用 `apple-mobile-web-app-status-bar-style=black-translucent` + `viewport-fit=cover`，状态栏区域属于页面；顶栏 `header` 用半透明 `--glass`（.82）+ `backdrop-filter: blur(16px) saturate(1.4)`，其顶部 `padding`（`10px + --sat`）延伸到状态栏下，滚动内容透过模糊显示成一条毛玻璃带；顶部吸附元素不是实色时，iOS 自身的滚动边缘效果也会再叠一层模糊。
- 改动（`style.css`）：`header` 背景改为实色 `var(--bg)`（与 theme-color #f3f4f7 / #07080a 一致），去掉 `backdrop-filter`，细线只在底部（`border-bottom`）；新增 `body::before`（`position: fixed`，高度 `var(--sat)`，`z-index: 1001`，`var(--bg)`，`pointer-events: none`），顶栏隐藏时（引导页）状态栏区域也不透出内容。非独立模式 Safari 中 `--sat` 为 0，不受影响。`--hdr-h` 仍包含安全区，演示条、`.page-head` / `.srv-banner` 继续贴在顶栏下方。
- 测试：WebKit iPhone 13（390，模拟 59px）/ iPhone SE（320，模拟 47px），中英日 × 亮暗 × 设置 / 行程列表 / 行程详情，滚动前后，演示模式（36 组全部通过）。
- API 不变（0.12.0），无数据库迁移。

## v1.0.1 — iOS 上重命名旅程没有输入框（仅网页版）

- 原因：编辑弹层（`.modal` 固定在布局视口底部）在 iOS 上不会随键盘上移——iOS 打开键盘时不缩小布局视口，底部弹层整个被键盘挡住；输入框 15px 还会触发 iOS 聚焦放大，把页面推离弹层。
- 新增 `sheets.ts`：`initSheets()` 用 `visualViewport` 设置 `--vv-top` / `--vv-h`，所有 `.modal` 贴合可视视口（键盘上方），`max-height` 改用可视高度，键盘打开时去掉底部安全区留白（`html.kb-open`），打开时锁定页面滚动；自动加 `role="dialog"`、`aria-modal`、`aria-labelledby`；Esc 关闭最上层弹层（等同取消）。`focusField()` 在点击处理里同步聚焦（`preventScroll`），iOS 才会弹出键盘。
- 触屏设备输入框 / 下拉框 16px（避免 iOS 放大）；`.pen` 触控区扩大到 44px；旅程名称框 Enter 保存。
- 替换浏览器原生弹窗：`insights.ts` 电池基准值无效的 `alert()` → 输入框下方行内错误；`journey.ts` 建议「创建旅程」失败的 `alert()` → 建议卡片内行内错误。全应用已无 `prompt()` / `confirm()` / `alert()`。
- API 不变（0.12.0），无数据库迁移。

## v1.0.0 — 第一个正式版（仅网页版）

- 重新显示捐助卡片：仓库变量 `DONATE_URL=https://buymeacoffee.com/zzflsxygod`（web.yml → `VITE_DONATE_URL`），设置页最底部「支持 DriveLens」。
- `release.sh`：从 1.0.0 起 `X.Y.Z` 发布为正式版并标记 Latest，`0.x` / 带 `-` 后缀为预发布（`DRIVELENS_PRERELEASE=1/0` 强制）；脚本创建草稿时用 CHANGELOG 中该版本的段落作为发布说明。`sync-public.sh`：带后缀的版本在公开仓库也标为预发布。
- 公开 README（三语）更新到 1.0.0：当前版本、支持链接 / 支持一节、界面与演示模式说明、镜像 amd64 / arm64；截图按当前界面重新生成。
- API 不变（0.12.0），无数据库迁移。

## v0.17.4 — 首页车辆卡片三格不换行（仅网页版）

- 「总里程 / 软件版本 / 车外 / 车内」三格（`heroTiles()`）：数值 `white-space: nowrap`，温度取整（`deg()`，`-0` → `0`，缺失 `—`）；按三格里最长值的字符数设 `--n`，每格 `container-type: inline-size`，字号 `clamp(10px, 100cqi / (n × .6), 14px)`，三格同步缩小。320px 下 `123,456 km` / `2026.32.7.1` / `-12° / -6°` 也是一行（Chromium + WebKit、Courier 宽等宽字体验证）。里程缺失显示 `—`（不再是 `— km`）。

## v0.17.3 — 设置页「服务器」折叠并移到下方（仅网页版）

- 已保存服务器（地址 + Token）时，「服务器」折叠成一行：状态点（绿 = 已连接 / 红 = 无法连接 / 黄 = 检查中）+ 主机名 + 小号等宽版本号（App / 服务器）+ 箭头；点开（`button[aria-expanded]`，grid-rows 动画）显示版本行和「检查」、API 地址、Token、保存并测试连接。未配置或 `/health` 无法连接时自动展开（用户手动开合后不再自动改变）。收起时内部控件 `tabIndex=-1`。
- 顺序：显示 → 旅程 → 通知 →（安装为应用）→ 服务器 + 演示模式卡片 → 帮助与反馈 → 支持。演示模式中：退出演示卡片仍在最上方，「服务器」只显示版本行。
- `main.ts`：`serverSectionHTML` / `paintServerHead`（`onServerInfo` 实时刷新）/ `bindServerSection`；新文案 `set.srvOk/srvErr/srvNone/srvNoneShort`。

## v0.17.2 — https 提示说明 + Tailscale 配置（仅网页版）

- 引导页「网页版需要」第一条改写（zh/en/ja `su.webHttps`）：网页版运行在 https 上，浏览器会拦截所有 http 地址（局域网 / Tailscale IP 也一样）；Tailscale 用户执行 `tailscale serve` 即可免费得到 https 地址，后面加「Tailscale 配置方法」链接（`installGuideUrl()#tailscale`）。`su.mixed`（填 http 地址时的错误）同样说明。
- 安装指南三语「方案 B：Tailscale」重写为网页版流程：MagicDNS + HTTPS Certificates → `sudo tailscale serve --bg 8080` → 填 `https://机器名.tailnet.ts.net`；不需要改 compose 端口，不需要改 CORS（CORS 白名单是网页版的来源，不是 API 地址）；Chrome 本地网络访问提示选允许；锚点 `<a id="tailscale">`。

## v0.17.1 — 设置「主题」文案修正（仅网页版）

- 设置 › 显示：原「地图主题 / Map theme / 地図のテーマ」实际切换的是整个 App 的浅色 / 深色，改名为「主题 / Theme / テーマ」；选项为 跟随系统（默认）/ 浅色 / 深色（英文 "System default" → "Follow system"，中文「深色（夜间）」→「深色」）。地图底图始终跟随 App 主题（`map.ts` 的 `effectiveTheme()`），没有单独的地图主题设置。
- 新用户默认 `theme` 未设置 = 跟随系统；选择跟随系统时，系统切换浅 / 深色会实时生效（界面与底图）。

## v0.17.0 — 新 UI（“Telemetry”设计系统，仅网页版）

- `app/src/style.css` 整体重写（不再叠加 v0.8 渐变 / 玻璃等旧层）：tokens（浅色 / 深色两套，均达到 WCAG AA 文字对比度；浅色强调色 `#006a9e`、绿 `#047857`，深色强调色 `#00e5ff`）→ 基础 → 顶栏 / 底栏 → 控件 → 内容块 → 各页面 → 动效。背景改为纯色（修复短页面的渐变色带）。主题仍跟随系统，设置里可手动切换。
- 数字 / 数值使用系统等宽字体（`ui-monospace` 等，不加载外部字体）；标签和标题保持普通字体，中日文不强制大写 / 字距。
- `src/icons.ts`：线性 SVG 图标替换界面里的 emoji（底栏、统计、提示、关于、通知等）；locale 里文案开头的 emoji 去掉，文字不变。
- 颜色从 TS 移到 CSS 变量：图表（`--ch-*`、`--mix-*`）、日历热度、速度区间、海拔、地图路线 / 起终点、分享卡片（canvas 按主题取色）、PWA theme-color（`#f3f4f7` / `#07080a`）。
- 地图：浅色底图改为 OpenFreeMap `positron`（深色仍为 `dark`），路线用强调色；缩放 / 版权控件改为与界面一致的样式。
- 设置页分组（服务器 / 显示 / 旅程 / 通知 / 帮助与反馈），分组标题统一为 section-title。
- 保留：ui.ts 的动效（分段控件滑块、页面切换、弹出菜单定位）、覆盖式滚动条、`--hdr-h` 吸顶、演示条在顶栏内、安全区。
- 无 API 变更（服务器保持 0.12.0）。

## v0.16.0 — 网页推送通知 + API 0.12.0（api_level 13）

- 设置 → 通知：本设备开启推送（总开关），**行程小结**（行程结束时：距离、用时、电耗 / 电效、起点 → 终点）和**月报提醒**（每月 1 日，按订阅时浏览器的时区，9 点以后）可分别开关；“发送测试通知”。点通知打开对应行程 / 月报（已打开的窗口直接跳转，不重新加载）。
- 状态提示：App（Tauri）里提示用网页版；浏览器不支持；需要 https；iPhone 需先添加到主屏幕（iOS 16.4+）；通知被拦截；服务器 api_level < 13；服务器未建表（提示执行 v0.16.0.sql）。演示模式：同样的界面，开关存在本地，测试通知只在页面内预览，不申请权限、不推送。
- 服务器：`api/src/push.rs`。纯 Rust 的 `web-push-native`（RFC 8291 aes128gcm + RFC 8292 VAPID，RustCrypto，镜像里无 OpenSSL）。VAPID 密钥首次启动自动生成并存在 `drivelens.push_state`（或用 `DRIVELENS_VAPID_PRIVATE_KEY` / `DRIVELENS_VAPID_SUBJECT` 覆盖）。后台任务每 60 秒轮询 TeslaMate `drives`（只读）：`drive_watermark` + `drive_sent` 防重复；首次运行从当前最新行程开始（不补发历史）；结束超过 6 小时的行程只标记不推送。推送服务返回 404/410 时删除订阅，连续失败 10 次也删除。
- API：`GET /api/push/key`、`POST /api/push/subscription`（新建 / 更新，按 endpoint）、`POST /api/push/subscription/status`、`POST /api/push/unsubscribe`、`POST /api/push/test`（都需要 Token）。`/api/health` 多了 `web_push`。
- 表（只在 `drivelens` schema）：`push_subscriptions`、`push_state`。用 setup.sql 安装的服务器由 API 自动建表；生产这种由管理员建表的旧安装需要先执行：
  `docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.16.0.sql`
  没执行时启动日志会显示 `disabled features: web push`，执行后一分钟内自动生效（不用重启）。
- 网页版不再提供自行托管的 zip（Release 不再附带 `DriveLens_版本_web.zip`），安装向导和安装说明里去掉了自行托管网页版的说明。
