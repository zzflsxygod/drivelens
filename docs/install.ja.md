# DriveLens インストールガイド（TeslaMate を自分で運用している方向け）

[中文](install.md) · [English](install.en.md) · **日本語**

DriveLens は次の 2 つで構成されています。

- **drivelens-api**：TeslaMate サーバー上で動く小さなサービス（Docker コンテナ）。読み取り専用アカウントで TeslaMate のデータベースを読み込みます。
- **DriveLens アプリ**：スマートフォン / PC 用のクライアント。初回起動時にサーバーの URL とトークンを入力するだけで使えます。

> DriveLens は **TeslaMate のテーブルを一切変更しません**。TeslaMate のテーブルに対しては SELECT 権限のみで、DriveLens 独自のデータ（地点名、手入力の充電料金、旅程、カバー画像、天気キャッシュ）はすべて独立した `drivelens` スキーマに保存されます。

## 前提条件

- TeslaMate を Docker Compose で運用していること（公式の `docker-compose.yml`。データベースのサービス名は `database`、データベース名 / 管理ユーザーは既定で `teslamate`）。
- サーバーは x86_64 / ARM64 のどちらでも可（Raspberry Pi など）。
- 外部から安全にサーバーへ接続する手段：**Cloudflare Tunnel または Tailscale を推奨**（手順 5）。

## 1. ソースコードを用意する

TeslaMate の compose ディレクトリの中に `drivelens/` フォルダを作り、DriveLens のソースを置きます（受け取ったアーカイブを展開するか `git clone`）。

```
teslamate/
├── docker-compose.yml        # 既存の TeslaMate の設定
├── .env
└── drivelens/                # DriveLens のソース
    ├── api/
    └── deploy/
```

## 2. パスワードとトークンを生成して `.env` に書く

TeslaMate の compose ディレクトリで実行します。

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS`：読み取り専用データベースアカウント `drivelens_ro` のパスワード。
- `DRIVELENS_API_TOKEN`：アプリが接続に使うトークン（**16 文字以上、32 文字以上のランダムな文字列を推奨**。短すぎると API のログとアプリに警告が出ます）。

## 3. データベースアカウントを作成する（最初の 1 回のみ）

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < drivelens/deploy/setup.sql
```

`setup.sql` は何度実行しても安全です。次の処理を行います。

1. ログインロール `drivelens_ro` を作成（既にあればパスワードのみ更新）
2. TeslaMate のテーブルへの **SELECT** 権限を付与（今後の TeslaMate アップデートで追加されるテーブルも含む）
3. `cars / addresses / drives / charging_processes` への REFERENCES 権限を付与（DriveLens のテーブルが外部キーで参照し、TeslaMate で走行が削除されると関連データも自動で消えます。**書き込み権限は含みません**）
4. `drivelens` スキーマを作成し、所有者を `drivelens_ro` にする

以降は API の起動のたびに **`drivelens` スキーマ内のテーブルが自動で作成・更新されます**（冪等）。追加の SQL 実行は不要です。

> データベース名や管理ユーザーが `teslamate` でない場合は、コマンドの `-U` / `-d` を変更し、`.env` に `DRIVELENS_DB_NAME=データベース名` を追加してください。

## 4. drivelens-api を起動する

```bash
cp drivelens/deploy/docker-compose.drivelens.yml .
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d --build drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

初回のビルドには数分かかります（Raspberry Pi では 10 分以上かかることもあります）。ログに次のように出れば正常です。

```
INFO drivelens_api: all features enabled (API level 12)
INFO drivelens_api: listening on 0.0.0.0:8080
```

`disabled features: …` や `cannot read TeslaMate tables` と表示される場合は手順 3 が成功していません。`setup.sql` を再実行してから `docker compose restart drivelens-api` を実行してください。その間も読み取り系の機能（走行、充電、レポートなど）は使えます。

ローカルでの確認：`curl http://127.0.0.1:8080/health` で `{"status":"ok","version":"…","api_level":…}` が返れば OK です。

