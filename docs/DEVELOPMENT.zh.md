# DriveLens 开发指南（中文）

DriveLens 是 [TeslaMate](https://github.com/teslamate-org/teslamate) 的第三方查看器：`drivelens-api`（Rust / Axum）只读访问 TeslaMate 的 PostgreSQL，网页版 / PWA（Vite + TypeScript）通过 HTTPS + Bearer Token 调用它。安装和运行服务器请看安装指南：[English](install.md) · [中文](install.zh.md) · [日本語](install.ja.md)。贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)，安全问题见 [SECURITY.md](../SECURITY.md)。

```
浏览器（网页版 / PWA）──HTTPS + Bearer Token──>  隧道 / 反向代理（Cloudflare Tunnel、tailscale serve…）──>  drivelens-api :8080  ──>  PostgreSQL（TeslaMate）
```

## 目录结构

```
drivelens/
├── api/                  # drivelens-api（Rust / Axum），Dockerfile，deny.toml / about.toml（依赖许可证）
│   └── src/              # main.rs（路由、鉴权、迁移）、summary / report / insights / journey / phase2 / push.rs
├── app/                  # 前端（Vite + TypeScript + MapLibre GL），同一套代码构建网页版和（暂停的）Tauri App
│   ├── src/              # main.ts 入口，locales/{zh,en,ja}.ts 文案，demo/ 演示模式数据
│   ├── web-public/       # 只用于网页版的静态文件（_headers、图标）
│   ├── scripts/          # check-i18n.mjs、demo/fetch-routes.py（生成演示路线）
│   └── src-tauri/        # Tauri 2 壳（Windows / Android / iOS，目前暂停发布）
├── deploy/               # setup.sql（数据库账号 + drivelens schema）、docker-compose.drivelens.yml；drivelens-*.sql 为旧安装的升级脚本
├── docs/                 # 安装指南（三语）、截图、本文件
├── scripts/              # release.sh（维护者发布用）、third-party-licenses.sh
├── testdata/             # TeslaMate 兼容的表结构子集 + 生成示例数据的脚本（仅用于测试）
└── third_party/          # 第三方声明（TeslaMate NOTICE）
```

## 本地开发

前置：Rust stable（`rustup update`）、Node.js 20+、PostgreSQL（本地测试用）。

```bash
# 1. 测试数据库（只用 testdata，绝不要在真实的 TeslaMate 数据库上执行 schema.sql）
sudo -u postgres psql -c "CREATE USER teslamate PASSWORD 'secret'" -c "CREATE DATABASE teslamate OWNER teslamate"
cd testdata && python3 gen_sample.py
PGPASSWORD=secret psql -h localhost -U teslamate teslamate -f schema.sql -f sample_data.sql

# 2. API
cd ../api
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate API_TOKEN=dev-token-1234567890 \
  DRIVELENS_CORS_ORIGINS=http://localhost:1420,http://localhost:4174 cargo run

# 3. 前端：浏览器打开 http://localhost:1420/，在引导页填 http://127.0.0.1:8080 和 dev-token-1234567890
cd ../app && npm ci && npm run dev
```

- 网页版构建：`npm run build:web` → `app/dist-web/`（额外生成 `manifest.webmanifest`、只缓存 App 外壳的 `sw.js`、`_headers`、`third-party-licenses.txt`）；预览：`npm run preview:web`（`http://localhost:4174`）。
- 不连服务器也可以用演示模式：引导页「试用演示」或打开 `/?demo`（数据在 `app/src/demo/`，完全离线）。
- 性能测试：示例数据之后再执行 `testdata/bigdata.sql`（约 300 万条 positions）。电池健康度的对照数据：`testdata/gen_battery_health.py`。
- 构建变量：`VITE_DONATE_URL`（设置页底部「支持」卡片，空 = 不显示）、`VITE_DONATE_WEB_ONLY=1`、`VITE_WEB_ORIGIN`（默认官方网页版地址）。

## 提交前检查

```bash
cd api && cargo test && cargo clippy --all-targets      # 单元测试（含鉴权限流、推送 SSRF 防护、CORS）
cd app && npm run build && npm run build:web            # 两者都会先跑 npm run check:i18n
```

- `npm run check:i18n`：三种语言 key 一致、占位符一致、源码里没有残留的硬编码中文。新文案三种语言都要加（中文为源）。
- PR 由 `.github/workflows/ci.yml` 检查：`cargo test`、依赖许可证（`cargo deny check licenses`，规则在 `api/deny.toml`）、前端两种构建、每个提交都有 `Signed-off-by`（`git commit -s`，DCO）。
- 新的源文件第一行加 `SPDX-License-Identifier: AGPL-3.0-or-later` 注释。

## API

除 `/health` 和 `POST /api/auth/pair` 外都需要 `Authorization: Bearer <token>`：服务器 Token（主密钥，`API_TOKEN`）或设备 Token（`dlt_…`，0.14.0 起）。`GET /health` 返回 `{"status","version","api_level"}`（当前 `api_level` 15）；`GET /api/health` 额外检查数据库和各功能是否可用。

| 接口 | 说明 |
|---|---|
| `GET /api/cars` | 车辆列表 |
| `GET /api/cars/:id/status` · `/last-activity` · `/stats?tz=` · `/summary?tz=` | 首页数据（状态、最近行程 / 充电、本月与累计统计） |
| `GET /api/drives` · `/api/charges`（`car_id`、`paged=true&before=<游标>&limit=`） | 行程 / 充电列表（keyset 分页，返回 `{items, next_cursor}`；旧的 `limit/offset` 仍可用） |
| `GET /api/drives/:id`、`/api/drives/:id/path`、`/api/charges/:id` | 详情、GPS 轨迹、充电曲线 |
| `GET /api/cars/:id/months?tz=` | 月度汇总（列表的月份标题 / 跳转） |
| `GET /api/cars/:id/report?month=YYYY-MM&tz=&currency=`、`/trends` | 月度报告 |
| `GET /api/cars/:id/footprint?month=&tz=`、`/battery?summary=&tz=&new_kwh=` | 足迹、电池健康度（`tm` 对象与 TeslaMate「Battery Health」相同） |
| `PUT/DELETE /api/charges/:id/cost` | 手动充电费用 |
| `GET/PUT/DELETE /api/addresses/...` | 自定义地点名称 |
| `/api/journeys…` | 旅程（合并多段行程）、建议、忽略、封面、天气、车速分档 |
| `/api/push/…` | 网页推送：`key`、`subscription`、`subscription/status`、`unsubscribe`、`test` |
| `GET /api/auth/me` | 当前身份：`{kind:"owner"\|"device", device, device_auth, owner_key_mode}` |
| `POST /api/auth/devices` | 用服务器 Token 换设备 Token（仅限服务器 Token）：`{name}` → 201 `{token, device}` |
| `GET /api/auth/devices`、`PATCH/DELETE /api/auth/devices/:id`、`DELETE /api/auth/devices?except=current` | 设备列表、改名、解除、解除其他所有设备（服务器 Token 或 full 设备） |
| `PATCH/DELETE /api/auth/devices/current` | 改本设备的名字、退出本设备（任何设备） |
| `POST /api/auth/pairings` | 生成配对码：`{scope:"full"\|"read", device_ttl_days?}` → 201 `{code:"XXXX-XXXX", expires_at}`（10 分钟、一次性） |
| `POST /api/auth/pair` | **无需认证**：`{code, name}` → 201 `{token, device}`；错误 400 `{code:"invalid_code"}`，失败过多 429 |

- 设备认证（`api/src/auth.rs`）：数据库只保存 Token / 配对码的 SHA-256；`read` 设备只能 GET/HEAD，外加 `/api/push/*` 和 `PATCH/DELETE /api/auth/devices/current`（否则 403 `{code:"read_only"}`）。`DRIVELENS_OWNER_KEY_MODE=pair-only` 时服务器 Token 只能访问 `/api/auth/*`（否则 403 `{code:"owner_key_pair_only"}`）。建不了表（没有 CREATE 权限）时 `device_auth:false`，服务器 Token 照常可用，其他 `/api/auth/*` 返回 503 `{code:"device_auth_unavailable"}`。需要数据库的测试：`DRIVELENS_TEST_DATABASE_URL=postgres://… cargo test`（未设置时跳过）。
- App 按 `api_level` 决定显示哪些功能（`app/src/version.ts` 的 `FEATURE_LEVEL`）。新增需要服务器支持的功能时：API 的 `API_LEVEL` 加 1，前端加对应的 `FEATURE_LEVEL`，旧服务器上隐藏该功能并提示更新。
- 环境变量见安装指南的「环境变量」一节（`DATABASE_URL`、`API_TOKEN`、`BIND_ADDR`、`DRIVELENS_CORS_ORIGINS`、`DRIVELENS_TRUST_PROXY_HEADERS`、`DRIVELENS_PUSH_HOSTS`、`DRIVELENS_VAPID_*`、`RUST_LOG`）。

## 数据库原则

- **绝不修改 TeslaMate 的表**。对 TeslaMate 只有 SELECT；DriveLens 自己的数据（地点别名、手动费用、旅程、天气缓存、推送订阅等）只放在 `drivelens` schema。
- `deploy/setup.sql` 创建只读账号 `drivelens_ro` 和 `drivelens` schema（可重复执行）；API 启动时自动创建 / 升级 `drivelens` 里的表（`main.rs` 的 `migrate()`、`phase2::try_migrate`、`push::try_migrate`）。没有权限或表不存在时只关闭对应功能，并在启动日志里显示 `disabled features: …`。
- `deploy/drivelens-init.sql`、`drivelens-v*.sql` 是早期手动建表的安装用的升级脚本，新安装不需要。
- 能耗按 TeslaMate Grafana 的算法：`(起始额定续航 − 结束额定续航) × cars.efficiency`。

## 前端要点

- 文案：`app/src/locales/{zh,en,ja}.ts`；格式化（日期、时长、月份）：`app/src/i18n.ts`。
- 网页版的 Token 只存在浏览器的 localStorage（`drivelens-settings`）。`src/urlguard.ts` 最先执行，去掉地址栏里的 `api` / `token` / `key` 参数；App 不从 URL 读取服务器地址或 Token。
- 往 `innerHTML` 里拼接的数据一律转义（各模块的 `esc()`）或用 `textContent`；`?view=` 等深链接参数先校验格式。
- CSP：网页版在 `app/web-public/_headers`，Tauri 在 `app/src-tauri/tauri.conf.json`；不要引入外部脚本或字体。
- 弹出菜单统一用 `ui.ts` 的 `popMenu()` / `placePopover()`；弹层（`.modal`）由 `sheets.ts` 贴合可视视口（iOS 键盘）。
- Service Worker（`vite.config.ts` 生成）只缓存 App 外壳，从不缓存 API 响应。

## 原生 App（暂停）

Windows / Android 打包从 v0.15.0 起暂停：`.github/workflows/windows.yml`、`android.yml` 只能手动运行，`scripts/release.conf` 为 `NATIVE_BUILDS=0`。Android 工程在 `app/src-tauri/gen/android`（自定义部分在 `MainActivity.kt`、`network_security_config.xml`、`build.gradle.kts`）；签名配置通过 `DRIVELENS_KEYSTORE_PROPERTIES` 或已 gitignore 的 `gen/android/keystore.properties` 提供。本地构建：`npm run tauri dev` / `npx tauri android dev`（需要 JDK 17+、Android SDK、NDK 27）。

## 发布（维护者）

- `scripts/release.sh`：推送 main → 等 Docker 镜像（`ghcr.io/zzflsxygod/drivelens-api`，amd64 + arm64，`.github/workflows/docker.yml`）构建完成 → `api/` 有改动时等服务器 `/health` 显示新版本 → 打 tag，`web.yml` 构建网页版并部署 → 发布 Release。`X.Y.Z` 为正式版（Latest），带后缀的版本为预发布。
- 发布说明取自根目录 `CHANGELOG.md` 中对应版本的段落；版本号要同时改 `api/Cargo.toml`（服务器有改动时）、`app/package.json`、`app/src-tauri/tauri.conf.json`、`app/src-tauri/Cargo.toml`。
- 网页版部署需要仓库 secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（fork 没有时自动跳过部署，只上传构建产物）。

## 许可证

- DriveLens：GNU AGPL-3.0-or-later（[LICENSE](../LICENSE)）。网页版设置页「帮助与反馈」里有源代码链接（AGPL 第 13 条）。
- 电池健康度的 SQL 移植自 TeslaMate（AGPL-3.0-or-later），见 `api/src/insights.rs` 的说明和 [third_party/teslamate/NOTICE](../third_party/teslamate/NOTICE)。
- 依赖的许可证：`scripts/third-party-licenses.sh` 重新生成 `api/THIRD_PARTY_LICENSES.txt`（打进 Docker 镜像 `/usr/share/doc/drivelens/`）并检查兼容性；前端的列表在构建时生成（`/third-party-licenses.txt`）。
- 演示路线 `app/src/demo/routes.json`：© OpenStreetMap contributors（ODbL），海拔来自 Copernicus DEM（经 Open-Meteo，CC BY 4.0）。
