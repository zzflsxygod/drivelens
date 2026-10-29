# DriveLens 開発ガイド

[English](DEVELOPMENT.md) · [中文](DEVELOPMENT.zh.md) · **日本語**

DriveLens は [TeslaMate](https://github.com/teslamate-org/teslamate) のサードパーティ製ビューアです。`drivelens-api`（Rust / Axum）は TeslaMate の PostgreSQL を読み取り専用で参照し、ウェブ版 / PWA（Vite + TypeScript）は HTTPS + Bearer Token で呼び出します。サーバーのインストールと運用はインストールガイドを参照してください：[English](install.md) · [中文](install.zh.md) · [日本語](install.ja.md)。貢献の流れは [CONTRIBUTING.md](../CONTRIBUTING.md)、セキュリティは [SECURITY.md](../SECURITY.md) です。

```
ブラウザ（ウェブ版 / PWA）──HTTPS + Bearer Token──>  トンネル / リバースプロキシ（Cloudflare Tunnel、tailscale serve…）──>  drivelens-api :8080  ──>  PostgreSQL（TeslaMate）
```

## ディレクトリ構成

```
drivelens/
├── api/                  # drivelens-api（Rust / Axum）、Dockerfile、deny.toml / about.toml（依存ライセンス）
│   └── src/              # main.rs（ルート、マイグレーション）、auth.rs（認証・デバイストークン）、summary / report / insights / journey / phase2 / push.rs
├── app/                  # フロントエンド（Vite + TypeScript + MapLibre GL）。同じコードでウェブ版と（一時停止中の）Tauri App をビルド
│   ├── src/              # main.ts エントリ、locales/{zh,en,ja}.ts 文言、demo/ デモモードデータ
│   ├── web-public/       # ウェブ版専用の静的ファイル（_headers、アイコン）
│   ├── scripts/          # check-i18n.mjs、demo/fetch-routes.py（デモルート生成）
│   └── src-tauri/        # Tauri 2 シェル（Windows / Android / iOS。現在は公開を一時停止）
├── deploy/               # setup.sql（DB ロール + drivelens スキーマ）、docker-compose.drivelens.yml；drivelens-*.sql は旧インストール向けのアップグレードスクリプト
├── docs/                 # インストールガイドと開発ガイド（3 言語）、スクリーンショット、本ファイル
├── scripts/              # release.sh（メンテナのリリース用）、third-party-licenses.sh
├── testdata/             # TeslaMate 互換のスキーマ一部 + サンプルデータ生成スクリプト（テスト専用）
└── third_party/          # サードパーティ声明（TeslaMate NOTICE）
```

## ローカル開発

前提：Rust stable（`rustup update`）、Node.js 20+、PostgreSQL（ローカルテスト用）。

```bash
# 1. テスト用データベース（testdata のみ。本物の TeslaMate データベースで schema.sql を実行しないこと）
sudo -u postgres psql -c "CREATE USER teslamate PASSWORD 'secret'" -c "CREATE DATABASE teslamate OWNER teslamate"
cd testdata && python3 gen_sample.py
PGPASSWORD=secret psql -h localhost -U teslamate teslamate -f schema.sql -f sample_data.sql

# 2. API
cd ../api
DATABASE_URL=postgres://teslamate:secret@localhost/teslamate API_TOKEN=dev-token-1234567890 \
  DRIVELENS_CORS_ORIGINS=http://localhost:1420,http://localhost:4174 cargo run

# 3. フロントエンド：ブラウザで http://localhost:1420/ を開き、初期設定で http://127.0.0.1:8080 と dev-token-1234567890 を入力
cd ../app && npm ci && npm run dev
```

- ウェブ版ビルド：`npm run build:web` → `app/dist-web/`（加えて `manifest.webmanifest`、App シェルのみをキャッシュする `sw.js`、`_headers`、`third-party-licenses.txt` を生成）；プレビュー：`npm run preview:web`（`http://localhost:4174`）。
- サーバーなしでもデモモードが使えます：初期設定の「デモを試す」、または `/?demo`（データは `app/src/demo/`、完全オフライン）。
- 性能テスト：サンプルデータのあと `testdata/bigdata.sql`（約 300 万件の positions）。バッテリー劣化の対照データ：`testdata/gen_battery_health.py`。
- ビルド変数：`VITE_DONATE_URL`（設定ページ下部の「サポート」カード。空 = 非表示）、`VITE_DONATE_WEB_ONLY=1`、`VITE_WEB_ORIGIN`（既定は公式ウェブ版の origin）、`VITE_DRIVELENS_CHANNEL=preview`（プレビューデプロイ専用：ヘッダーのプレビュー帯 + 別の PWA 名）。

## コミット前の確認

```bash
cd api && cargo test && cargo clippy --all-targets      # ユニットテスト（認証フロー、プッシュ SSRF 対策、CORS など）
cd app && npm run build && npm run build:web            # どちらも先に npm run check:i18n を実行
```

- `npm run check:i18n`：3 言語のキーとプレースホルダが一致し、ソースにハードコードされた中国語が残っていないこと。新しい文言は 3 言語すべてに追加（中国語がソース）。
- PR は `.github/workflows/ci.yml` で検査：`cargo test`、依存ライセンス（`cargo deny check licenses`、規則は `api/deny.toml`）、フロントエンドの 2 種類のビルド、各コミットの `Signed-off-by`（`git commit -s`、DCO）。
- 新しいソースファイルの先頭行に `SPDX-License-Identifier: AGPL-3.0-or-later` コメントを付けます。

## API

`/health` と `POST /api/auth/pair` 以外は `Authorization: Bearer <token>` が必要です：サーバー Token（オーナーキー、`API_TOKEN`）またはデバイストークン（`dlt_…`、0.14.0 以降）。`GET /health` は `{"status","version","api_level"}` を返します（現在の `api_level` は 16）。`GET /api/health` はさらにデータベースと各機能の可否を確認します。

| エンドポイント | 説明 |
|---|---|
| `GET /api/cars` | 車両一覧 |
| `GET /api/cars/:id/status`（api_level ≥ 16 は `tpms` を含む） · `/last-activity` · `/stats?tz=` · `/summary?tz=` | ホームのデータ（状態、直近の走行 / 充電、当月と累計の統計） |
| `GET /api/drives` · `/api/charges`（`car_id`、`paged=true&before=<カーソル>&limit=`；`/drives` と `/journeys` は任意の `q` で場所 / 名前検索、api_level ≥ 16） | 走行 / 充電リスト（keyset ページング、`{items, next_cursor}`；旧来の `limit/offset` も可） |
| `GET /api/drives/:id`、`/api/drives/:id/path`、`/api/charges/:id` | 詳細、GPS 軌跡、充電カーブ |
| `GET /api/cars/:id/months?tz=` | 月次集計（リストの月見出し / ジャンプ） |
| `GET /api/cars/:id/report?month=YYYY-MM&tz=&currency=`、`/trends` | 月次レポート |
| `GET /api/cars/:id/footprint?month=&tz=`、`/battery?summary=&tz=&new_kwh=` | フットプリント、バッテリー劣化（`tm` は TeslaMate の「Battery Health」と同じ） |
| `PUT/DELETE /api/charges/:id/cost` | 手入力の充電料金 |
| `GET/PUT/DELETE /api/addresses/...` | 場所のカスタム名 |
| `/api/journeys…` | 旅（複数走行の結合）、提案、非表示、カバー、天気、速度帯 |
| `/api/push/…` | Web プッシュ：`key`、`subscription`、`subscription/status`、`unsubscribe`、`test` |
| `GET /api/auth/me` | 現在の身元：`{kind:"owner"\|"device", device, device_auth, owner_key_mode}` |
| `POST /api/auth/devices` | サーバー Token をデバイストークンに交換（サーバー Token のみ）：`{name}` → 201 `{token, device}` |
| `GET /api/auth/devices`、`PATCH/DELETE /api/auth/devices/:id`、`DELETE /api/auth/devices?except=current` | 端末一覧、改名、解除、他の全端末を解除（サーバー Token または full 端末） |
| `PATCH/DELETE /api/auth/devices/current` | この端末の名前変更、この端末のサインアウト（どの端末でも可） |
| `POST /api/auth/pairings` | ペアリングコード発行：`{scope:"full"\|"read", device_ttl_days?}` → 201 `{code:"XXXX-XXXX", expires_at}`（10 分・使い捨て） |
| `POST /api/auth/pair` | **認証不要**：`{code, name}` → 201 `{token, device}`；不正なコードは 400 `{code:"invalid_code"}`、失敗が多いと 429 |

- デバイス認証（`api/src/auth.rs`）：データベースには Token / ペアリングコードの SHA-256 だけを保存。`read` 端末は GET/HEAD のみ（加えて `/api/push/*` と `PATCH/DELETE /api/auth/devices/current`。それ以外は 403 `{code:"read_only"}`）。`DRIVELENS_OWNER_KEY_MODE=pair-only` のとき、サーバー Token は `/api/auth/*` だけ（それ以外は 403 `{code:"owner_key_pair_only"}`）。テーブルを作れない（CREATE 権限なし）場合は `device_auth:false`：サーバー Token はそのまま使え、他の `/api/auth/*` は 503 `{code:"device_auth_unavailable"}`。データベースを使うテスト：`DRIVELENS_TEST_DATABASE_URL=postgres://… cargo test`（未設定ならスキップ）。
- App は `api_level` で表示する機能を決めます（`app/src/version.ts` の `FEATURE_LEVEL`）。サーバー対応が必要な機能を追加するときは、API の `API_LEVEL` を 1 上げ、フロントに対応する `FEATURE_LEVEL` を追加し、古いサーバーではその機能を隠して更新を促します。
- 環境変数はインストールガイドの「環境変数」節を参照（`DATABASE_URL`、`API_TOKEN`、`BIND_ADDR`、`DRIVELENS_CORS_ORIGINS`、`DRIVELENS_TRUST_PROXY_HEADERS`、`DRIVELENS_PUSH_HOSTS`、`DRIVELENS_VAPID_*`、`RUST_LOG`）。

## データベースの原則

- **TeslaMate のテーブルは決して変更しない。** TeslaMate へは SELECT のみ。DriveLens 独自のデータ（場所の別名、手入力料金、旅、天気キャッシュ、プッシュ購読など）は `drivelens` スキーマにだけ置きます。
- `deploy/setup.sql` は読み取り専用ロール `drivelens_ro` と `drivelens` スキーマを作ります（再実行可）。API 起動時に `drivelens` 内のテーブルを自動作成 / アップグレードします（`main.rs` の `migrate()`、`journey::try_create_tables`、`phase2::try_migrate`、`push::try_migrate`、`auth::try_migrate`）。権限不足やテーブル欠如のときはその機能だけを止め、起動ログに `disabled features: …` を出します。
- `deploy/drivelens-init.sql` と `drivelens-v*.sql` は、初期に手作業でテーブルを作っていたインストール向けのアップグレードスクリプトです。新規インストールでは不要です。
- 消費電力量は TeslaMate Grafana の式に従います：`(開始定格航続 − 終了定格航続) × cars.efficiency`。

## フロントエンドの要点

- 文言：`app/src/locales/{zh,en,ja}.ts`；書式（日付、時間、月）：`app/src/i18n.ts`。
- ウェブ版の Token はブラウザの localStorage（`drivelens-settings`）にだけ保存されます。App 1.2.0 以降はデバイストークンを保存します（`tokenKind:"device"`、`app/src/auth.ts`）：初期設定の 2 つ目の欄はペアリングコードまたはサーバー Token。サーバー Token はデバイストークンに交換したあと破棄され、旧設定は起動時に自動移行。デバイストークンが 401 を受けると `drivelens-signed-out` が発火し、接続・サーバーキャッシュ（`isServerCacheKey()`）・通知購読を消して初期設定に戻ります。設定 → 端末は `app/src/devices.ts`；読み取り専用端末は `canWrite()` ですべての書き込み入口を隠します。`src/urlguard.ts` が最初に動き、アドレス欄の `api` / `token` / `key` を取り除きます。App は URL からサーバーアドレスや Token を読みません。
- `innerHTML` に差し込むデータは必ずエスケープ（各モジュールの `esc()`）するか `textContent` を使います。`?view=` などのディープリンク引数は先に形式を検証します。
- CSP：ウェブ版は `app/web-public/_headers`、Tauri は `app/src-tauri/tauri.conf.json`。外部スクリプトやフォントを入れないでください。
- ポップオーバーメニューは `ui.ts` の `popMenu()` / `placePopover()` に統一。シート（`.modal`）は `sheets.ts` が可視ビューポートに合わせます（iOS キーボード）。
- Service Worker（`vite.config.ts` が生成）は App シェルだけをキャッシュし、API 応答は決してキャッシュしません。

## ネイティブ App（一時停止）

Windows / Android のパッケージングは v0.15.0 から一時停止しています。`.github/workflows/windows.yml` と `android.yml` は手動実行のみ、`scripts/release.conf` は `NATIVE_BUILDS=0` です。Android プロジェクトは `app/src-tauri/gen/android`（独自部分は `MainActivity.kt`、`network_security_config.xml`、`build.gradle.kts`）。署名設定は `DRIVELENS_KEYSTORE_PROPERTIES`、または gitignore 済みの `gen/android/keystore.properties` で渡します。ローカルビルド：`npm run tauri dev` / `npx tauri android dev`（JDK 17+、Android SDK、NDK 27 が必要）。

## リリース（メンテナ）

- **`main` は保護されており、すべての変更（メンテナ作業とリリースも含む）は PR 経由**：PR が必須（承認 0 件で可）、CI の `api` / `app` / `dco` が通り、ブランチが `main` と同期していること。force push と削除は禁止し、履歴は線形のまま。マージ方法は **Rebase and merge** のみ（各コミットとその `Signed-off-by` を保持）。マージ後にブランチは自動削除。
- 日常の変更：`git commit -s` のあと `scripts/pr.sh <ブランチ名>`（機能ブランチ上なら省略可）。スクリプトがブランチを push し、PR を開き、チェック通過を待ち、rebase マージし、ローカルの `main` をマージ後の `origin/main` に移します。`--dry-run` は予定だけを表示。手動なら：`git push origin HEAD:fix/x && gh pr create --base main --head fix/x --fill && gh pr merge fix/x --rebase --auto`。
- `scripts/release.sh`：HEAD を `release/vX.Y.Z` に push → PR「release: vX.Y.Z」（本文は CHANGELOG）→ チェック通過後に rebase マージ → `main` 上のマージコミットが Docker イメージをビルドするのを待つ（`ghcr.io/zzflsxygod/drivelens-api`、amd64 + arm64、`.github/workflows/docker.yml`）→ `api/` に変更があればサーバーの `/health` が新バージョンを返すまで待つ → `main` 上のマージコミットに tag を打ち、`web.yml` がウェブ版をビルドしてデプロイ → Release を公開。素の `X.Y.Z` は通常の Latest、接尾辞付きはプレリリース。失敗後の再実行はその続きから（開いている PR を再利用、済みならスキップ、既存 tag はそのまま）。`--dry-run` は確認と第 1 ステップの表示のみ。tag はブランチ保護の対象外（リポジトリに tag 規則なし）。
- リリースノートはルートの `CHANGELOG.md` の該当版の節から取ります。バージョン番号は `api/Cargo.toml`（サーバー変更時）、`app/package.json`、`app/src-tauri/tauri.conf.json`、`app/src-tauri/Cargo.toml` をそろえて更新します。
- ウェブ版のデプロイにはリポジトリ secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` が必要です（fork に無い場合はデプロイをスキップし、成果物だけをアップロード）。

### プレビュー環境（マージ / 公開前の確認）

- 同じ Cloudflare Pages プロジェクト `drivelens-app`。手作業で `gh workflow run web.yml --ref <ブランチ> -f target=preview` を実行すると Pages の `preview` ブランチにデプロイされ、固定エイリアスは `https://preview.drivelens-app.pages.dev` です。
- プレビュービルドは `VITE_DRIVELENS_CHANNEL=preview` を付けます（ヘッダーの「プレビュー」帯 + 別の PWA 名）。本番（release tag または `-f target=production`）の見た目は変わらず、Pages の `main` にデプロイされます。
- サーバー `.env` の `DRIVELENS_CORS_ORIGINS` には公式 origin とプレビュー origin の両方を含めます。例：
  `DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com,https://preview.drivelens-app.pages.dev`
  （プレビュー origin を API の既定 CORS ホワイトリストに入れないこと。）変更後は `drivelens-api` を再起動します。
- Cloudflare Pages プロジェクト設定で **preview deployments** に Access を付けられます（自分のメールのみ）。API リクエストは自分のサーバーへ直接行き、影響を受けません。

## ライセンス

- DriveLens：GNU AGPL-3.0-or-later（[LICENSE](../LICENSE)）。ウェブ版の設定 →「ヘルプとフィードバック」にソースコードへのリンクがあります（AGPL 第 13 条）。
- バッテリー劣化の SQL は TeslaMate（AGPL-3.0-or-later）から移植。`api/src/insights.rs` の説明と [third_party/teslamate/NOTICE](../third_party/teslamate/NOTICE) を参照。
- 依存ライセンス：`scripts/third-party-licenses.sh` が `api/THIRD_PARTY_LICENSES.txt` を再生成し（Docker イメージの `/usr/share/doc/drivelens/` に同梱）、互換性を検査。フロントエンドの一覧はビルド時に生成（`/third-party-licenses.txt`）。
- デモルート `app/src/demo/routes.json`：© OpenStreetMap contributors（ODbL）。標高は Copernicus DEM（Open-Meteo 経由、CC BY 4.0）。
