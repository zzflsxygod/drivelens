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

**新用户请看 [docs/install.md](docs/install.md)**：执行一次 `deploy/setup.sql`（只读账号 + drivelens schema），用 `deploy/docker-compose.drivelens.yml` 启动 API；API 启动时自动创建 / 升级 drivelens 的表，App 首次打开有连接向导。
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
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate API_TOKEN=dev-token-1234567890 cargo run
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
- 发布流程：`scripts/release.sh [https://你的域名]` —— 推送 main → 等 Docker 镜像构建成功 → 等服务器 `/health` 显示新版本 → 打 tag 构建 Windows 安装包（草稿）→ 发布为预发布版本。


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
- 安装指南：[中文](docs/install.md) · [English](docs/install.en.md) · [日本語](docs/install.ja.md)。服务器无需更新（API 未变）。

## v0.14.1 — 弹出菜单定位修复

所有弹出菜单（引导页语言、车辆切换、行程月份跳转、设置里的下拉框、旅程 ⋯ 菜单）都改用 `ui.ts` 里同一个定位函数 `placePopover()` / `trackPopover()`：
- 按锚点所在的一侧对齐左边或右边，并限制在可视区域内。可视区域会扣掉安全区（刘海、手势条）、顶栏和底部导航。
- 根据上下哪边空间大，自动向上或向下弹出；内容超过可用高度时在菜单内部滚动。
- 窗口缩放、横竖屏切换、键盘弹出和页面滚动时自动重新定位；锚点滚出屏幕时自动关闭菜单。

## v0.14.2 — 演示模式顶栏固定、手机版锁定竖屏

- 演示模式的提示条（含“退出”按钮）现在是顶栏里的最后一行，跟顶栏一起固定在最上方，滚动时不再往上漂移。原因：提示条是顶栏外单独的 sticky 元素，`top` 写死为 49px，而 v0.12 起顶栏实际高 59px，一滚动就上移 10px、钻到顶栏下面。
- 顶栏的实际高度由 `ResizeObserver` 测量并写入 CSS 变量 `--hdr-h`（含安全区和演示提示条），服务器提示条、列表月份标题、页面返回栏都按它吸顶，不再被顶栏遮住一截。
- Android 版锁定竖屏（`AndroidManifest.xml` 里 `android:screenOrientation="portrait"`）。Windows 窗口不受影响，仍可自由缩放。服务器无需更新（API 未变）。
