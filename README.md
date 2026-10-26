# Hikidashi

AIとのチャットで学んだことを、1概念1枚のカードにして復習するWebアプリ。

チャットは流れていき、読み返しても知識は定着しにくい。Hikidashi では、わからなかった用語や概念をカードとして1か所にしまい、忘れかけた頃に出題して**自分の言葉で思い出す**ことで定着させる。名前は、知識をしまう「引き出し」と、記憶から「引き出す」練習の両方から。

## できること

| 機能 | 内容 |
| --- | --- |
| カードの保存 | Claude Code で `/hikidashi` と打つと、会話から概念を拾ってカードにする。既存カードとの関連付けや、同じ概念への追記も自動 |
| 復習 | 問題に自分の言葉で答えてから模範解答を見て、「もう一度 / 難しい / できた / 簡単」で自己採点する。カテゴリで絞り込める |
| 出題間隔の計算 | 採点結果から、次にいつ出題するかを [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) で計算する |
| 通知 | 設定した時刻に、復習待ちがあればスマホやPCに通知する。回答しないままだと再通知する |
| 追加の制限 | 復習待ちがたまると、新しいカードを追加できなくなる。覚える量より復習を優先させるため |
| 書き出し | 全カードを Markdown で書き出せる |

## 構成

```mermaid
flowchart TB
    cc["Claude Code<br/>/hikidashi スキル"]
    web["ブラウザ / Android<br/>（ホーム画面に追加）"]
    push["プッシュサービス<br/>（Chrome なら FCM）"]

    subgraph cf["Cloudflare（無料枠）"]
        assets["静的ファイル<br/>画面・Service Worker"]
        worker["Workers<br/>API（Hono）"]
        cron["Cron<br/>15分ごと"]
        db[("D1<br/>カード・回答履歴・設定")]
    end

    cc -- "カードを保存" --> worker
    web -- "画面を取得" --> assets
    web -- "出題・採点・編集" --> worker
    cron -- "通知するか判定" --> worker
    worker <--> db
    worker -- "通知を依頼" --> push
    push -. "通知" .-> web
```

- **画面**はビルド不要の素の HTML / CSS / JavaScript（`public/`）。Workers の静的ファイル配信で返す
- **API** は Hono で書いた Worker（`src/`）。`/api/*` だけが Worker を通る
- **データ**はすべて D1 に入る。Claude の契約とは独立しているので、契約をやめても残る

## 主な流れ

### カードを保存する

```mermaid
sequenceDiagram
    actor user as 自分
    participant cc as Claude Code
    participant api as Hikidashi API
    participant db as D1

    user->>cc: /hikidashi
    cc->>api: GET /api/titles（既存カード）
    api-->>cc: タイトルとカテゴリ
    cc->>cc: 会話から概念を拾い、1概念1枚に書く
    cc->>api: POST /api/cards
    alt 復習待ちがたまっている
        api-->>cc: 423（追加できない）
        cc-->>user: 先に復習するよう伝える
    else 追加できる
        api->>db: 保存（すぐ復習待ちになる）
        api-->>cc: 作成したカード / 重複したカード
        cc->>api: 重複分は PUT で追記
        cc-->>user: 保存したタイトルの一覧
    end
```

### 復習する

```mermaid
flowchart LR
    q["問題を見る"] --> a["自分の言葉で答える"]
    a --> r["模範解答を見る"]
    r --> g{"自己採点"}
    g -- "もう一度" --> s1["数分後にまた出題"]
    g -- "難しい / できた / 簡単" --> s2["FSRS で次の出題日を計算<br/>思い出せるほど間隔が広がる"]
```

各ボタンには次に出題されるまでの間隔が表示される。復習中に内容の誤りに気づいたら、その場で編集・削除できる。

### 通知する

プッシュには中身を載せず、受け取った Service Worker が件数を取りに行って通知を組み立てる。中身がないので暗号化が要らず、VAPID の署名だけで送れる。

```mermaid
sequenceDiagram
    participant cron as Cron（15分ごと）
    participant api as Worker
    participant push as プッシュサービス
    participant sw as Service Worker（端末）

    cron->>api: 通知するか判定
    Note over api: 復習待ちがある かつ<br/>設定時刻になった、または<br/>前回の通知から回答がなく再通知の間隔が過ぎた
    api->>push: 中身なしのプッシュ（VAPID 署名つき）
    push->>sw: 届く
    sw->>api: GET /api/stats
    api-->>sw: 復習待ちの件数
    sw->>sw: 「復習の時間です N問」を表示
```

## ディレクトリ

