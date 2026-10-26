import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createEmptyCard, fsrs, Rating, type Card as FsrsCard, type Grade } from "ts-fsrs";
import { sendPush, type PushEnv } from "./push";

type Env = PushEnv & {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TOKEN: string;
};

type Settings = {
  timezone: string;
  notifyTimes: string[];
  renotifyMinutes: number;
  renotifyMax: number;
  sessionSize: number;
  blockEnabled: boolean;
  blockLimit: number;
};

const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Tokyo",
  notifyTimes: ["08:00", "12:30", "21:00"],
  renotifyMinutes: 60,
  renotifyMax: 2,
  sessionSize: 10,
  blockEnabled: true,
  blockLimit: 30,
};

type CardRow = {
  id: string;
  title: string;
  question: string;
  answer: string;
  explanation: string;
  pitfalls: string;
  category: string;
  related: string;
  source: string;
  created_at: number;
  updated_at: number;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: number | null;
};

type CardInput = {
  title?: unknown;
  question?: unknown;
  answer?: unknown;
  explanation?: unknown;
  pitfalls?: unknown;
  category?: unknown;
  related?: unknown;
  source?: unknown;
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

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// ---- 設定・メタ情報 ----

async function getMeta<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

async function setMeta(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

async function getSettings(db: D1Database): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getMeta<Partial<Settings>>(db, "settings")) };
}

function sanitizeSettings(input: Partial<Settings>, current: Settings): Settings {
  const int = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  const times = Array.isArray(input.notifyTimes)
    ? [...new Set(input.notifyTimes.filter((t): t is string => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort()
    : current.notifyTimes;
  let timezone = current.timezone;
  if (typeof input.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      timezone = input.timezone;
    } catch {}
  }
  return {
    timezone,
    notifyTimes: times,
    renotifyMinutes: int(input.renotifyMinutes, current.renotifyMinutes, 15, 24 * 60),
    renotifyMax: int(input.renotifyMax, current.renotifyMax, 0, 20),
    sessionSize: int(input.sessionSize, current.sessionSize, 1, 100),
    blockEnabled: typeof input.blockEnabled === "boolean" ? input.blockEnabled : current.blockEnabled,
    blockLimit: int(input.blockLimit, current.blockLimit, 1, 1000),
  };
}

app.get("/api/settings", async (c) => c.json(await getSettings(c.env.DB)));

app.put("/api/settings", async (c) => {
  const current = await getSettings(c.env.DB);
  const next = sanitizeSettings(await c.req.json(), current);
  await setMeta(c.env.DB, "settings", next);
  return c.json(next);
});

// ---- カード ----

function str(v: unknown, max = 20000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function relatedList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、]/) : [];
  return [...new Set(items.map((x) => str(x, 200)).filter(Boolean))];
}

function toFsrs(row: CardRow): FsrsCard {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

function toJson(row: CardRow) {
  return { ...row, related: JSON.parse(row.related) as string[] };
}

async function countDue(db: D1Database, now: number, category?: string): Promise<number> {
  const sql = category
    ? "SELECT COUNT(*) AS n FROM cards WHERE due <= ? AND category = ?"
    : "SELECT COUNT(*) AS n FROM cards WHERE due <= ?";
  const stmt = category ? db.prepare(sql).bind(now, category) : db.prepare(sql).bind(now);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
}

app.get("/api/stats", async (c) => {
  const now = Date.now();
  const settings = await getSettings(c.env.DB);
  const { results } = await c.env.DB.prepare(
    "SELECT category AS name, COUNT(*) AS total, SUM(due <= ?) AS due FROM cards GROUP BY category ORDER BY category",
  )
    .bind(now)
    .all<{ name: string; total: number; due: number }>();
  const due = results.reduce((s, r) => s + r.due, 0);
  const total = results.reduce((s, r) => s + r.total, 0);
  return c.json({
    due,
    total,
    categories: results,
    blocked: settings.blockEnabled && due >= settings.blockLimit,
    blockLimit: settings.blockLimit,
  });
});

app.get("/api/titles", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, title, category FROM cards ORDER BY title").all();
  return c.json(results);
});

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
  const row = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(c.req.param("id")).first<CardRow>();
  return row ? c.json(toJson(row)) : c.json({ error: "not_found" }, 404);
});

app.post("/api/cards", async (c) => {
  const body = await c.req.json<CardInput | CardInput[]>();
  const inputs = Array.isArray(body) ? body : [body];
  const now = Date.now();
  const settings = await getSettings(c.env.DB);
  const due = await countDue(c.env.DB, now);
  if (settings.blockEnabled && due >= settings.blockLimit) {
    return c.json({ error: "blocked", due, blockLimit: settings.blockLimit }, 423);
  }

  const created: { id: string; title: string }[] = [];
  const conflicts: { id: string; title: string }[] = [];
  const invalid: { index: number; error: string }[] = [];
  for (const [index, input] of inputs.entries()) {
    const title = str(input.title, 200);
    const answer = str(input.answer);
    if (!title || !answer) {
      invalid.push({ index, error: "title_and_answer_required" });
      continue;
    }
    const existing = await c.env.DB.prepare("SELECT id FROM cards WHERE title = ?").bind(title).first<{ id: string }>();
    if (existing) {
      conflicts.push({ id: existing.id, title });
      continue;
    }
    const id = crypto.randomUUID();
    const card = createEmptyCard(new Date(now));
    await c.env.DB.prepare(
      `INSERT INTO cards (id, title, question, answer, explanation, pitfalls, category, related, source,
        created_at, updated_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        title,
        str(input.question),
        answer,
        str(input.explanation),
        str(input.pitfalls),
        str(input.category, 100) || "未分類",
        JSON.stringify(relatedList(input.related)),
        str(input.source, 500),
        now,
        now,
        card.due.getTime(),
        card.stability,
        card.difficulty,
        card.elapsed_days,
        card.scheduled_days,
        card.learning_steps,
        card.reps,
        card.lapses,
        card.state,
      )
      .run();
    created.push({ id, title });
  }
  return c.json({ created, conflicts, invalid }, created.length ? 201 : 200);
});

app.put("/api/cards/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first<CardRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const input = await c.req.json<CardInput>();
  const pick = (key: keyof CardInput, max?: number) => (input[key] === undefined ? undefined : str(input[key], max));
  const title = pick("title", 200) || row.title;
  const answer = pick("answer") || row.answer;
  if (title !== row.title) {
    const dup = await c.env.DB.prepare("SELECT id FROM cards WHERE title = ? AND id != ?").bind(title, id).first();
    if (dup) return c.json({ error: "title_exists" }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE cards SET title = ?, question = ?, answer = ?, explanation = ?, pitfalls = ?, category = ?, related = ?,
      source = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      title,
      pick("question") ?? row.question,
      answer,
      pick("explanation") ?? row.explanation,
      pick("pitfalls") ?? row.pitfalls,
      pick("category", 100) || row.category,
      input.related === undefined ? row.related : JSON.stringify(relatedList(input.related)),
      pick("source", 500) ?? row.source,
      Date.now(),
      id,
    )
    .run();
  const updated = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first<CardRow>();
  return c.json(toJson(updated!));
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
  const row = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first<CardRow>();
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

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    await runNotify(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