### 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:パスワード@database:5432/teslamate`（compose ファイルが `.env` から組み立てます） |
| `API_TOKEN` | ✅ | アプリ用の Bearer トークン。16 文字以上、32 文字以上を推奨 |
| `BIND_ADDR` | | 待ち受けアドレス。イメージの既定は `0.0.0.0:8080` |
| `DRIVELENS_CORS_ORIGINS` | | ブラウザから API を呼び出せる Web のオリジン（カンマ区切り、v0.11.0 以降。旧名 `CORS_ORIGINS` も有効）。既定は公式ウェブ版 `https://drivelens-app.oharuru.com` のみ。Windows / Android アプリは常に許可されます。ウェブ版を自分でホストする場合はその URL を追加。`*` はすべて許可 |
| `RUST_LOG` | | ログレベル。既定は `info` |

compose ファイルが使う `.env` の変数：`DRIVELENS_DB_PASS`、`DRIVELENS_API_TOKEN`、任意で `DRIVELENS_DB_NAME`（既定 teslamate）、`DRIVELENS_SRC`（ソースの場所、既定 `./drivelens`）、`DRIVELENS_IMAGE`（独自のレジストリを使う場合）。

### アップデート

```bash
cd drivelens && git pull   # または新しいバージョンのソースに置き換え
cd .. && docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d --build drivelens-api
```

データベースの構造は API の起動時に自動で更新されます。

## 5. 外部から安全に接続する（どちらか一方）

**ポート 8080 をインターネットに直接公開しないでください**（https がないとトークンが平文で送られます）。

### 方法 A：Cloudflare Tunnel（独自ドメインがある場合におすすめ）

1. Cloudflare Zero Trust → Networks → Tunnels でトンネルを作成し、トークンをコピーします。
2. `docker-compose.drivelens.yml` の `cloudflared` の部分のコメントを外し、`.env` に `CLOUDFLARE_TUNNEL_TOKEN=…` を追加します。この場合 `drivelens-api` の `ports:` は削除できます。
3. トンネルの Public Hostname に `drivelens.あなたのドメイン` → `http://drivelens-api:8080` を追加します（cloudflared をホストに直接入れている場合は `http://127.0.0.1:8080`）。
4. アプリには `https://drivelens.あなたのドメイン` を入力します。

### 方法 B：Tailscale（ドメインがない / 公開したくない場合）

1. サーバーとスマートフォンの両方に Tailscale を入れ、同じアカウントでログインします。
2. compose の `ports` を `- "8080:8080"` に変更します（Tailscale / LAN 内からのみ接続。ルーターでポート転送はしないでください）。
3. アプリには `http://サーバーの Tailscale IP または名前:8080`（例：`http://100.x.y.z:8080`）を入力します。`tailscale serve` で https 化することもできます。

> セキュリティ対策：トークンは定数時間で比較。同じ IP から 10 分以内に 10 回認証に失敗すると一時的に拒否（HTTP 429）。TeslaMate のテーブルへのアクセスは読み取りのみ。

## 6. アプリをインストールして設定する

1. アプリをインストールします（Windows インストーラー / Android APK。DriveLens を共有してくれた方から入手してください）。
2. 初回起動時に「DriveLens へようこそ」が表示されます（言語はシステムに合わせて選ばれ、右上で切り替えられます）。
   - **サーバーの URL**：手順 5 の URL（例：`https://drivelens.example.com`）
   - **API トークン**：`.env` の `DRIVELENS_API_TOKEN`
3. 「接続をテストして始める」をタップします。アプリはまず `/health` を確認し、次にトークンを使って車両を読み込みます。失敗した場合は原因が表示されます。

