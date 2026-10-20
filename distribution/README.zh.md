# DriveLens

[English](README.md) · **中文** · [日本語](README.ja.md)

DriveLens 是 [TeslaMate](https://github.com/teslamate-org/teslamate) 的配套 App。它通过你服务器上的一个小型只读 API 读取你自己的 TeslaMate 数据库，用简洁的移动端界面展示车辆状态、行程、充电、旅程和月度报告。

- **网页版：** https://drivelens-app.oharuru.com （手机、电脑都能用，可以添加到主屏幕，PWA）
- **没有服务器也能体验：** [打开演示模式](https://drivelens-app.oharuru.com/?demo)（虚构的车辆和数据，不会上传任何内容）
- **自建后台：** [安装指南](docs/install.zh.md) · [English](docs/install.md) · [日本語](docs/install.ja.md)
- **更新内容：** [CHANGELOG](CHANGELOG.md)（英文）· [Releases](https://github.com/zzflsxygod/drivelens-releases/releases)
- **反馈：** [Issues](https://github.com/zzflsxygod/drivelens-releases/issues/new/choose)
- **支持 DriveLens：** [Buy Me a Coffee](https://buymeacoffee.com/zzflsxygod)

**当前版本：1.0.0**，第一个正式版（[发布说明](https://github.com/zzflsxygod/drivelens-releases/releases/tag/v1.0.0)）。

<p>
  <img src="screenshots/home-light.jpg" width="200" alt="首页">
  <img src="screenshots/drives.jpg" width="200" alt="行程">
  <img src="screenshots/journey.jpg" width="200" alt="旅程">
</p>
<p>
  <img src="screenshots/report.jpg" width="200" alt="月度报告">
  <img src="screenshots/share-card.jpg" width="200" alt="分享卡片">
  <img src="screenshots/home-dark.jpg" width="200" alt="深色模式">
</p>

<sub>截图来自演示模式（虚构数据）。</sub>

## 功能

- **首页：** 电量、续航、里程、软件版本、车内外温度、当前位置地图、本月概览
- **行程和充电：** 无限滚动列表和月份标题、按车速着色的路线地图、充电曲线、每段行程的天气、按车速分档的能耗
- **旅程：** 把多段行程合并成一次旅程（有自动建议），可以设置封面照片和备注，生成分享卡片
- **月度报告：** 里程、电量、充电费用、家充 / 超充占比、每日明细、足迹地图、12 个月趋势
- **电池健康度：** 根据额定续航计算的衰减曲线
- **通知（网页版）：** 行程结束时推送行程小结，每月 1 日提醒查看月报，可分别开关
- **自定义：** 修改地点名称、手动填写充电费用（支持多种货币）
- **语言：** English、中文、日本語
- **界面：** 简洁的仪表风格设计，浅色 / 深色主题（跟随系统，也可以在设置里切换），为手机竖屏设计，电脑上也能用
- **演示模式：** 用一辆虚构的车体验全部功能，不需要服务器

## 工作原理

```
DriveLens 网页版（PWA）──https + Token──> drivelens-api（你的服务器）──只读──> TeslaMate PostgreSQL
```

- App **直接连接你自己的服务器**。Token 和数据不会经过任何 DriveLens 的服务，网页版只是一份静态页面。
- drivelens-api 使用**只读**数据库账号，**不会修改 TeslaMate 的任何表**。它自己的数据（地点名称、费用、旅程、封面、天气缓存）放在独立的 `drivelens` schema 里。
- 使用网页版时服务器需要 https 地址（Cloudflare Tunnel 或 `tailscale serve` 都可以），详见[安装指南](docs/install.zh.md)。

## 前提

- 已经用 Docker Compose 运行 TeslaMate
- x86_64 或 ARM64 服务器（树莓派也可以）；镜像 `ghcr.io/zzflsxygod/drivelens-api` 公开提供 amd64 和 arm64 版本
- 能从外部安全访问服务器的方式（推荐 Cloudflare Tunnel 或 Tailscale）

## 快速开始

```bash
cd teslamate   # TeslaMate 的 compose 目录
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/docker-compose.drivelens.yml
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
source .env
docker compose exec -T database psql -U teslamate -d teslamate -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

然后让服务器能通过 https 访问，在 App 里填写地址和 `DRIVELENS_API_TOKEN` 即可。每一步的说明见[安装指南](docs/install.zh.md)。

## 支持

DriveLens 由个人开发和维护，可以免费使用。如果它对你有帮助，欢迎[请开发者喝杯咖啡](https://buymeacoffee.com/zzflsxygod) ☕。App 设置页底部也有这个链接。

## 许可

DriveLens **可以免费使用**，但**不是开源软件**，源码不公开。详见 [LICENSE](LICENSE)。

DriveLens 是独立项目，与 Tesla, Inc. 及 TeslaMate 项目无关。地图 © [OpenFreeMap](https://openfreemap.org) / © [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者。天气数据来自 [Open-Meteo](https://open-meteo.com)。
