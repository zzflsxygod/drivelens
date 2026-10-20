# DriveLens 安装指南（自建 TeslaMate 用户）

[English](install.md) · **中文** · [日本語](install.ja.md)

DriveLens 由两部分组成：

- **drivelens-api**：一个运行在你的 TeslaMate 服务器上的小服务（Docker 容器），用只读账号读取 TeslaMate 数据库。
- **DriveLens App**：手机 / 电脑上的客户端，首次打开时填写服务器地址和 Token 即可。

> DriveLens **不会修改 TeslaMate 的任何表**。它对 TeslaMate 的表只有 SELECT 权限；自己的数据（地点别名、手动充电费用、旅程、封面、天气缓存）全部放在独立的 `drivelens` schema 里。

## 前提

- 已经用 Docker Compose 运行 TeslaMate（官方 `docker-compose.yml`，数据库服务名为 `database`，数据库名 / 管理员默认都是 `teslamate`）。
- 服务器可以是 x86_64 或 ARM64（树莓派等）。
- 有办法从外部安全访问服务器：**推荐 Cloudflare Tunnel 或 Tailscale**（见第 5 步）。

## 1. 下载两个文件

在 TeslaMate 的 compose 目录（有 TeslaMate `docker-compose.yml` 的目录）执行：

```bash
cd teslamate   # TeslaMate 的 docker-compose.yml 所在目录
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/docker-compose.drivelens.yml
```

不需要源码：drivelens-api 是预先构建好的 Docker 镜像（`ghcr.io/zzflsxygod/drivelens-api`，支持 linux/amd64 和 linux/arm64），第 4 步由 Docker 自动下载。

```
teslamate/
├── docker-compose.yml               # TeslaMate 原有的
├── docker-compose.drivelens.yml     # DriveLens API 服务
├── setup.sql                        # 一次性数据库设置
└── .env
```

## 2. 生成密码和 Token，写入 `.env`

在 TeslaMate 的 compose 目录执行：

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS`：DriveLens 只读数据库账号 `drivelens_ro` 的密码。
- `DRIVELENS_API_TOKEN`：App 连接服务器用的 Token（**至少 16 位，建议 32 位以上随机字符串**；太短时 API 启动日志和 App 都会提示）。

## 3. 创建数据库账号（只需一次）

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
```

`setup.sql` 可以重复执行，它会：

1. 创建登录角色 `drivelens_ro`（已存在则只更新密码）；
2. 授予 TeslaMate 表的 **SELECT** 权限（包括 TeslaMate 以后升级新建的表）；
3. 授予 `cars / addresses / drives / charging_processes` 的 REFERENCES 权限（DriveLens 的表用外键引用它们，TeslaMate 删除行程时相关数据自动清理；**不包含任何写权限**）；
4. 创建 `drivelens` schema 并交给 `drivelens_ro`。

之后 API 每次启动都会**自动在 `drivelens` schema 里建表 / 升级**（幂等），不需要再手动执行任何 SQL。

> 如果你的数据库名或管理员不是 `teslamate`，把命令里的 `-U` / `-d` 换掉，并在 `.env` 加 `DRIVELENS_DB_NAME=你的数据库名`。

## 4. 启动 drivelens-api

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

镜像很小，几秒内就能启动。日志里看到：

```
INFO drivelens_api: all features enabled (API level 12)
INFO drivelens_api: listening on 0.0.0.0:8080
```

就说明一切正常。如果看到 `disabled features: …` 或 `cannot read TeslaMate tables`，说明第 3 步没有执行成功，重新执行 `setup.sql` 后 `docker compose restart drivelens-api` 即可。只读功能（行程、充电、报告等）在这种情况下仍然可用。

本机测试：`curl http://127.0.0.1:8080/health` 应返回 `{"status":"ok","version":"…","api_level":…}`。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:密码@database:5432/teslamate`（compose 文件已用 `.env` 拼好） |
| `API_TOKEN` | ✅ | App 用的 Bearer Token，至少 16 位，建议 32 位以上 |
| `BIND_ADDR` | | 监听地址，镜像默认 `0.0.0.0:8080` |
| `DRIVELENS_CORS_ORIGINS` | | 允许在浏览器里访问 API 的网页来源，逗号分隔（v0.11.0+；旧名 `CORS_ORIGINS` 仍有效）。默认只允许官方网页版 `https://drivelens-app.oharuru.com`；Windows / Android App 的来源总是自动允许。`*` 表示允许任意来源 |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | 网页推送的签名密钥（base64url 编码的 P-256 私钥，v0.12.0+）。一般不用设置：API 首次启动时会自动生成，并保存在 `drivelens` schema 里 |
| `DRIVELENS_VAPID_SUBJECT` | | 发送通知时附带给浏览器推送服务的联系方式（`mailto:you@example.com` 或 https 网址）。默认是 DriveLens 项目页面 |
| `RUST_LOG` | | 日志级别，默认 `info` |

