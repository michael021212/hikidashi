// Claude などのチャットから Hikidashi にカードを保存するための MCP サーバー。
// Streamable HTTP のステートレス構成で、JSON-RPC の要求に JSON で応答する。
import { createCards, getCard, getStats, listTitles, toJson, updateCard, type CardInput } from "./cards";
import { CARD_FIELDS_GUIDE, CARD_SELECTION_GUIDE } from "./guide";

type McpEnv = { DB: D1Database };

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };

const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Hikidashi はユーザーが学んだことを1概念1枚のカードにして、間隔反復で復習するアプリ。
ユーザーが「カードにして」「覚えておきたい」「Hikidashiに保存して」などと頼んだら、get_existing_cards で既存のカードを確認してから save_cards で保存する。
同じ概念のカードがすでにあれば新しく作らず、get_card で中身を見て update_card で追記する。
保存後は、作成・更新したカードのタイトルとカテゴリだけを短く伝える。`;

const cardProperties = {
  title: { type: "string", description: "用語や概念の名前" },
  question: { type: "string", description: "自分の言葉で説明させる問い" },
  answer: { type: "string", description: "1〜2文の核心" },
  explanation: { type: "string", description: "仕組み・理由・具体例" },
  pitfalls: { type: "string", description: "ユーザーが誤解していた点、追加で質問した点。なければ空文字" },
  category: { type: "string", description: "短い分野名" },
  related: { type: "array", items: { type: "string" }, description: "関係するカードのタイトル" },
  source: { type: "string", description: "どこで学んだか（例：Claude）" },
};

const TOOLS = [
  {
    name: "get_existing_cards",
    title: "既存のカードを確認",
    description:
      "保存済みカードのタイトルとカテゴリ、復習待ちの件数を返す。カードを保存する前に呼び、カテゴリの再利用、重複の確認、関連付けに使う。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_cards",
    title: "カードを保存",
    description: `会話で学んだ概念をカードとして保存する。\n\n${CARD_SELECTION_GUIDE}\n\n各項目：\n${CARD_FIELDS_GUIDE}\n\n同じタイトルのカードは作られず conflicts に返る。復習待ちがたまっていると blocked が返り、何も保存されない。その場合は迂回せず、先に復習するようユーザーに伝える。`,
    inputSchema: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: { type: "object", properties: cardProperties, required: ["title", "answer"] },
        },
      },
      required: ["cards"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_card",
    title: "カードの中身を見る",
    description: "タイトルを指定してカードの全項目を返す。既存カードに追記する前に使う。",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_card",
    title: "カードに追記",
    description:
      "既存カードの項目を書き換える。渡した項目だけが変わる。追記するときは get_card で取得した既存の文章を消さず、その後ろに新しく分かったことを足した全文を渡す。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "get_card で得た id" }, ...cardProperties },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

function toolResult(data: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], isError };
}

async function callTool(env: McpEnv, name: string, args: Record<string, any>) {
  switch (name) {
    case "get_existing_cards": {
      const [titles, stats] = await Promise.all([listTitles(env.DB), getStats(env.DB)]);
      return toolResult({
        cards: titles.map(({ title, category }) => ({ title, category })),
        due: stats.due,
        blocked: stats.blocked,
      });
    }
    case "save_cards": {
      const cards = Array.isArray(args.cards) ? (args.cards as CardInput[]) : [];
      const result = await createCards(env.DB, cards);
      return toolResult(result, result.blocked);
    }
    case "get_card": {
      const row = await env.DB.prepare("SELECT id FROM cards WHERE title = ?")
        .bind(String(args.title ?? ""))
        .first<{ id: string }>();
      const card = row && (await getCard(env.DB, row.id));
      if (!card) return toolResult({ error: "not_found" }, true);
      const { id, title, question, answer, explanation, pitfalls, category, related, source } = toJson(card);
      return toolResult({ id, title, question, answer, explanation, pitfalls, category, related, source });
    }
    case "update_card": {
      const { id, ...fields } = args;
      const result = await updateCard(env.DB, String(id ?? ""), fields);
      return result.ok ? toolResult({ ok: true, title: result.card.title }) : toolResult(result, true);
    }
    default:
      return null;
  }
}

async function handleMessage(env: McpEnv, msg: JsonRpcRequest) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hikidashi", title: "Hikidashi", version: "1.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const result = await callTool(env, msg.params?.name, msg.params?.arguments ?? {});
      return result ? reply(result) : fail(-32602, `Unknown tool: ${msg.params?.name}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: McpEnv): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    // id のないものは通知なので応答しない
    if (msg && typeof msg === "object" && msg.id === undefined) continue;
    responses.push(await handleMessage(env, msg));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
