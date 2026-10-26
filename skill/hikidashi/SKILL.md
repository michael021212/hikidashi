---
name: hikidashi
description: この会話で学んだ用語・概念を、復習アプリ Hikidashi のカードとして保存する。ユーザーが /hikidashi と打ったとき、または「カードにして」「覚えておきたい」「復習に入れて」と頼んだときに使う。
---

# /hikidashi

会話の中でユーザーが知らなかった用語・概念を、1概念1枚のカードにして Hikidashi に保存する。

## 接続情報

`~/.config/hikidashi/config` に次の2行がある。なければユーザーに作成を頼み、作業を止める。

```
HIKIDASHI_URL=https://hikidashi.example.workers.dev
HIKIDASHI_TOKEN=...
```

API 呼び出しは毎回この形にする。トークンを画面に出力しない。

```bash
source ~/.config/hikidashi/config && curl -sS -H "Authorization: Bearer $HIKIDASHI_TOKEN" "$HIKIDASHI_URL/api/..."
```

## 手順

1. **対象を決める**：引数があればそれを対象にする。なければ会話全体から、ユーザーが質問した・知らなかった概念を拾う。ユーザーがすでに知っていた前提知識や、雑談的な話題は入れない。1つの質問から複数の概念が出てきたら分ける。

2. **既存カードを取得する**：`GET /api/titles` で既存のタイトルとカテゴリを取る。
   - 同じ概念のカードがすでにあれば新規作成せず、手順5の更新に回す
   - カテゴリは既存のものに合うならそれを使う。新しく作るときは「Web」「会計」「統計」のような短い分野名にする

3. **カードを書く**：各フィールドは次のとおり。すべて日本語。
   - `title`：用語や概念の名前（例：「CORS」「減価償却」）
   - `question`：自分の言葉で説明させる問い。はい/いいえや一語で答えられる問いにしない（例：「CORSがなぜ必要なのか、ブラウザの立場から説明してください」）
   - `answer`：問いへの答えの核心。1〜2文
   - `explanation`：仕組み・理由・具体例。3〜6文程度。会話で使われた例えや具体例があれば活かす。`answer` と `explanation` だけで `question` に答えられるようにする（「流れに沿って」と問うなら流れを、「違い」を問うなら違いを書く）。その概念にいつでも当てはまる一般的な内容を書き、会話のきっかけになった特定の事件・製品・事例の詳細はその事例のカードに書いて、ここでは例として1文で触れる程度にする
   - `pitfalls`：ユーザーが誤解していた点、追加で質問した点。会話から読み取れなければ空にする。推測で作らない
   - `category`：手順2で決めたもの
   - `related`：関係する既存カードのタイトルと、今回一緒に作るカードのタイトル
   - `source`：`Claude Code` など、どこで学んだか

4. **保存する**：カードの配列を一時ファイルに JSON で書き、`POST /api/cards` に送る。
   ```bash
   source ~/.config/hikidashi/config && curl -sS -X POST -H "Authorization: Bearer $HIKIDASHI_TOKEN" \
     -H "Content-Type: application/json" --data @/path/to/cards.json "$HIKIDASHI_URL/api/cards"
   ```
   レスポンスは `{ created, conflicts, invalid }`。
   - **423 が返ったら**：復習がたまっていて追加が止められている。迂回せず、`due` の問題数と `$HIKIDASHI_URL/#/review` を伝えて終わる。作ったカードの内容は会話に残しておき、復習後にもう一度 /hikidashi すれば保存できると伝える
   - `conflicts` に入ったものは手順5へ

5. **既存カードを更新する**：同じ概念がすでにある場合は `GET /api/cards/{id}` で中身を見て、新しく分かったことだけを `explanation` や `pitfalls` に追記した内容を `PUT /api/cards/{id}` で送る。既存の記述は消さない。

6. **報告する**：作成・更新したカードのタイトルとカテゴリを一覧で短く伝える。カードの全文は繰り返さない。
