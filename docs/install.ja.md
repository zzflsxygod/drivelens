# DriveLens インストールガイド

[English](install.md) · [中文](install.zh.md) · **日本語**

DriveLens は 2 つの部分でできています。

- **drivelens-api**：サーバー上で TeslaMate と一緒に動く小さな Docker コンテナです。読み取り専用のアカウントで TeslaMate のデータベースを読みます。
- **DriveLens ウェブ版**：**https://drivelens-app.oharuru.com** 。ここでサーバーのアドレスとトークンを一度入力します。

> DriveLens は **TeslaMate のテーブルを変更しません**。データベースアカウントにはこれらのテーブルの読み取り権限しかありません。DriveLens 独自のデータ（場所の名前、手入力した充電料金、旅、カバー写真、プッシュの登録、天気のキャッシュ）は別の `drivelens` スキーマに保存します。

目次：[前提条件](#前提条件) · [1. ファイル](#1-ファイルを-2-つダウンロード) · [2. パスワードとトークン](#2-パスワードとトークンを作る) · [3. データベースアカウント](#3-データベースアカウントを作る初回のみ) · [4. 起動](#4-drivelens-api-を起動) · [5. https](#5-サーバーに-https-のアドレスを用意する) · [6. 接続](#6-ウェブ版から接続する) · [7. 通知](#7-通知) · [8. 更新](#8-更新) · [環境変数](#環境変数) · [トラブルシューティング](#トラブルシューティング) · [アンインストール](#アンインストール)

## 前提条件

- TeslaMate が Docker Compose で動いていること（公式の `docker-compose.yml`：データベースのサービス名は `database`、データベース名と管理ユーザーは `teslamate`）。
- x86_64 または ARM64 のサーバー（Raspberry Pi でも動きます）。イメージ `ghcr.io/zzflsxygod/drivelens-api` は linux/amd64 と linux/arm64 向けに公開しています。
- **https** でサーバーに接続する手段：Cloudflare Tunnel（Cloudflare で管理しているドメインが必要）または Tailscale（ドメイン不要）。手順 5 を参照してください。

## 1. ファイルを 2 つダウンロード

TeslaMate の compose ディレクトリで実行します。

```bash
cd teslamate   # TeslaMate の docker-compose.yml があるディレクトリ
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens/main/deploy/docker-compose.drivelens.yml
```

```
teslamate/
├── docker-compose.yml               # TeslaMate のファイル（変更不要）
├── docker-compose.drivelens.yml     # drivelens-api のサービス
├── setup.sql                        # 初回だけのデータベース設定
└── .env
```

## 2. パスワードとトークンを作る

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS`：読み取り専用のデータベースアカウント `drivelens_ro` のパスワード。
- `DRIVELENS_API_TOKEN`：アプリに入力するトークン。16 文字未満だと API は起動せず、32 文字未満や単純なものはログに警告が出ます。上のコマンドのようにランダムに生成してください。

## 3. データベースアカウントを作る（初回のみ）

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
```

[`setup.sql`](../deploy/setup.sql) は何度実行しても安全です（2 回目以降はパスワードを更新するだけです）。内容は次のとおりです。

1. ログインロール `drivelens_ro` を作成します。
2. TeslaMate のテーブルに **SELECT** 権限を付与します。今後の TeslaMate のアップデートで追加されるテーブルも含みます。
3. `cars`、`addresses`、`drives`、`charging_processes` に REFERENCES 権限を付与します。DriveLens のテーブルが外部キーでこれらを参照でき、TeslaMate が走行を削除すると DriveLens の関連データも一緒に消えます（書き込み権限ではありません）。
4. `drivelens_ro` が所有する `drivelens` スキーマを作成します。

TeslaMate のテーブルに何かを作成・変更・削除することはありません。API は起動するたびに `drivelens` スキーマの中に自分のテーブルを作成・更新するので、これ以上 SQL を実行する必要はありません。

> データベース名や管理ユーザーが `teslamate` でない場合は、上の `-U` / `-d` を変更し、`.env` に `DRIVELENS_DB_NAME=データベース名` を追加してください。

## 4. drivelens-api を起動

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

ログに次のように表示されれば成功です。

```
INFO drivelens_api: all features enabled (API level 14)
INFO drivelens_api: listening on 0.0.0.0:8080
```

`disabled features: …` や `cannot read TeslaMate tables` と表示された場合は手順 3 が完了していません。`setup.sql` をもう一度実行し、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api` を実行してください。

サーバー上での確認：`curl http://127.0.0.1:8080/health` が `{"status":"ok","version":"…","api_level":14}` を返します。

compose ファイルの初期設定では API を `127.0.0.1:8080` にだけ公開するので、ほかのマシンからは接続できません。**8080 番ポートをインターネットに直接公開しないでください**。下の https の方法のどちらかを使います。

## 5. サーバーに https のアドレスを用意する

ウェブ版は https で配信しているため、ブラウザは `http://` のサーバーアドレスをブロックします（混在コンテンツ）。`http://192.168.x.x:8080` や `http://100.x.y.z:8080` のような **LAN や Tailscale の IP も同じです**。どちらかを選んでください。

<a id="cloudflare-tunnel"></a>
### 方法 A：Cloudflare Tunnel（Cloudflare で管理しているドメインがある場合）

1. Cloudflare Zero Trust → Networks → Tunnels でトンネルを作成し、トークンをコピーします。
2. cloudflared を同じ compose プロジェクトで動かす場合は、`docker-compose.drivelens.yml` の `cloudflared` サービスのコメントを外し、`.env` に `CLOUDFLARE_TUNNEL_TOKEN=…` を追加して、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d cloudflared` で起動します。その後 `drivelens-api` の `ports:` は削除して構いません。
   ホストにインストール済みの cloudflared を使うこともできます。
3. Public Hostname（例：`drivelens.あなたのドメイン`）を追加し、サービスに `http://drivelens-api:8080`（compose 内の cloudflared）または `http://127.0.0.1:8080`（ホストの cloudflared）を指定します。
4. サーバーのアドレスは `https://drivelens.あなたのドメイン` です。

API の前に Cloudflare Access などのログインページを置かないでください。ウェブ版からのリクエストがブロックされます。API はトークンで保護されています。

<a id="tailscale"></a>
### 方法 B：Tailscale（ドメイン不要、自分の端末からだけ接続）

`tailscale serve` を使うと、tailnet 内の端末からだけ接続できる https のアドレスをサーバーに用意できます。

1. サーバー（ホストに通常の方法でインストール）とスマートフォン / PC に Tailscale をインストールし、同じ tailnet にログインします。
2. Tailscale の管理画面 → [DNS](https://login.tailscale.com/admin/dns) で **MagicDNS** と **HTTPS Certificates** を有効にします（tailnet ごとに 1 回だけ）。
3. サーバーで次を実行します。
   ```bash
   sudo tailscale serve --bg 8080
   ```
   `https://<マシン名>.<tailnet>.ts.net` を `http://127.0.0.1:8080` へ転送し、再起動後も有効なままです。アドレスは `tailscale serve status` で確認できます。compose ファイルは初期設定の `127.0.0.1:8080:8080` のままで構いません。最初の接続では証明書の発行に数秒かかることがあります。
4. サーバーのアドレスは `https://<マシン名>.<tailnet>.ts.net`（ポートなし）です。DriveLens を使う端末は Tailscale に接続している必要があります。

補足：

- CORS の設定は不要です。API は初期設定で公式ウェブ版を許可しています。サーバー自身のアドレスを `DRIVELENS_CORS_ORIGINS` に入れる必要はありません。
- Chrome / Edge では、サイトに*ローカルネットワーク上のデバイスへのアクセス*を許可するか聞かれることがあります（ts.net の名前は 100.x のアドレスを指すため）。**許可**を選んでください。ブロックしてしまった場合は、サイトの設定（アドレスバー左のアイコン）から許可し直せます。
- 証明書によってマシン名（`<マシン名>.<tailnet>.ts.net`）が公開の Certificate Transparency ログに記録されます。気になる場合は先にマシン名を変更してください。
- 停止するには：`sudo tailscale serve --https=443 off`。

## 6. ウェブ版から接続する

1. **https://drivelens-app.oharuru.com** を開きます（ようこそ画面からデモを先に試すこともできます）。
2. 手順 5 の**サーバーの URL** と **API トークン**（`.env` の `DRIVELENS_API_TOKEN`）を入力します。
3. 「接続をテストして始める」を押します。アプリは `/health` を確認してから、トークンでクルマの情報を読み込みます。

| メッセージ | 対処 |
| --- | --- |
| トークンが違う（401） | `DRIVELENS_API_TOKEN` をスペースや引用符なしでコピーし直す |
| ブラウザが http のサーバーアドレスをブロック | https のアドレスを使う（手順 5） |
| 接続できない / タイムアウト | アドレス、トンネルや Tailscale が動いているか、証明書が有効かを確認 |
| DriveLens の API ではない | TeslaMate や Grafana のアドレスを入力しています。drivelens-api のアドレスを入力する |
| サーバーがこのサイトを許可していない（CORS） | drivelens-api を更新する。`DRIVELENS_CORS_ORIGINS` を設定している場合は `https://drivelens-app.oharuru.com` を含める |
| サーバーが古い | drivelens-api を更新する（手順 8） |
| トークンの誤りが多すぎる（429） | 10 分以内に 10 回失敗すると、その接続元はしばらく拒否されます。10 分待ってから再試行 |

サーバーとトークンはあとから「設定 → サーバー」で変更できます。言語、テーマ、地図ラベルの言語、既定の通貨も設定にあります。

**ホーム画面に追加：** Android や PC の Chrome / Edge では、設定の「アプリとしてインストール」またはブラウザのメニュー → インストール。iPhone / iPad（Safari）では、共有 → ホーム画面に追加。

サーバーのアドレスとトークンはこのブラウザのローカルストレージにだけ保存され、ご自身のサーバーにしか送信されません。共用の PC では、ブラウザでこのサイトのデータを削除すると消去できます。オフライン用キャッシュに入るのはアプリ本体だけで、API の応答はキャッシュしません。

## 7. 通知

「設定 → 通知」で、使っている端末のプッシュ通知をオンにできます。走行が終わると**走行サマリー**（距離、時間、電力量、出発地 → 到着地）、毎月 1 日には**月次レポート**のお知らせ（端末のタイムゾーンで 9:00 以降）が届きます。それぞれ個別にオフにでき、通知をタップするとその走行やレポートが開きます。

- サーバーが 1 分ごとに TeslaMate の終了した走行を確認し、ブラウザのプッシュサービス（Google、Apple、Mozilla）経由で、エンドツーエンドで暗号化した通知を自分で送信します。コンテナからこれらのサービスへ https で接続できる必要があります。
- 設定は不要です。署名鍵（VAPID）は初回起動時に自動で生成され、`drivelens` スキーマに保存されます。失われた場合（データベースを作り直したときなど）は、各端末で通知をオンにし直してください。
- iPhone / iPad：iOS 16.4 以降で、DriveLens をホーム画面に追加し、そこから開く必要があります。
- Android / PC：Chrome、Edge、Firefox。通知をブロックした場合はサイトの設定で許可してください。

## 8. 更新

**自動更新（おすすめ）：** `docker-compose.drivelens.yml` の最後にある `watchtower` サービスのコメントを外し、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d watchtower` で起動します。6 時間ごとに確認し、`com.centurylinklabs.watchtower.enable=true` のラベルが付いたコンテナ、つまり drivelens-api だけを更新します。TeslaMate、データベース、Grafana には触れません。

**手動更新：**

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml pull drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

API は起動時に自分のテーブルを自動で更新します。特定のバージョンに固定するには、`.env` に `DRIVELENS_IMAGE=ghcr.io/zzflsxygod/drivelens-api:v1.1.1` のように設定します。変更点は [Releases](https://github.com/zzflsxygod/drivelens/releases) をご覧ください。ウェブ版は常に最新版で、サーバーの更新が必要なときはお知らせします。

## 環境変数

drivelens-api が読み取る変数：

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:…@database:5432/teslamate`。compose ファイルが `.env` から組み立てます |
| `API_TOKEN` | ✅ | アプリ用のトークン（16 文字以上、32 文字以上のランダムな文字列を推奨）。compose ファイルは `DRIVELENS_API_TOKEN` から取ります |
| `BIND_ADDR` | | 待ち受けアドレス。イメージ内では `0.0.0.0:8080` |
| `DRIVELENS_CORS_ORIGINS` | | ブラウザから API を呼び出せるウェブのオリジン（カンマ区切り）。`*` はすべて許可。初期設定は公式ウェブ版のみ（と、一時停止中のネイティブアプリのオリジン）。旧名の `CORS_ORIGINS` も使えます |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | プッシュの署名鍵（base64url P-256）。通常は設定不要で、初回起動時に生成してデータベースに保存します |
| `DRIVELENS_VAPID_SUBJECT` | | プッシュサービスに送る連絡先（`mailto:you@example.com` または https の URL）。初期値は DriveLens のプロジェクトページ |
| `RUST_LOG` | | ログレベル。初期値は `info` |

`.env`（`docker-compose.drivelens.yml` が使用）：`DRIVELENS_DB_PASS`、`DRIVELENS_API_TOKEN`、任意で `DRIVELENS_DB_NAME`（初期値 `teslamate`）、`DRIVELENS_IMAGE`（初期値 `ghcr.io/zzflsxygod/drivelens-api:latest`）、`CLOUDFLARE_TUNNEL_TOKEN`（cloudflared サービス用）。

## トラブルシューティング

- **`password authentication failed for user "drivelens_ro"`**：`DRIVELENS_DB_PASS` が `setup.sql` 実行時のパスワードと違います。手順 3 をもう一度実行し（パスワードが更新されます）、drivelens-api を再起動してください。
- **`API_TOKEN must be at least 16 characters`**（コンテナが再起動を繰り返す）または **`API_TOKEN looks weak`**：`openssl rand -hex 24` で新しいトークンを作って `.env` に書き、`up -d drivelens-api` をもう一度実行して、アプリにも新しいトークンを入力してください。
- **`cannot read TeslaMate tables`** または **`disabled features: …`**：データベースアカウントの設定が不完全です。`setup.sql`（手順 3）をもう一度実行し、drivelens-api を再起動してください。`disabled features` だけの場合、走行・充電・レポートはその間も使えます。
- **設定画面でサーバーに接続できない**：まずサーバー上で `curl http://127.0.0.1:8080/health` が動くことを確認し、次にトンネル（`docker compose … logs cloudflared`）や `tailscale serve status` を確認してください。
- **`/health` は動くがデータを読み込めない**：間にリバースプロキシがある場合は、`Authorization` ヘッダーをそのまま転送する必要があります。
- **通知が届かない**：その端末の「設定 → 通知」、ブラウザの通知の許可、コンテナが https でインターネットに接続できるかを確認してください。

## アンインストール

1. コンテナを停止して削除します。
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.drivelens.yml rm -sf drivelens-api
   ```
   （DriveLens のために `cloudflared` / `watchtower` を有効にした場合はそれらも）その後、`docker-compose.drivelens.yml`、`setup.sql`、`.env` の `DRIVELENS_*` の行を削除します。
2. 必要なら DriveLens のデータとアカウントを削除します（TeslaMate のデータには影響しません）。
   ```bash
   docker compose exec -T database psql -U teslamate -d teslamate \
     -c "DROP SCHEMA drivelens CASCADE" -c "DROP OWNED BY drivelens_ro" -c "DROP ROLE drivelens_ro"
   ```
3. Tailscale を使っていた場合：`sudo tailscale serve --https=443 off`。

## フィードバック

不具合や機能の要望は [Issues](https://github.com/zzflsxygod/drivelens/issues) へお寄せください。サーバーのアドレスやトークンは絶対に投稿しないでください。
