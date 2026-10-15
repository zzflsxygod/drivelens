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
（手机上请务必使用 HTTPS 地址，iOS/Android 默认禁止明文 HTTP。）

### Android

1. 安装 Android Studio、SDK + NDK，设置 `ANDROID_HOME`、`NDK_HOME`、`JAVA_HOME`
2. `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
3. 执行：
   ```bash
   npm run tauri android init
   npm run tauri android dev          # 连接手机或模拟器调试
   npm run tauri android build --apk
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

`testdata/schema.sql` 是按 TeslaMate 的 Ecto 表结构整理的子集（只含本应用用到的表），**仅用于测试**，不要在真实 TeslaMate 数据库上执行。
