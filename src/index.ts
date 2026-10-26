import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { fsrs, Rating, type Grade } from "ts-fsrs";
import {
  countDue,
  createCards,
  getCard,
  getMeta,
  getSettings,
  getStats,
  listTitles,
  sanitizeSettings,
  setMeta,
  str,
  toFsrs,
  toJson,
  updateCard,
  type CardInput,
  type CardRow,
} from "./cards";
import { registerAuthorize } from "./authorize";
import { importPrompt } from "./guide";
import { handleMcp } from "./mcp";
import { sendPush, type PushEnv } from "./push";

type Env = PushEnv & {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TOKEN: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};

const COOKIE = "hikidashi_token";
const GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;
const scheduler = fsrs({ enable_fuzz: true });

const app = new Hono<{ Bindings: Env }>();

// ---- 認証 ----

async function tokenMatches(given: string | undefined, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

app.post("/api/login", async (c) => {
  const { token } = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
  if (!(await tokenMatches(token, c.env.APP_TOKEN))) return c.json({ error: "invalid_token" }, 401);
  setCookie(c, COOKIE, c.env.APP_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 400 * 24 * 3600,
  });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (await tokenMatches(bearer ?? getCookie(c, COOKIE), c.env.APP_TOKEN)) return next();
  return c.json({ error: "unauthorized" }, 401);
});

registerAuthorize(app, (c) => tokenMatches(getCookie(c, COOKIE), c.env.APP_TOKEN));

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// ---- 設定・メタ情報 ----


app.get("/api/settings", async (c) => c.json(await getSettings(c.env.DB)));

app.put("/api/settings", async (c) => {
  const current = await getSettings(c.env.DB);
  const next = sanitizeSettings(await c.req.json(), current);
  await setMeta(c.env.DB, "settings", next);
  return c.json(next);
});

// ---- カード ----


app.get("/api/stats", async (c) => c.json(await getStats(c.env.DB)));

app.get("/api/titles", async (c) => c.json(await listTitles(c.env.DB)));

app.get("/api/import-prompt", async (c) => c.text(importPrompt(await listTitles(c.env.DB))));

app.get("/api/cards", async (c) => {
  const q = c.req.query("q")?.trim();
  const category = c.req.query("category");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(title LIKE ? OR answer LIKE ? OR explanation LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category) {
    where.push("category = ?");
    binds.push(category);
  }
  const sql = `SELECT id, title, category, due, state, reps, lapses FROM cards ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY updated_at DESC LIMIT 500`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json(results);
});

app.get("/api/cards/:id", async (c) => {
  const row = await getCard(c.env.DB, c.req.param("id"));
  return row ? c.json(toJson(row)) : c.json({ error: "not_found" }, 404);
});

app.post("/api/cards", async (c) => {
  const body = await c.req.json<CardInput | CardInput[]>();
  const result = await createCards(c.env.DB, Array.isArray(body) ? body : [body]);
  if (result.blocked) return c.json({ error: "blocked", due: result.due, blockLimit: result.blockLimit }, 423);
  const { created, conflicts, invalid } = result;
  return c.json({ created, conflicts, invalid }, created.length ? 201 : 200);
});

app.put("/api/cards/:id", async (c) => {
  const result = await updateCard(c.env.DB, c.req.param("id"), await c.req.json<CardInput>());
  if (!result.ok) return c.json({ error: result.error }, result.error === "not_found" ? 404 : 409);
  return c.json(toJson(result.card));
});