```
hikidashi/
├── src/
│   ├── index.ts        API・出題間隔の計算・通知の判定
│   └── push.ts         Web Push の送信（VAPID 署名）
├── public/             画面（ビルド不要）
│   ├── index.html
│   ├── app.js          復習・カード・設定の各画面
│   ├── style.css
│   ├── sw.js           Service Worker（通知の受信と表示）
│   └── manifest.webmanifest
├── migrations/         D1 のテーブル定義
├── skill/hikidashi/    Claude Code の /hikidashi スキル
├── scripts/            VAPID 鍵とアイコンの生成
└── wrangler.jsonc      Cloudflare の設定
```

## セットアップ

### ローカルで動かす

```bash
npm install
npm run gen:vapid > .dev.vars
echo "APP_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')" >> .dev.vars
echo "APP_URL=http://localhost:8787" >> .dev.vars
npm run db:migrate:local
npm run dev
```

`http://localhost:8787` を開き、`.dev.vars` の `APP_TOKEN` でログインする。通知の判定は次のコマンドで手動実行できる。

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

### Cloudflare にデプロイする

```bash
npx wrangler login
npx wrangler d1 create hikidashi         # 出力された database_id を wrangler.jsonc に書く
npm run db:migrate
npm run gen:vapid                       # 出力された2つの値を次の secret に入れる
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put APP_TOKEN       # ログイン用の長いランダム文字列
npm run deploy
```

デプロイ後に表示された URL を `wrangler.jsonc` の `vars.APP_URL` に書き、もう一度 `npm run deploy` する。

### スマホで使う

1. Android の Chrome でデプロイした URL を開き、`APP_TOKEN` でログインする
2. メニューの「ホーム画面に追加」でアプリとして置く
3. 設定画面で通知をオンにし、「テスト」で届くか確かめる

### /hikidashi スキルを使えるようにする

```bash
ln -s "$(pwd)/skill/hikidashi" ~/.claude/skills/hikidashi
mkdir -p ~/.config/hikidashi
```

`~/.config/hikidashi/config` に接続情報を書く。トークンを含むので、自分だけが読めるようにしておく（`chmod 600`）。

```
HIKIDASHI_URL=https://hikidashi.<subdomain>.workers.dev
HIKIDASHI_TOKEN=<APP_TOKEN と同じ値>
```

## 秘匿情報の置き場所

リポジトリには含めない。

| 値 | 本番 | ローカル |
| --- | --- | --- |
| `APP_TOKEN`（ログイン用） | Cloudflare の secret | `.dev.vars` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（通知用） | Cloudflare の secret | `.dev.vars` |
| `HIKIDASHI_TOKEN`（スキル用） | ー | `~/.config/hikidashi/config` |

## 費用

Cloudflare の無料枠で収まる。上限を超えても無料プランでは請求されず、その日のリクエストがエラーになるだけ。

| 使っているもの | 無料枠の目安 | 使用量の目安 |
| --- | --- | --- |
| Workers | 1日10万リクエスト | 1日数十〜数百 |
| D1 | 5GB、読み取り1日500万行 | カード数千枚で数MB |
| Cron | 無料プランで利用可 | 1日96回 |
| プッシュ通知 | 無料 | ー |

採点は自己採点なので、AI の API 料金もかからない。

## API

すべて `Authorization: Bearer <APP_TOKEN>` か、ログイン時に発行される Cookie が必要。

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/login` | トークンでログインし、Cookie を発行する |
| GET | `/api/stats` | 復習待ちの件数、カテゴリ別の件数、追加が止まっているか |
| GET | `/api/titles` | 全カードのタイトルとカテゴリ |
| GET | `/api/cards?q=&category=` | カード一覧 |
| POST | `/api/cards` | カードを作成する（1枚または配列）。復習待ちがたまっていると 423 |
| GET / PUT / DELETE | `/api/cards/:id` | カードの取得・更新・削除 |
| GET | `/api/review?category=` | 復習待ちのカード。採点ごとの次回間隔つき |
| POST | `/api/cards/:id/review` | `{ rating: 1〜4, response }` で採点する |
| GET / PUT | `/api/settings` | 通知時刻・再通知・問題数・追加停止の設定 |
| GET | `/api/export.md` | 全カードを Markdown で書き出す |
| GET | `/api/push/key` | 通知の購読に使う公開鍵 |
| POST | `/api/push/subscribe` / `/api/push/unsubscribe` | 通知の購読・解除 |
| POST | `/api/push/test` | テスト通知を送る |

## 使っているライブラリ

- [Hono](https://hono.dev/)（MIT）：API のルーティング
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)（MIT）：出題間隔の計算
