// カードの書き方。MCP のツール説明と、貼り付け取り込み用のプロンプトの両方で使う

export const CARD_FIELDS_GUIDE = `- title：用語や概念の名前（例：「CORS」「減価償却」）
- question：自分の言葉で説明させる問い。はい/いいえや一語で答えられる問いにしない（例：「CORSがなぜ必要なのか、ブラウザの立場から説明してください」）
- answer：問いへの答えの核心。1〜2文
- explanation：仕組み・理由・具体例。3〜6文程度。会話で使われた例えや具体例があれば活かす。answer と explanation だけで question に答えられるようにする（「流れに沿って」と問うなら流れを、「違い」を問うなら違いを書く）。その概念にいつでも当てはまる一般的な内容を書き、会話のきっかけになった特定の事件・製品・事例の詳細はその事例のカードに書き、ここでは例として1文で触れる程度にする
- pitfalls：ユーザーが誤解していた点、追加で質問した点。会話から読み取れなければ空文字にする。推測で作らない
- diagram：やり取りの流れ・構造・比較を問うカードにだけ付ける Mermaid の図。それ以外は空文字にする。explanation に書いた内容だけを図にし、説明にないことを足さない。スマホで読めるよう、登場するもの・箱は6個まで、矢印やメモのラベルは15文字程度までにする。流れは sequenceDiagram、構造や比較は flowchart TB を使う。色やスタイルは指定しない
- category：「Web」「会計」「統計」のような短い分野名。既存のカテゴリに合うならそれを使う
- related：関係する既存カードのタイトルと、今回一緒に作るカードのタイトルの配列`;

export const CARD_SELECTION_GUIDE = `会話の中でユーザーが質問した・知らなかった用語や概念を、1概念1枚のカードにする。ユーザーがすでに知っていた前提知識や雑談は入れない。1つの質問から複数の概念が出てきたら分ける。すべて日本語で書く。`;

type Existing = { title: string; category: string }[];

// 既存カードのタイトル一覧に使う文字数の上限。チャットに貼れて、AI が見落としにくい長さに収める
const TITLES_BUDGET = 15000;

/** 新しいカードから順に、上限に収まるだけカテゴリごとにまとめる。existing は新しい順で渡す */
function existingTitles(existing: Existing): string {
  const groups = new Map<string, string[]>();
  let length = 0;
  for (const { title, category } of existing) {
    length += title.length + 1;
    if (length > TITLES_BUDGET) break;
    groups.set(category, [...(groups.get(category) ?? []), title]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, "ja"))
    .map(([category, titles]) => `- ${category}：${titles.join("、")}`)
    .join("\n");
}

/** どの AI のチャットにも貼れる、カードを JSON で出力させる指示文 */
export function importPrompt(existing: Existing): string {
  const categories = [...new Set(existing.map((c) => c.category))].sort((a, b) => a.localeCompare(b, "ja"));
  return `この会話で私が学んだことを、復習用のカードにしてください。

${CARD_SELECTION_GUIDE}

各カードの項目：
${CARD_FIELDS_GUIDE}
- source：このチャットのサービス名（例：「Claude」「ChatGPT」）

既存のカテゴリ：${categories.length ? categories.join("、") : "なし"}
既存のカード（カテゴリ：タイトル）：
${existing.length ? existingTitles(existing) : "なし"}
既存のカードと同じ概念は、タイトルの言い回しが違っても作らないでください。

出力は次の形の JSON 配列を、1つのコードブロックだけで返してください。説明文は不要です。diagram の改行は \\n で表してください。

\`\`\`json
[{"title": "", "question": "", "answer": "", "explanation": "", "pitfalls": "", "diagram": "", "category": "", "related": [], "source": ""}]
\`\`\``;
}