| 表示 | 対処 |
| --- | --- |
| トークンが正しくありません（401） | `DRIVELENS_API_TOKEN` を空白や引用符を含めずにコピーし直す |
| 接続できません / タイムアウト | URL と、トンネルまたは Tailscale が動いているかを確認。Cloudflare Tunnel は `https://`、ポートへの直接接続は通常 `http://…:8080` |
| DriveLens API ではありません | TeslaMate / Grafana の URL を入力しています。drivelens-api の URL に変更 |
| サーバーが古すぎます | 「アップデート」の手順で drivelens-api を更新 |
| トークンの誤りが多すぎる（429） | 10 分待ってから再試行 |

サーバーの URL とトークンは、あとから「設定」でいつでも変更できます（新しい設定はテストに成功した場合のみ保存されます）。アプリの言語、地図の表記言語、デフォルトの通貨は端末の設定に合わせて選ばれ、「設定」で変更することもできます。

## 7. ウェブ版（PWA）

アプリをインストールしたくない場合は、ブラウザで **https://drivelens-app.oharuru.com** を開き、サーバーアドレスとトークンを入力するだけで使えます（先にデモを試すこともできます）。ウェブ版は静的ファイルだけで、ブラウザが**ご自身の** drivelens-api に直接アクセスします。トークンやデータがウェブのホストを経由することはありません。

**サーバーの条件**

- **drivelens-api v0.11.0 以降**：公式ウェブ版からのアクセス（CORS）を標準で許可します。`DRIVELENS_CORS_ORIGINS` を設定している場合は `https://drivelens-app.oharuru.com` も含めてください。例：
  ```yaml
  environment:
    - DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com
  ```
- **https が必須**：https のページから `http://` のアドレスにはアクセスできません（混在コンテンツ）。Cloudflare Tunnel（方法 A）ならそのまま使えます。Tailscale の場合は `tailscale serve` を有効にして `https://マシン名.tailnet名.ts.net` を使い、`http://100.x.y.z:8080` は使わないでください。
- API の前に Cloudflare Access などのログイン画面を置かないでください。ブラウザのクロスオリジン通信がブロックされます。

**ホーム画面に追加**

- Android（Chrome）/ パソコン（Chrome・Edge）：「設定」の一番下の「アプリとしてインストール」、またはブラウザのメニュー →「アプリをインストール」。
- iPhone / iPad（Safari）：「共有」→「ホーム画面に追加」。インストール後は全画面・縦向きで表示されます。

**補足**

- トークンはこのブラウザのローカルストレージに保存されます。共用パソコンでは使用後に「設定」で消去してください。
- オフラインキャッシュはアプリ本体（HTML / JS / CSS / アイコン）のみで、API のレスポンスはキャッシュしません。
- ウェブ版を自分でホストする場合：リリースから `DriveLens_バージョン_web.zip` をダウンロードし、https の静的ホスティングに展開（存在しないパスは `index.html` にフォールバック）して、その URL をサーバーの `DRIVELENS_CORS_ORIGINS` に追加してください。

| ウェブ版のメッセージ | 対処 |
| --- | --- |
| サーバーがこのサイトを許可していない（CORS） | drivelens-api を v0.11.0 以降に更新し、`DRIVELENS_CORS_ORIGINS` を確認 |
| http のサーバーアドレスはブロックされる | https のアドレスを使う（Cloudflare Tunnel / `tailscale serve`） |
| 接続できない（証明書 / ドメイン） | ドメイン、トンネルの稼働、証明書の有効性を確認 |

## よくある質問

- **ログに `password authentication failed for user "drivelens_ro"` と出る**：`.env` の `DRIVELENS_DB_PASS` と `setup.sql` 実行時のパスワードが一致していません。手順 3 をもう一度実行してください（パスワードが更新されます）。
- **ログに `API_TOKEN looks weak` と出る**：トークンが短いか単純すぎます。`openssl rand -hex 24` で生成した値に変更し、アプリの設定も更新してください。
- **アンインストール**：`drivelens-api` コンテナを停止・削除し、必要であれば管理ユーザーで
  `DROP SCHEMA drivelens CASCADE; DROP OWNED BY drivelens_ro; DROP ROLE drivelens_ro;` を実行します。TeslaMate のデータには影響しません。
