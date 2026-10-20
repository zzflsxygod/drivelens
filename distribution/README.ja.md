# DriveLens

[English](README.md) · [中文](README.zh.md) · **日本語**

DriveLens は [TeslaMate](https://github.com/teslamate-org/teslamate) のためのアプリです。ご自身のサーバー上で動く小さな読み取り専用 API を通して TeslaMate のデータベースを読み込み、車両の状態、走行、充電、旅程、月次レポートをスマートフォン向けのすっきりした画面で表示します。

- **ウェブ版：** https://drivelens-app.oharuru.com （スマートフォンでも PC でも使え、ホーム画面に追加できます。PWA）
- **サーバーなしで試す：** [デモを開く](https://drivelens-app.oharuru.com/?demo)（架空の車両とデータ。何も送信されません）
- **バックエンドを導入する：** [インストールガイド](docs/install.ja.md) · [English](docs/install.md) · [中文](docs/install.zh.md)
- **更新情報：** [CHANGELOG](CHANGELOG.md)（英語）· [Releases](https://github.com/zzflsxygod/drivelens-releases/releases)
- **フィードバック：** [Issues](https://github.com/zzflsxygod/drivelens-releases/issues/new/choose)

<p>
  <img src="screenshots/home-light.jpg" width="200" alt="ホーム">
  <img src="screenshots/drives.jpg" width="200" alt="走行">
  <img src="screenshots/journey.jpg" width="200" alt="旅程">
</p>
<p>
  <img src="screenshots/report.jpg" width="200" alt="月次レポート">
  <img src="screenshots/share-card.jpg" width="200" alt="シェアカード">
  <img src="screenshots/home-dark.jpg" width="200" alt="ダークモード">
</p>

<sub>スクリーンショットはデモモード（架空のデータ）のものです。</sub>

## 機能

- **ホーム：** バッテリー残量、航続距離、走行距離、ソフトウェアバージョン、車内外の気温、現在地の地図、今月の概要
- **走行と充電：** 月見出し付きの無限スクロール、速度で色分けしたルート地図、充電カーブ、走行ごとの天気、速度帯別の電費
- **旅程：** 複数の走行を 1 つの旅程にまとめる（自動提案あり）、カバー写真とメモ、シェアカードの作成
- **月次レポート：** 走行距離、電力量、充電料金、自宅 / スーパーチャージャーの内訳、日別の内訳、足跡マップ、12 か月の推移
- **バッテリーの健康度：** 定格航続距離にもとづく劣化カーブ
- **通知（Web 版）：** 走行終了時の走行サマリーと、毎月1日の月次レポートのお知らせ（個別にオン／オフ可）
- **カスタマイズ：** 地点名の変更、充電料金の手入力（複数通貨対応）
- **言語：** English、中文、日本語 · ライト / ダークテーマ

## しくみ

```
DriveLens アプリ（ウェブ / Windows / Android）──https + トークン──> drivelens-api（ご自身のサーバー）──読み取り専用──> TeslaMate PostgreSQL
```

- アプリは**ご自身のサーバーに直接**接続します。トークンやデータが DriveLens のサービスを経由することはありません。ウェブ版は静的ファイルだけです。
- drivelens-api は**読み取り専用**のデータベースアカウントを使い、**TeslaMate のテーブルを一切変更しません**。独自のデータ（地点名、料金、旅程、カバー画像、天気キャッシュ）は独立した `drivelens` スキーマに保存されます。
- ウェブ版を使うにはサーバーの https アドレスが必要です（Cloudflare Tunnel や `tailscale serve`）。詳しくは[インストールガイド](docs/install.ja.md)をご覧ください。

## 前提条件

- Docker Compose で TeslaMate を運用していること
- x86_64 または ARM64 のサーバー（Raspberry Pi も可）
- 外部から安全にサーバーへ接続する手段（Cloudflare Tunnel または Tailscale を推奨）

## クイックスタート

```bash
cd teslamate   # TeslaMate の compose ディレクトリ
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/docker-compose.drivelens.yml
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
source .env
docker compose exec -T database psql -U teslamate -d teslamate -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

あとはサーバーを https で接続できるようにし、アプリにアドレスと `DRIVELENS_API_TOKEN` を入力するだけです。各手順の説明は[インストールガイド](docs/install.ja.md)にあります。

## ライセンス

DriveLens は**無料で使えます**が、**オープンソースではありません**。ソースコードは公開していません。詳しくは [LICENSE](LICENSE) をご覧ください。

DriveLens は独立したプロジェクトで、Tesla, Inc. および TeslaMate プロジェクトとは関係ありません。地図 © [OpenFreeMap](https://openfreemap.org) / © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。天気データは [Open-Meteo](https://open-meteo.com) によるものです。
