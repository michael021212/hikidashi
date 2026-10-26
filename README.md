# Hikidashi

AIとのチャットで学んだことを1概念1枚のカードにして、間隔反復で復習するWebアプリ。

- Cloudflare Workers + D1（無料枠で動く）
- 間隔反復は [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
- プッシュ通知はペイロードなしの Web Push。件数は Service Worker が `/api/stats` から取得する
- カードの取り込みは Claude Code の `/hikidashi` スキル（`skill/hikidashi/SKILL.md`）または画面から

## ローカル開発

```bash
npm install
npm run gen:vapid > .dev.vars
echo "APP_TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')" >> .dev.vars
npm run db:migrate:local
npm run dev
```

`http://localhost:8787` を開き、`.dev.vars` の `APP_TOKEN` でログインする。
定期実行は `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` で試せる。

## デプロイ

```bash
npx wrangler login
npx wrangler d1 create hikidashi          # 出力された database_id を wrangler.jsonc に書く
npm run db:migrate
npm run gen:vapid                      # 出力された2つの値を次の secret に入れる
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put APP_TOKEN      # 長いランダム文字列
npm run deploy
```

デプロイ後、表示された URL を `wrangler.jsonc` の `vars.APP_URL` に書いて、もう一度 `npm run deploy` する。

## /hikidashi スキルの設定

`~/.claude/skills/hikidashi` に `skill/hikidashi` へのシンボリックリンクを置く。接続情報は `~/.config/hikidashi/config` に書く。

```
HIKIDASHI_URL=https://hikidashi.<subdomain>.workers.dev
HIKIDASHI_TOKEN=<APP_TOKEN と同じ値>
```

## API

すべて `Authorization: Bearer <APP_TOKEN>` またはログイン時の Cookie が必要。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/stats` | 復習待ち件数、カテゴリ別件数、追加停止中かどうか |
| GET | `/api/titles` | 全カードのタイトルとカテゴリ |
| GET | `/api/cards?q=&category=` | カード一覧 |
| POST | `/api/cards` | カード作成（単体または配列）。復習がたまっていると 423 |
| GET / PUT / DELETE | `/api/cards/:id` | カードの取得・更新・削除 |
| GET | `/api/review?category=` | 復習待ちのカード（各評価での次回間隔つき） |
| POST | `/api/cards/:id/review` | `{ rating: 1-4, response }` で採点 |
| GET / PUT | `/api/settings` | 通知時刻・再通知・問題数・追加停止の設定 |
| GET | `/api/export.md` | 全カードを Markdown で書き出す |