app.delete("/api/cards/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---- 復習 ----

app.get("/api/review", async (c) => {
  const now = Date.now();
  const settings = await getSettings(c.env.DB);
  const category = c.req.query("category");
  const sql = category
    ? "SELECT * FROM cards WHERE due <= ? AND category = ? ORDER BY due LIMIT ?"
    : "SELECT * FROM cards WHERE due <= ? ORDER BY due LIMIT ?";
  const stmt = category
    ? c.env.DB.prepare(sql).bind(now, category, settings.sessionSize)
    : c.env.DB.prepare(sql).bind(now, settings.sessionSize);
  const { results } = await stmt.all<CardRow>();
  return c.json(
    results.map((row) => ({
      ...toJson(row),
      preview: Object.fromEntries(
        GRADES.map((g) => [g, scheduler.next(toFsrs(row), new Date(now), g).card.due.getTime() - now]),
      ),
    })),
  );
});

app.post("/api/cards/:id/review", async (c) => {
  const id = c.req.param("id");
  const { rating, response } = await c.req.json<{ rating: number; response?: string }>();
  if (!GRADES.includes(rating as Grade)) return c.json({ error: "invalid_rating" }, 400);
  const row = await getCard(c.env.DB, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  const now = Date.now();
  const { card } = scheduler.next(toFsrs(row), new Date(now), rating as Grade);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?,
        reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?`,
    ).bind(
      card.due.getTime(),
      card.stability,
      card.difficulty,
      card.elapsed_days,
      card.scheduled_days,
      card.learning_steps,
      card.reps,
      card.lapses,
      card.state,
      now,
      id,
    ),
    c.env.DB.prepare("INSERT INTO reviews (card_id, rating, response, reviewed_at) VALUES (?, ?, ?, ?)").bind(
      id,
      rating,
      str(response),
      now,
    ),
  ]);
  return c.json({ due: card.due.getTime() });
});

// ---- エクスポート ----

app.get("/api/export.md", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM cards ORDER BY category, title").all<CardRow>();
  const lines: string[] = [];
  let category = "";
  for (const row of results) {
    if (row.category !== category) {
      category = row.category;
      lines.push(`# ${category}`, "");
    }
    lines.push(`## ${row.title}`, "");
    if (row.question) lines.push(`**問題**: ${row.question}`, "");
    lines.push(`**答え**: ${row.answer}`, "");
    if (row.explanation) lines.push(row.explanation, "");
    if (row.pitfalls) lines.push(`**つまずいた点**: ${row.pitfalls}`, "");
    if (row.diagram) lines.push("```mermaid", row.diagram, "```", "");
    const related = JSON.parse(row.related) as string[];
    if (related.length) lines.push(`**関連**: ${related.map((t) => `[[${t}]]`).join(" ")}`, "");
  }
  return c.body(lines.join("\n"), 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="hikidashi-${new Date().toISOString().slice(0, 10)}.md"`,
  });
});

// ---- プッシュ通知 ----

app.get("/api/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

app.post("/api/push/subscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>();
  if (!endpoint?.startsWith("https://")) return c.json({ error: "invalid_endpoint" }, 400);
  await c.env.DB.prepare("INSERT OR IGNORE INTO push_subscriptions (endpoint, created_at) VALUES (?, ?)")
    .bind(endpoint, Date.now())
    .run();
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>();
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint ?? "").run();
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => c.json({ sent: await pushAll(c.env) }));

async function pushAll(env: Env): Promise<number> {
  const { results } = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").all<{ endpoint: string }>();
  let sent = 0;
  for (const { endpoint } of results) {
    const status = await sendPush(endpoint, env).catch(() => 0);
    if (status === 404 || status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
    } else if (status >= 200 && status < 300) {
      sent++;
    }
  }
  return sent;
}

// ---- 定期実行 ----

type NotifyState = { lastSlot: string; lastPushAt: number; renotifyCount: number };

const CRON_MINUTES = 15;

function localClock(at: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export async function runNotify(env: Env, now: number): Promise<"slot" | "renotify" | null> {
  const settings = await getSettings(env.DB);
  if ((await countDue(env.DB, now)) === 0) return null;

  const state = (await getMeta<NotifyState>(env.DB, "notify")) ?? { lastSlot: "", lastPushAt: 0, renotifyCount: 0 };
  const clock = localClock(now, settings.timezone);
  const slot = settings.notifyTimes.find((t) => {
    const [h, m] = t.split(":").map(Number);
    const diff = (clock.minutes - (h * 60 + m) + 1440) % 1440;
    return diff < CRON_MINUTES;
  });
  const slotKey = slot ? `${clock.date} ${slot}` : "";

  if (slot && slotKey !== state.lastSlot) {
    await pushAll(env);
    await setMeta(env.DB, "notify", { lastSlot: slotKey, lastPushAt: now, renotifyCount: 0 });
    return "slot";
  }

  // 前回の通知以降に一度も回答していなければ、設定した間隔で再通知する
  if (!state.lastPushAt || state.renotifyCount >= settings.renotifyMax) return null;
  if (now - state.lastPushAt < settings.renotifyMinutes * 60_000) return null;
  const answered = await env.DB.prepare("SELECT 1 FROM reviews WHERE reviewed_at > ? LIMIT 1")
    .bind(state.lastPushAt)
    .first();
  if (answered) return null;
  await pushAll(env);
  await setMeta(env.DB, "notify", { ...state, lastPushAt: now, renotifyCount: state.renotifyCount + 1 });
  return "renotify";
}

// /mcp はアクセストークンが必要。トークンの発行と、それ以外のリクエストの振り分けは OAuthProvider が行う。
// resource に APP_URL を使うため、最初のリクエストで env を見てから作る
let provider: OAuthProvider<Env> | undefined;

function oauthProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: (request, env) => handleMcp(request, env) },
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["cards"],
    requiredScopes: ["cards"],
    resourceMetadata: { resource: `${env.APP_URL}/mcp`, authorization_servers: [env.APP_URL] },
    // 使い続けている限り接続が切れないよう、最後に使ってから90日で失効させる
    refreshTokenTTL: 90 * 24 * 3600,
    refreshTokenIdleTTL: 90 * 24 * 3600,
    // Claude Code などからは APP_TOKEN をそのまま使える
    resolveExternalToken: async ({ token, env }) =>
      (await tokenMatches(token, env.APP_TOKEN)) ? { props: {}, audience: `${env.APP_URL}/mcp` } : null,
  });
  return provider;
}

export default {
  fetch: (request, env, ctx) => oauthProvider(env).fetch(request, env, ctx),
  async scheduled(controller: ScheduledController, env: Env) {
    await runNotify(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
