# DriveLens

[English](README.md) · [中文](README.zh.md) · **日本語**

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/zzflsxygod)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

DriveLens は [TeslaMate](https://github.com/teslamate-org/teslamate) のためのサードパーティアプリです。ご自身のサーバーで動く小さな読み取り専用 API（**drivelens-api**）が TeslaMate のデータベースを読み、DriveLens ウェブ版がクルマの状態、走行、充電、旅、月次レポート、バッテリー健全性を、スマートフォン向けのすっきりした画面で表示します。

- **ウェブ版：** [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) （スマートフォンでも PC でも使え、ホーム画面に追加できます）
- **サーバーなしで試す：** [デモモード](https://drivelens-app.oharuru.com/?demo)（架空のクルマ、サーバー不要）
- **サーバーの設定：** [インストールガイド](docs/install.ja.md) · [English](docs/install.md) · [中文](docs/install.zh.md)
- **更新情報：** [CHANGELOG](CHANGELOG.md)（英語）· [Releases](https://github.com/zzflsxygod/drivelens/releases)

<p>
  <img src="docs/screenshots/home-light.jpg" width="200" alt="ホーム">
  <img src="docs/screenshots/drives.jpg" width="200" alt="走行">
  <img src="docs/screenshots/journey.jpg" width="200" alt="旅">
</p>
<p>
  <img src="docs/screenshots/report.jpg" width="200" alt="月次レポート">
  <img src="docs/screenshots/share-card.jpg" width="200" alt="シェアカード">
  <img src="docs/screenshots/home-dark.jpg" width="200" alt="ダークモード">
</p>

<sub>スクリーンショットはデモモード（架空のデータ）です。</sub>

## 機能

- **ホーム：** 充電率、航続距離、走行距離計、ソフトウェアバージョン、車内外の温度、地図上の現在地、今月の概要
- **走行と充電：** 無限スクロールの一覧、速度で色分けしたルート地図、充電カーブ、走行ごとの天気、速度帯別の電費
- **旅：** 複数の走行を 1 つの旅にまとめる（自動提案あり）、カバー写真とメモ、シェアカード
- **月次レポート：** 走行距離、電力量、充電料金、自宅 / スーパーチャージャーの内訳、日別の明細、足あとマップ、12 か月の推移
- **バッテリー健全性：** 健全性 %、現在 / 新車時の使用可能容量（kWh）、劣化と充電サイクル。TeslaMate の Battery Health ダッシュボードと同じ方法で計算します
- **通知：** 走行が終わると走行のまとめ、毎月 1 日に月次レポートのお知らせ（ウェブプッシュ。ご自身のサーバーから送信）
- **名前と料金：** 場所の名前を変更、充電料金を手入力（通貨は自由）
- 日本語 / English / 中文 · ライト / ダークテーマ · デモモード

## しくみ

```
DriveLens ウェブ版  ──https + トークン──>  drivelens-api（あなたのサーバー）  ──読み取り専用──>  TeslaMate PostgreSQL
```

- ウェブ版は**あなたのサーバーに直接**接続します。中身は静的ファイルだけで、間に DriveLens のサーバーはありません。
- drivelens-api は**読み取り専用**のデータベースアカウントで接続し、**TeslaMate のテーブルを変更することはありません**。DriveLens 独自のデータ（場所の名前、料金、旅、プッシュの登録、天気のキャッシュ）は別の `drivelens` スキーマに保存します。
- サーバーのイメージ `ghcr.io/zzflsxygod/drivelens-api` は linux/amd64 と linux/arm64 向けに公開しています。
- ウェブ版を使うには、サーバーに **https** のアドレスが必要です（Cloudflare Tunnel または `tailscale serve`）。

## クイックスタート（サーバー）

前提：TeslaMate が Docker Compose で動いていること（x86_64 または ARM64）。

```bash
cd teslamate   # TeslaMate の docker-compose.yml があるディレクトリ
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/docker-compose.drivelens.yml
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
source .env
docker compose exec -T database psql -U teslamate -d teslamate -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

次にサーバーへ https のアドレスを用意し（[Cloudflare Tunnel](docs/install.ja.md#cloudflare-tunnel) または [Tailscale](docs/install.ja.md#tailscale)）、[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) を開いてそのアドレスと `DRIVELENS_API_TOKEN` を入力します。各手順は[インストールガイド](docs/install.ja.md)で説明しています。

DriveLens は公式ウェブ版 [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) でお使いください。ウェブ版のセルフホストは公式サポートの対象外です。

## プライバシー

- サーバーのアドレスとトークンはお使いのブラウザにだけ保存され、**ご自身のサーバーにしか送信されません**。これらをほかの場所へ送る機能を DriveLens に追加することはありません。
- テレメトリ、アクセス解析、トラッキングはありません。
- 詳しくは [SECURITY.md](SECURITY.md)（英語）をご覧ください。

## 応援

DriveLens は個人で開発しており、無料で使えます。役に立ったら [Buy Me a Coffee](https://buymeacoffee.com/zzflsxygod) で応援していただけるとうれしいです ☕。

## 開発に参加する

不具合や要望は [Issues](https://github.com/zzflsxygod/drivelens/issues) へどうぞ。新しい機能に取りかかる前に Issue で相談してください。小さな修正はそのままプルリクエストで構いません。各コミットには DCO の `Signed-off-by` が必要です。API とアプリをローカルで動かす方法は [CONTRIBUTING.md](CONTRIBUTING.md)（英語）にあります。セキュリティの問題は非公開で報告してください（[SECURITY.md](SECURITY.md)）。

## ライセンス

Copyright (C) 2026 zzflsxygod。DriveLens は [GNU AGPL-3.0-or-later](LICENSE) のフリーソフトウェアです。改変したものをネットワークサービスとして提供する場合は、その利用者にソースコードを提供する必要があります。フォークには別の名前とロゴを使ってください。

DriveLens は独立したプロジェクトで、Tesla, Inc. および TeslaMate プロジェクトとは関係ありません。地図 © [OpenFreeMap](https://openfreemap.org) / © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。天気データは [Open-Meteo](https://open-meteo.com) によるものです。

バッテリー劣化の計算は [TeslaMate](https://github.com/teslamate-org/teslamate) の Grafana ダッシュボードに由来します（Copyright (C) TeslaMate contributors、AGPL-3.0-or-later。改変あり、[third_party/teslamate/NOTICE](third_party/teslamate/NOTICE) を参照）。デモのルート（`app/src/demo/routes.json`）は © OpenStreetMap contributors、[ODbL](https://opendatacommons.org/licenses/odbl/) ライセンスです。標高データは Copernicus DEM（Open-Meteo 経由、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）です。同梱しているサードパーティライブラリのライセンスは [api/THIRD_PARTY_LICENSES.txt](api/THIRD_PARTY_LICENSES.txt)（サーバー）とウェブ版の `/third-party-licenses.txt` を参照してください。
