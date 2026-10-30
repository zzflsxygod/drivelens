# DriveLens インストールガイド

[English](install.md) · [中文](install.zh.md) · **日本語**

DriveLens は 2 つの部分でできています。

- **drivelens-api**：サーバー上で TeslaMate と一緒に動く小さな Docker コンテナです。読み取り専用のアカウントで TeslaMate のデータベースを読みます。
- **DriveLens ウェブ版**：**[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)** 。サーバーのアドレスと、サーバーのトークン（または接続済みの端末で発行したペアリングコード）で一度接続します。

> DriveLens は **TeslaMate のテーブルを変更しません**。データベースアカウントにはこれらのテーブルの読み取り権限しかありません。DriveLens 独自のデータ（場所の名前、手入力した充電料金、旅、カバー写真、プッシュの登録、天気のキャッシュ、接続済みの端末）は別の `drivelens` スキーマに保存します。

目次：[前提条件](#前提条件) · [1. ファイル](#1-ファイルを-2-つダウンロード) · [2. パスワードとトークン](#2-パスワードとトークンを作る) · [3. データベースアカウント](#3-データベースアカウントを作る初回のみ) · [4. 起動](#4-drivelens-api-を起動) · [5. https](#5-サーバーに-https-のアドレスを用意する) · [6. 接続](#6-ウェブ版から接続する) · [端末](#devices) · [7. 通知](#7-通知) · [8. 更新](#8-更新) · [環境変数](#環境変数) · [トラブルシューティング](#トラブルシューティング) · [アンインストール](#アンインストール) · [付録：LAN 内だけで使う](#lan-selfhost) · [認証プロキシ（非公式）](#auth-proxy)

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
4. `drivelens` スキーマを作成し、`drivelens_ro` にその `USAGE` と `CREATE` 権限を付与します（スキーマが既にある場合も）。
5. 古い SQL ファイルで管理者が作成した DriveLens のテーブルの所有者を `drivelens_ro` に変更します（`drivelens` スキーマ内のテーブルのみ）。

TeslaMate のテーブルに何かを作成・変更・削除することはありません。API は起動するたびに `drivelens` スキーマの中に自分のテーブルを作成・更新するので、これ以上 SQL を実行する必要はありません。

> データベース名や管理ユーザーが `teslamate` でない場合は、上の `-U` / `-d` を変更し、`.env` に `DRIVELENS_DB_NAME=データベース名` を追加してください。

## 4. drivelens-api を起動

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

ログに次のように表示されれば成功です。

```
INFO drivelens_api: all features enabled (API level 16)
INFO drivelens_api: listening on 0.0.0.0:8080
```

`disabled features: …` や `cannot read TeslaMate tables` と表示された場合は手順 3 が完了していません。`setup.sql` をもう一度実行し、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api` を実行してください。

サーバー上での確認：`curl http://127.0.0.1:8080/health` が `{"status":"ok","version":"…","api_level":16}` を返します。

compose ファイルの初期設定では API を `127.0.0.1:8080` にだけ公開するので、ほかのマシンからは接続できません。**8080 番ポートをインターネットに直接公開しないでください**。下の https の方法のどちらかを使います。

## 5. サーバーに https のアドレスを用意する

ウェブ版は https で配信しているため、ブラウザは `http://` のサーバーアドレスをブロックします（混在コンテンツ）。`http://192.168.x.x:8080` や `http://100.x.y.z:8080` のような **LAN や Tailscale の IP も同じです**。どちらかを選んでください。

> LAN 内だけで http で使いたい場合（ウェブ版を自分でホストする非公式の方法）は、[付録：LAN 内だけで使う](#lan-selfhost)を参照してください。

<a id="cloudflare-tunnel"></a>
### 方法 A：Cloudflare Tunnel（Cloudflare で管理しているドメインがある場合）

1. Cloudflare Zero Trust → Networks → Tunnels でトンネルを作成し、トークンをコピーします。
2. cloudflared を同じ compose プロジェクトで動かす場合は、`docker-compose.drivelens.yml` の `cloudflared` サービスのコメントを外し、`.env` に `CLOUDFLARE_TUNNEL_TOKEN=…` を追加して、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d cloudflared` で起動します。その後 `drivelens-api` の `ports:` は削除して構いません。
   ホストにインストール済みの cloudflared を使うこともできます。
3. Public Hostname（例：`drivelens.あなたのドメイン`）を追加し、サービスに `http://drivelens-api:8080`（compose 内の cloudflared）または `http://127.0.0.1:8080`（ホストの cloudflared）を指定します。
4. サーバーのアドレスは `https://drivelens.あなたのドメイン` です。

**公式ウェブ版**（[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)）を使う場合は、API の前に Cloudflare Access などのログインページを置かないでください。公式ウェブ版は別オリジンのため、ブラウザは Access の Cookie を API リクエストに付けず、ブロックされます。API はトークンで保護されています。**同一オリジンのセルフホスト**（ウェブ版と API を同じホストに置く）は別です — [認証プロキシの後ろ](#auth-proxy)（非公式・未検証）を参照してください。

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

1. **[https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com)** を開きます（ようこそ画面からデモを先に試すこともできます）。
2. 手順 5 の**サーバーの URL** を入力し、2 つ目の欄に次のどちらかを入力します。
   - **サーバーのトークン**（`.env` の `DRIVELENS_API_TOKEN`）
   - 接続済みの端末で発行した**ペアリングコード**（例：`7KQ2-M9XD`。設定 → 端末 → 端末を追加。[端末の管理](#devices)を参照）
3. 「接続をテストして始める」を押します。アプリは `/health` を確認してから、クルマの情報を読み込みます。

drivelens-api 0.14.0 以上では、アプリはサーバーのトークンをこの端末専用のトークン（端末トークン）に交換し、サーバーのトークンは保存しません。以前サーバーのトークンを保存したアプリ（1.2.0 以上）も、次回の起動時に自動で端末トークンに切り替わります。

| メッセージ | 対処 |
| --- | --- |
| トークンが違う（401） | `DRIVELENS_API_TOKEN` をスペースや引用符なしでコピーし直す |
| ブラウザが http のサーバーアドレスをブロック | https のアドレスを使う（手順 5） |
| 接続できない / タイムアウト | アドレス、トンネルや Tailscale が動いているか、証明書が有効かを確認 |
| DriveLens の API ではない | TeslaMate や Grafana のアドレスを入力しています。drivelens-api のアドレスを入力する |
| サーバーがこのサイトを許可していない（CORS） | drivelens-api を更新する。`DRIVELENS_CORS_ORIGINS` を設定している場合は `https://drivelens-app.oharuru.com` を含め、compose の `environment:` 経由で渡し、コンテナを作り直す |
| サーバーが古い | drivelens-api を更新する（手順 8） |
| ペアリングコードが違う / 無効 | コードは 10 分以内に 1 回だけ使えます。接続済みの端末で新しいコードを発行する |
| サーバーを v0.14.0 以上に更新してください（ペアリングコード） | サーバーが 0.14.0 より古い：drivelens-api を更新する（手順 8）か、サーバーのトークンで接続する |
| トークンの誤りが多すぎる（429） | 10 分以内に 10 回失敗すると、しばらく 429 になります。10 分待ってから再試行。接続済みの端末はそのまま使えます |

サーバーはあとから「設定 → サーバー」で変更できます（コード / トークンの欄を空のままにすると今の接続を保ちます）。言語、テーマ、地図ラベルの言語、既定の通貨も設定にあります。

**ホーム画面に追加：** Android や PC の Chrome / Edge では、設定の「アプリとしてインストール」またはブラウザのメニュー → インストール。iPhone / iPad（Safari）では、共有 → ホーム画面に追加。

サーバーのアドレスとこの端末のトークンはこのブラウザのローカルストレージにだけ保存され、ご自身のサーバーにしか送信されません（常にリクエストヘッダーで送り、URL には載せません）。**設定 → この端末からサインアウト** で、キャッシュしたデータや通知の登録と一緒に消去できます（端末トークンの場合はサーバー側でも接続を解除します）。オフライン用キャッシュに入るのはアプリ本体だけで、API の応答はキャッシュしません。

### 端末の管理 <a id="devices"></a>

drivelens-api 0.14.0 以上とアプリ 1.2.0 以上では、スマホ・タブレット・ブラウザごとに専用の端末トークンを持ちます。**設定 → 端末** に、最終使用日時とアドレス付きで一覧が出ます。各行の ⋯ から名前の変更や接続の解除ができます。

- **サーバーのトークンなしで端末を追加：** **端末を追加** を押し、**フルアクセス** か **読み取り専用** を選びます（読み取り専用は 7 日・30 日で失効、または無期限）。**ペアリングコードを発行** を押し、新しい端末でサーバーのアドレスとコードを入力します。コードは 10 分間有効で、1 回だけ使えます。
- **読み取り専用** の端末はすべてのデータを見られますが、地点名・充電費用・旅程の編集や端末の管理はできません。家族や車載画面向けです。
- **スマホをなくしたら：** ほかの端末から接続を解除します。その端末は次のリクエストでサインアウトされ、キャッシュも消えます。
- **ほかの端末をすべて解除** は、今使っている端末以外をすべてサインアウトします。
- **サーバーのトークンを変える**（漏れた可能性があるとき）：`.env` に新しい `DRIVELENS_API_TOKEN` を書き、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api` を実行します。端末トークンの端末は接続されたままです。サーバーのトークンを使い続けている 1.2.0 より前のアプリだけ、新しいトークンの入力が必要です。
- さらに守りを固めるには：`.env` に `DRIVELENS_OWNER_KEY_MODE=pair-only` を書き、`docker-compose.drivelens.yml` の `environment:` 下の対応行のコメントを外してコンテナを作り直します（[環境変数](#環境変数)を参照）。これでサーバーのトークンは端末の追加と管理にしか使えなくなります。

端末の一覧には、`drivelens` スキーマの `CREATE` 権限と、DriveLens のテーブルを `drivelens_ro` が所有していることが必要です（`deploy/setup.sql` が設定します）。満たしていない場合、API はログに `device auth disabled` と出し、ほかの機能はこれまでどおりサーバーのトークンで動きます。1 回だけの修正方法は [0.14.0 へのアップデート](#0140-へのアップデート) をご覧ください。

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

### 0.14.0 へのアップデート

古い SQL ファイル（または 0.14.0 より前の `setup.sql`）で設定したサーバーでは、`drivelens` スキーマとテーブルが TeslaMate の管理者のものになっていて、`drivelens_ro` にスキーマの `CREATE` 権限がないことがあります。この場合、端末認証はオフのままです（ログに `device auth disabled`）。ほかの機能はサーバーのトークンでこれまでどおり動きます。1 回だけ修正してください。最新の `setup.sql` をダウンロードして手順 3 をもう一度実行するか、次の 2 つの文だけを実行し、再起動してログを確認します。

```bash
docker compose exec -T database psql -U teslamate -d teslamate <<'SQL'
GRANT USAGE, CREATE ON SCHEMA drivelens TO drivelens_ro;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'drivelens' AND tableowner <> 'drivelens_ro' LOOP
    EXECUTE format('ALTER TABLE drivelens.%I OWNER TO drivelens_ro', t);
  END LOOP;
END $$;
SQL
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api | grep 'device auth'
```

ログに `device auth enabled: N device(s)` と出れば完了です。

## 環境変数

drivelens-api が読み取る変数：

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:…@database:5432/teslamate`。compose ファイルが `.env` から組み立てます |
| `API_TOKEN` | ✅ | サーバーのトークン（オーナーキー）：端末の最初のサインインと端末の管理に使います（16 文字以上、32 文字以上のランダムな文字列を推奨）。compose ファイルは `DRIVELENS_API_TOKEN` から取ります |
| `DRIVELENS_OWNER_KEY_MODE` | | `full`（既定）：サーバーのトークンはこれまでどおりすべてのリクエストで有効。`pair-only`：サーバーのトークンは端末の追加と管理（`/api/auth/*`）だけに使え、それ以外は 403 `owner_key_pair_only`。失敗が多すぎると 10 分間はトークンを評価すらしないため、推測しても無駄になり、ご自身の端末はそのまま使えます。端末認証が必要で、使えない場合は `full` に戻してログにエラーを出します。compose を使う場合：`.env` に設定し、**あわせて** `environment:` 下の `- DRIVELENS_OWNER_KEY_MODE=${DRIVELENS_OWNER_KEY_MODE}` のコメントを外します |
| `BIND_ADDR` | | 待ち受けアドレス。イメージ内では `0.0.0.0:8080` |
| `DRIVELENS_CORS_ORIGINS` | | ブラウザから API を呼び出せるウェブのオリジン（カンマ区切り）。`*` はすべて許可。初期設定は公式ウェブ版のみ（と、一時停止中のネイティブアプリのオリジン）。旧名の `CORS_ORIGINS` も使えます。compose を使う場合：`.env` に設定し、**あわせて** `environment:` 下の `- DRIVELENS_CORS_ORIGINS=${DRIVELENS_CORS_ORIGINS}` のコメントを外します（コメントのまま = 既定を維持。空の値にすると既定が消えます） |
| `DRIVELENS_VAPID_PRIVATE_KEY` | | プッシュの署名鍵（base64url P-256）。通常は設定不要で、初回起動時に生成してデータベースに保存します |
| `DRIVELENS_VAPID_SUBJECT` | | プッシュサービスに送る連絡先（`mailto:you@example.com` または https の URL）。初期値は DriveLens のプロジェクトページ |
| `DRIVELENS_TRUST_PROXY_HEADERS` | | `true` にすると、ログイン失敗回数の制限で `CF-Connecting-IP` / `X-Forwarded-For` からクライアントを区別します（ローカル / プライベートアドレスから来たリクエスト、つまりトンネルやリバースプロキシ経由のものだけ）。既定はオフ：接続元アドレスで数えるため、トンネルの後ろではすべてのクライアントが 1 つの制限を共有します。端末トークンは常に評価されるため、接続済みの端末が締め出されることはありません。既定のモードでは正しいサーバーのトークンも受け付けます |
| `DRIVELENS_PUSH_HOSTS` | | 通知用に追加で許可するプッシュサービスのホスト（カンマ区切り）。独自のプッシュサーバーを使うブラウザ向けです。Chrome / Edge、Firefox、Safari のプッシュサービスは常に許可されます |
| `RUST_LOG` | | ログレベル。初期値は `info` |

`.env`（`docker-compose.drivelens.yml` が使用）：`DRIVELENS_DB_PASS`、`DRIVELENS_API_TOKEN`、任意で `DRIVELENS_DB_NAME`（初期値 `teslamate`）、`DRIVELENS_IMAGE`（初期値 `ghcr.io/zzflsxygod/drivelens-api:latest`）、`CLOUDFLARE_TUNNEL_TOKEN`（cloudflared サービス用）。

API が読む任意の変数（`DRIVELENS_CORS_ORIGINS`、`DRIVELENS_OWNER_KEY_MODE`、および設定する場合の `DRIVELENS_TRUST_PROXY_HEADERS` / `DRIVELENS_VAPID_*` / `DRIVELENS_PUSH_HOSTS`）は **既定ではコンテナに渡りません**。先に `.env` に書き、`docker-compose.drivelens.yml` の `drivelens-api` → `environment:` に対応する `- NAME=${NAME}` 行を追加するかコメントを外し、`docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api` を実行します。使わないときはコメントのままにしてください。空の値にすると API の既定が消えます。

## トラブルシューティング

- **`password authentication failed for user "drivelens_ro"`**：`DRIVELENS_DB_PASS` が `setup.sql` 実行時のパスワードと違います。手順 3 をもう一度実行し（パスワードが更新されます）、drivelens-api を再起動してください。
- **`API_TOKEN must be at least 16 characters`**（コンテナが再起動を繰り返す）または **`API_TOKEN looks weak`**：`openssl rand -hex 24` で新しいトークンを作って `.env` に書き、`up -d drivelens-api` をもう一度実行して、アプリにも新しいトークンを入力してください。
- **`cannot read TeslaMate tables`** または **`disabled features: …`**：データベースアカウントの設定が不完全です。`setup.sql`（手順 3）をもう一度実行し、drivelens-api を再起動してください。`disabled features` だけの場合、走行・充電・レポートはその間も使えます。
- **設定画面でサーバーに接続できない**：まずサーバー上で `curl http://127.0.0.1:8080/health` が動くことを確認し、次にトンネル（`docker compose … logs cloudflared`）や `tailscale serve status` を確認してください。
- **`/health` は動くがデータを読み込めない**：間にリバースプロキシがある場合は、`Authorization` ヘッダーをそのまま転送する必要があります。
- **403 `owner_key_pair_only`**：サーバーが `DRIVELENS_OWNER_KEY_MODE=pair-only` で動いているため、サーバーのトークンは端末の追加と管理にしか使えません。アプリ 1.2.0 以上は自動で対応します。スクリプトから使う場合は `POST /api/auth/devices` で端末トークンを作るか、この変数を外してください。
- **429（失敗が多すぎる）**：同じ接続元から 10 分以内に 10 回失敗しました。10 分待ってください。接続済みの端末はそのまま使えます。`pair-only` ではその間サーバーのトークンを評価しません（全接続元の合計で 50 回失敗したときも同様）。
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

<a id="lan-selfhost"></a>
## 付録：LAN 内だけで使う（ウェブ版を自分でホスト、http・非公式）

> ⚠️ **非公式・サポート対象外・未検証の手順です。自己責任でお使いください。** 公式の使い方は、ウェブ版 [https://drivelens-app.oharuru.com](https://drivelens-app.oharuru.com) と手順 5 の https のアドレスです。この構成での不具合はサポートできません。

自宅の LAN からだけ使い、Cloudflare Tunnel も Tailscale も使わない場合は、ウェブ版を自分でビルドし、drivelens-api と**同じアドレス（同一オリジン）**から http で配信する方法があります。Caddy がウェブ版のファイルを配信し、`/api/` と `/health` を drivelens-api に転送します。同一オリジンなので `DRIVELENS_CORS_ORIGINS` の設定は不要です。

**http では使えないもの・注意点**

- **プッシュ通知**：使えません（「設定 → 通知」に「通知を使うには Web 版を https で開く必要があります。」と表示されます）。
- **オフライン起動**（Service Worker）：使えません。サーバーに接続できないとアプリ自体が開きません。
- **アプリとしてインストール**（Chrome / Edge / Android）：できません。iPhone / iPad の「ホーム画面に追加」はショートカットとして使えます。
- **シェアカード**：「画像をコピー」と「共有…」は表示されません。「画像を保存」は使えます。
- **暗号化なし**：トークンと走行データは LAN 内を平文で流れます。同じネットワークの人に盗み見られるおそれがあるため、信頼できる自宅のネットワークだけで使ってください。
- **地図**：地図タイル（OpenFreeMap / OpenStreetMap）はインターネットから読み込みます。
- **ポートをインターネットに公開しないでください**（ルーターでポート開放しない）。
- ウェブ版は自動では更新されません（下の「更新」を参照）。

### ウェブ版をビルド

git と Docker があれば、Node.js をインストールせずに `node:22` イメージでビルドできます。`TAG` には [Releases](https://github.com/zzflsxygod/drivelens/releases) の最新版（サーバーと同じバージョン）を指定します。

```bash
cd teslamate
TAG=v1.3.1   # Releases の最新版に置き換える
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
mkdir -p drivelens-web && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

Node.js を直接使う場合は 22（22.12 以上、または 20.19 以上）で `cd drivelens-src/app && npm ci && npm run build:web` を実行します。成果物は `app/dist-web/` です。環境変数は不要です。`dist-web/_headers` は Cloudflare Pages 用で Caddy では使われません（必要な設定は下の Caddyfile に入っています）。

### Caddy の設定

`teslamate/Caddyfile.drivelens` を作ります。

```caddyfile
:80 {
	encode zstd gzip
	@api path /api/* /health
	handle @api {
		reverse_proxy drivelens-api:8080
	}
	handle {
		root * /srv
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@other not path /assets/*
		header @other Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
	}
}
```

`docker-compose.drivelens.yml` の `services:` に次を追加します（`drivelens-api` の `ports:` は初期設定の `127.0.0.1:8080:8080` のままで構いません）。

```yaml
  drivelens-web:
    image: caddy:2
    restart: always
    depends_on:
      - drivelens-api
    ports:
      - "8081:80"   # LAN の IP だけで待ち受けるなら "192.168.1.10:8081:80"
    volumes:
      - ./Caddyfile.drivelens:/etc/caddy/Caddyfile:ro
      - ./drivelens-web:/srv:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-web
```

`docker-compose.drivelens.yml` をダウンロードし直すと、この追加分は消えます。

任意：Caddy 経由ではすべての端末が同じ接続元に見えるため、ログイン失敗の回数制限を端末ごとに数えたい場合は `drivelens-api` の `environment:` に `- DRIVELENS_TRUST_PROXY_HEADERS=true` を追加します。

### 接続

1. ブラウザで `http://<サーバーの LAN IP>:8081` を開きます（例：`http://192.168.1.10:8081`。サーバーの IP はルーターで固定しておくと安心です）。
2. 「サーバーの URL」に**同じアドレス** `http://192.168.1.10:8081` を入力します。`http://` は省略しないでください（省略すると `https://` とみなされます）。
3. 「ペアリングコード または サーバーのトークン」にサーバーのトークン（`DRIVELENS_API_TOKEN`）か、接続済みの端末の「設定 → 端末 → 端末を追加」で発行したペアリングコードを入力し、「接続をテストして始める」を押します。
4. 「暗号化されていない http 接続です。…」という警告が出ますが、この構成では想定どおりです。ようこそ画面の「ウェブ版に必要なもの」（https が必要という説明）は公式ウェブ版向けの内容です。

公式ウェブ版とはアドレスが違うため、接続情報は別々に保存されます。アドレスはあとから「設定 → サーバー」の「API の URL」で変更できます。

### 更新

サーバー（drivelens-api）を更新したら、ウェブ版も同じリリースのタグでビルドし直します。Watchtower を使う場合は常に最新版になるので、ウェブ版も最新のタグにしてください（バージョンを揃えたい場合は `.env` の `DRIVELENS_IMAGE` で同じタグに固定します）。

```bash
cd teslamate
TAG=v1.3.1   # 新しいリリース
rm -rf drivelens-src
git clone --depth 1 --branch "$TAG" https://github.com/zzflsxygod/drivelens.git drivelens-src
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/drivelens-src/app:/app" -w /app node:22 \
  sh -c "npm ci && npm run build:web"
rm -rf drivelens-web/* && cp -a drivelens-src/app/dist-web/. drivelens-web/
```

`drivelens-web` フォルダー自体は削除しないでください（コンテナのマウントが外れます。消してしまった場合は `docker compose -f docker-compose.yml -f docker-compose.drivelens.yml restart drivelens-web`）。ブラウザでページを再読み込みすると新しい版になります。ウェブ版がサーバーより古い・新しい場合も基本的には動き、サーバーの更新が必要な機能はアプリが知らせます。

<a id="auth-proxy"></a>
### 認証プロキシの後ろ（同一オリジン・非公式）

> ⚠️ **非公式・サポート対象外・DriveLens 未検証の手順です。** 本付録のとおりウェブ版と API を**同一オリジン**でホストしたうえで、oauth2-proxy や Cloudflare Access などのログインを前段に置きたい方向けです。DriveLens はこの構成を検証していません。自己責任でお使いください。

[手順 5](#cloudflare-tunnel)の「API の前に Cloudflare Access を置かない」は、**公式ウェブ版**（別オリジン）向けです。セルフホストでウェブ版と `drivelens-api` が同じホストなら、ブラウザはプロキシのセッション Cookie をページにも `/api/` にも付けるので、そのホストの前に認証プロキシを置けます。DriveLens は引き続き独自の端末トークン（`Authorization: Bearer …`）を検証します。プロキシは追加の門であり、端末トークンの代わりにはなりません。

**推奨：ForwardAuth（セッション確認だけ）**

リバースプロキシが oauth2-proxy に「このリクエストは認証済みか」を問い合わせ、通ったものだけをそのまま転送します。oauth2-proxy は確認（`/oauth2/auth`）に答えるだけで、ボディも `Authorization` ヘッダーも書き換えません。

- **`/api/`**（およびアプリが JSON として取るパス）では、未認証時はログイン HTML への **302** ではなく **401** を返してください。oauth2-proxy では `/oauth2/auth`（Traefik の `forwardAuth` / Caddy の `forward_auth` が使うエンドポイント）です。ログイン画面が必要な場合は、通常のページ読み込みだけ IdP へリダイレクトしてください。
- 認証バックエンドが落ちているときは**閉じる**（5xx / 拒否）。リクエストを通さないでください。
- クライアントの `Authorization: Bearer <DriveLens 端末トークン>` は**そのまま転送**してください。`--set-authorization-header` は使わないでください（Bearer が IdP のトークンに置き換わります）。`--pass-authorization-header` は oauth2-proxy が**自分で**上流へプロキシするときだけ意味があります。ForwardAuth ではアプリのリクエストをプロキシしないので、オフのままで構いません。DriveLens が自前のトークンを検証します。
- ForwardAuth を使うときは、oauth2-proxy に `--reverse-proxy=true` と upstream `static://202`（または同等）を付け、`/oauth2/auth` に答えるだけにしてアプリの通信はプロキシしないでください。
- DriveLens は**専用（サブ）ドメインのルート**で配信してください（例：`https://drivelens.example.com/`）。`/drivelens/` のようなサブパスは**非対応**です。`manifest.webmanifest`、Service Worker（`/sw.js`、スコープ `/`）、アセット URL はルート絶対パスです。
- `manifest.webmanifest` は Cookie なしで取得されることがあります。ホーム画面への追加が失敗するなら認証対象外にしてください。`/health` を外すかは任意（死活監視用）。

**Traefik**（骨格 — ホスト名と URL は置き換えてください）：

```yaml
http:
  middlewares:
    oauth2-auth:
      forwardAuth:
        address: "http://oauth2-proxy:4180/oauth2/auth"
        trustForwardHeader: true
        # Authorization を authResponseHeaders に入れない —
        # DriveLens はクライアント元の Bearer が必要。
  routers:
    # ログイン/コールバックは認証ミドルウェアなし（優先度高）。
    oauth2:
      rule: "Host(`drivelens.example.com`) && PathPrefix(`/oauth2/`)"
      priority: 100
      service: oauth2-proxy
    drivelens:
      rule: "Host(`drivelens.example.com`)"
      priority: 1
      middlewares: ["oauth2-auth"]
      service: drivelens
  services:
    oauth2-proxy:
      loadBalancer:
        servers:
          - url: "http://oauth2-proxy:4180"
    drivelens:
      loadBalancer:
        servers:
          - url: "http://drivelens-web:80"
```

初回アクセスでブラウザをログインへ送りたい場合は、非 API パスの 401 を捕捉して oauth2-proxy の開始 URL（例：`/oauth2/start`）へリダイレクトし、`/api/` はプレーンな 401 のままにしてください。

**Caddy**（骨格 — 同一オリジンのウェブ + API；`/oauth2/*` は `forward_auth` を通さない）：

```caddyfile
drivelens.example.com {
	# ログイン/コールバックは forward_auth を通さず oauth2-proxy へ
	# （通すとコールバックがループする）。
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180
	}

	# 任意：死活監視用に /health は認証なし。
	handle /health {
		reverse_proxy drivelens-api:8080
	}

	handle {
		# /oauth2/auth → セッションが無いとき 401（/api/ 向き）。
		# oauth2-proxy: --reverse-proxy=true --upstream=static://202；
		# --set-authorization-header は使わない。
		forward_auth oauth2-proxy:4180 {
			uri /oauth2/auth
		}

		handle /api/* {
			reverse_proxy drivelens-api:8080
		}
		handle {
			root * /srv
			try_files {path} /index.html
			file_server
		}
	}
}
```

同じホスト名の **Cloudflare Access** も同じ考え方です（そのホスト上のセッション）。セッションが無いとき API クライアントには HTML ログインへのリダイレクトより 401 を返し、`Authorization` を剥がしたり差し替えたりしないでください。

**プロキシのセッションが切れたときのアプリの動き**

プロキシが返す 401 では端末は**サインアウトしません**。保存済みの接続を消すのは、**drivelens-api** 自身が `401` で JSON `{"error":"unauthorized"}` を返したとき（端末トークンが失効・期限切れ）だけです。プロキシの 401/5xx やネットワークエラーはエラー表示のまま接続を残します。IdP に再ログインしてページを再読み込みしてください。