compose 文件里用到的 `.env` 变量：`DRIVELENS_DB_PASS`、`DRIVELENS_API_TOKEN`，可选 `DRIVELENS_DB_NAME`（默认 teslamate）、`DRIVELENS_IMAGE`（默认 `ghcr.io/zzflsxygod/drivelens-api:latest`；想固定版本时设为例如 `…:v0.15.1`）。

### 更新

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

数据库结构由 API 启动时自动升级。新版本和更新说明见 [Releases](https://github.com/zzflsxygod/drivelens-releases/releases)。

**自动更新（可选）**：取消 `docker-compose.drivelens.yml` 末尾 `watchtower` 服务的注释，再执行一次 `up -d`。它只更新带 `com.centurylinklabs.watchtower.enable=true` 标签的容器（drivelens-api 已带），每 6 小时检查一次。

## 5. 从外部安全访问（二选一）

**不要把 8080 端口直接暴露到公网**（没有 https 时 Token 会被明文传输）。

### 方案 A：Cloudflare Tunnel（推荐，有域名时）

1. 在 Cloudflare Zero Trust → Networks → Tunnels 创建一个 Tunnel，复制 Token。
2. 取消 `docker-compose.drivelens.yml` 里 `cloudflared` 一段的注释，并在 `.env` 加 `CLOUDFLARE_TUNNEL_TOKEN=…`；此时可以删掉 `drivelens-api` 的 `ports:`。
3. 在 Tunnel 的 Public Hostname 里添加 `drivelens.你的域名` → `http://drivelens-api:8080`（cloudflared 装在宿主机上时填 `http://127.0.0.1:8080`）。
4. App 里填 `https://drivelens.你的域名`。

<a id="tailscale"></a>
### 方案 B：Tailscale（没有域名 / 不想公开时）

网页版是通过 https 打开的，所以浏览器会拦截 `http://` 的服务器地址，**局域网和 Tailscale 的 IP 也一样**（比如 `http://100.x.y.z:8080`，属于混合内容）。用 `tailscale serve` 可以免费给服务器一个 https 地址，而且只有你的 tailnet 能访问：

1. 服务器（装在宿主机上，即普通安装方式）和手机 / 电脑都安装 Tailscale，并登录同一个 tailnet。
2. 在 Tailscale 管理后台 → [DNS](https://login.tailscale.com/admin/dns) 打开 **MagicDNS** 和 **HTTPS Certificates**（每个 tailnet 只需一次）。
3. 在服务器上执行：
   ```bash
   sudo tailscale serve --bg 8080
   ```
   它会把 `https://机器名.你的tailnet.ts.net` 转发到 `http://127.0.0.1:8080`，重启后也会自动恢复。用 `tailscale serve status` 可以查看地址。compose 里保持默认的 `127.0.0.1:8080:8080` 即可，不用改端口。第一次访问时要签发证书，可能要等几秒。
4. DriveLens 里填 `https://机器名.你的tailnet.ts.net`（不带端口）。使用的设备需要连着 Tailscale。

- **CORS**：不用额外设置。API 默认允许官方网页版；API 自己的地址不需要写进 `DRIVELENS_CORS_ORIGINS`。
- **Chrome / Edge** 可能会询问是否允许该网站「访问本地网络上的设备」（因为 ts.net 地址指向 100.x 的 IP），请选「允许」。如果之前点了拦截，在网站设置（地址栏左侧的锁形图标）里重新允许。
- 证书会把机器名（`机器名.你的tailnet.ts.net`）记录到公开的证书透明度日志里，介意的话请先改好机器名。
- 停止：`sudo tailscale serve --https=443 off`。

> 安全措施：Token 比较为常数时间；同一 IP 10 分钟内认证失败 10 次会被暂时拒绝（HTTP 429）；API 对 TeslaMate 的表只读。

## 6. 安装并配置 App

1. 打开网页版 **https://drivelens-app.oharuru.com**（手机、电脑都能用，可以添加到主屏幕，见第 7 步）；或者在 [Releases](https://github.com/zzflsxygod/drivelens-releases/releases) 页面下载 Windows / Android 安装包（有对应平台的安装包时）。
2. 首次打开会显示「欢迎使用 DriveLens」（界面语言跟随系统，右上角可切换）：
   - **服务器地址**：第 5 步的地址，例如 `https://drivelens.example.com`；
   - **API Token**：`.env` 里的 `DRIVELENS_API_TOKEN`。
3. 点「测试连接并开始」。App 会先检查 `/health`，再用 Token 读取车辆，失败时会提示具体原因：

| 提示 | 处理 |
| --- | --- |
| Token 不正确（401） | 重新复制 `DRIVELENS_API_TOKEN`，不要带空格或引号 |
| 无法连接 / 连接超时 | 检查地址、Tunnel 或 Tailscale 是否在运行；网页版必须填 `https://` 地址（Cloudflare Tunnel，或 `tailscale serve` 的 `https://…ts.net`） |
| 返回的不是 DriveLens API | 填成了 TeslaMate / Grafana 的地址，改成 drivelens-api 的地址 |
| 服务器版本过旧 | 按「更新」步骤更新 drivelens-api |
| 错误次数太多（429） | 等 10 分钟后再试 |

之后可以随时在「设置」中修改服务器地址和 Token（新设置测试成功才会保存）。界面语言（中文 / English / 日本語）、地图文字语言和默认货币按手机语言自动选择，也可以在「设置」中修改。

## 7. 网页版（PWA）

不想安装 App 时，可以直接在浏览器里打开 **https://drivelens-app.oharuru.com**，填写服务器地址和 Token 即可使用（也可以先点「先体验演示」）。网页版只是一份静态页面：它从你的浏览器直接访问**你自己的** drivelens-api，Token 和数据不会经过网页服务器。

**服务器要求**

- **drivelens-api v0.11.0 以上**：默认允许官方网页版跨域访问（CORS）。设置过 `DRIVELENS_CORS_ORIGINS` 时，记得把 `https://drivelens-app.oharuru.com` 也写进去，例如：
  ```yaml
  environment:
    - DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com
  ```
- **必须是 https**：浏览器不允许 https 网页访问 `http://` 地址（混合内容）。用 Cloudflare Tunnel（方案 A）即可；用 Tailscale 时请开启 `tailscale serve`，填 `https://机器名.你的tailnet.ts.net`，不要用 `http://100.x.y.z:8080`（见[方案 B](#tailscale)）。
- 不要在 API 前面加 Cloudflare Access 之类的登录页面，浏览器的跨域请求会被它拦截。

**安装到主屏幕**

- Android（Chrome）/ 电脑（Chrome、Edge）：「设置」页底部的「安装为应用」，或浏览器菜单 →「安装应用」。
- iPhone / iPad（Safari）：「分享」→「添加到主屏幕」。安装后全屏、竖屏显示。

**通知（drivelens-api v0.12.0+）**

在“设置 → 通知”里可以为这台设备开启推送：行程结束时推送**行程小结**（距离、用时、电耗、起点 → 终点），每月 1 日（按设备时区，9 点以后）推送**月报提醒**。两种通知可以分别开关，点通知会直接打开对应的行程或月报。

- 服务器每分钟检查一次 TeslaMate 数据库里有没有新结束的行程，然后自己加密发送，经过浏览器的推送服务（Google / Apple / Mozilla）。所以 API 容器需要能访问这些服务的 https 地址。
- 不需要额外设置：签名密钥在首次启动时自动生成。密钥变了或丢了（比如换了数据库），每台设备都要重新开启一次通知。
- iPhone / iPad：需要 iOS 16.4 以上，并且要先把 DriveLens 添加到主屏幕，再从主屏幕打开。
- Android / 电脑：Chrome、Edge 或 Firefox。如果之前拦截过通知，请在网站设置里改为允许。

**说明**

- Token 保存在这个浏览器的本地存储里；在公共电脑上用完请在「设置」里清除。
- 离线缓存只包含网页本身（HTML / JS / CSS / 图标），API 返回的数据从不缓存。

| 网页版提示 | 处理 |
| --- | --- |
| 服务器没有允许本网站跨域访问（CORS） | 更新 drivelens-api 到 v0.11.0+，检查 `DRIVELENS_CORS_ORIGINS` |
| 浏览器会拦截 http 的服务器地址 | 改用 https 地址（Cloudflare Tunnel / [`tailscale serve`](#tailscale)） |
| 无法连接（https 证书 / 域名） | 检查域名、隧道是否在运行、证书是否有效 |

## 常见问题

- **日志 `password authentication failed for user "drivelens_ro"`**：`.env` 的 `DRIVELENS_DB_PASS` 和执行 `setup.sql` 时的密码不一致，重新执行第 3 步即可（会更新密码）。
- **日志 `API_TOKEN looks weak`**：Token 太短或太简单，建议换成 `openssl rand -hex 24` 生成的值，同时更新 App 设置。
- **卸载**：停止并删除 `drivelens-api` 容器，然后（可选）以管理员执行
  `DROP SCHEMA drivelens CASCADE; DROP OWNED BY drivelens_ro; DROP ROLE drivelens_ro;` —— 不会影响 TeslaMate 数据。

## 反馈

问题和功能建议请提交到 [Issues](https://github.com/zzflsxygod/drivelens-releases/issues)。请不要贴出你的服务器地址或 Token。
