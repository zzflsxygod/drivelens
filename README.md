# TeslaMate Viewer（第三方 App）

读取 TeslaMate 数据库，展示**充电记录**、**行程列表**和**行程路线地图**。

```
手机 / 电脑 App (Tauri 2)  ──HTTPS + Bearer Token──>  Caddy/Nginx (443)  ──>  teslamate-api (127.0.0.1:8080)  ──>  PostgreSQL (TeslaMate)
```

## 目录结构

```
teslamate-app/
├── api/                      # Rust Axum 只读 API（部署到 Oracle 云服务器）
│   ├── src/main.rs
│   └── teslamate-api.service # systemd 单元示例
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
| `GET /api/charges?car_id=&limit=&offset=` | 充电记录（时间、地点、充入/消耗 kWh、费用、起止电量、时长） |
| `GET /api/charges/:id` | 单次充电详情 + 充电曲线（`charges` 表） |
| `GET /api/drives?car_id=&limit=&offset=` | 行程（起止时间/地址、距离、时长、能耗 kWh、效率 Wh/km） |
| `GET /api/drives/:id/path` | 行程 GPS 轨迹（`positions` 表） |

环境变量：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 如 `postgres://teslamate_ro:密码@127.0.0.1:5432/teslamate` |
| `API_TOKEN` | 至少 16 位的随机字符串，生成：`openssl rand -hex 32` |
| `BIND_ADDR` | 默认 `127.0.0.1:8080`（只监听本机，由反向代理对外） |

> 能耗按 TeslaMate Grafana 的算法估算：`(起始额定续航 - 结束额定续航) × cars.efficiency`。

## 部署到 Oracle Cloud

### 1. 编译

在服务器上直接编译（Oracle 免费 ARM 实例也可以）：

```bash
curl https://sh.rustup.rs -sSf | sh
cd teslamate-app/api && cargo build --release
sudo cp target/release/teslamate-api /usr/local/bin/
```

### 2. 创建只读数据库用户（推荐）

TeslaMate 一般用 Docker Compose 运行。进入数据库容器：

```bash
docker compose exec database psql -U teslamate teslamate
```

```sql
CREATE ROLE teslamate_ro LOGIN PASSWORD '换成强密码';
GRANT CONNECT ON DATABASE teslamate TO teslamate_ro;
GRANT USAGE ON SCHEMA public TO teslamate_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO teslamate_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO teslamate_ro;
```

API 需要能连到数据库。在 `docker-compose.yml` 的 `database` 服务里**只映射到本机回环地址**：

```yaml
    ports:
      - "127.0.0.1:5432:5432"
```

⚠️ **不要**写成 `"5432:5432"`，也不要在 Oracle 安全列表 / 防火墙里放行 5432。PostgreSQL 绝不能暴露到公网。

### 3. systemd 服务

```bash
sudo tee /etc/teslamate-api.env >/dev/null <<EOF
DATABASE_URL=postgres://teslamate_ro:强密码@127.0.0.1:5432/teslamate
API_TOKEN=$(openssl rand -hex 32)
BIND_ADDR=127.0.0.1:8080
EOF
sudo chmod 600 /etc/teslamate-api.env
sudo cp api/teslamate-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now teslamate-api
sudo journalctl -u teslamate-api -f
sudo cat /etc/teslamate-api.env   # 记下 API_TOKEN，填到 App 里
```

### 4. HTTPS 反向代理（Caddy，自动申请证书）

先把域名（如 `tm-api.example.com`）解析到服务器公网 IP。

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
tm-api.example.com {
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
curl https://tm-api.example.com/health
curl -H "Authorization: Bearer 你的TOKEN" "https://tm-api.example.com/api/charges?limit=3"
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

首次打开 App 进入「设置」，填 API 地址（如 `https://tm-api.example.com`）和 Token，点「保存并测试连接」。
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
