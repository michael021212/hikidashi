// カードと設定の読み書き。REST API と MCP の両方から使う
import { createEmptyCard, type Card as FsrsCard } from "ts-fsrs";

export type Settings = {
  timezone: string;
  notifyTimes: string[];
  renotifyMinutes: number;
  renotifyMax: number;
  sessionSize: number;
  blockEnabled: boolean;
  blockLimit: number;
};

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Tokyo",
  notifyTimes: ["08:00", "12:30", "21:00"],
  renotifyMinutes: 60,
  renotifyMax: 2,
  sessionSize: 10,
  blockEnabled: true,
  blockLimit: 30,
};

export type CardRow = {
  id: string;
  title: string;
  question: string;
  answer: string;
  explanation: string;
  pitfalls: string;
  diagram: string;
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

export type CardInput = {
  title?: unknown;
  question?: unknown;
  answer?: unknown;
  explanation?: unknown;
  pitfalls?: unknown;
  diagram?: unknown;
  category?: unknown;
  related?: unknown;
  source?: unknown;
};

export async function getMeta<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function setMeta(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

export async function getSettings(db: D1Database): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getMeta<Partial<Settings>>(db, "settings")) };
}

export function sanitizeSettings(input: Partial<Settings>, current: Settings): Settings {
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

export function str(v: unknown, max = 20000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function relatedList(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、]/) : [];
  return [...new Set(items.map((x) => str(x, 200)).filter(Boolean))];
}

export function toFsrs(row: CardRow): FsrsCard {
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

export function toJson(row: CardRow) {
  return { ...row, related: JSON.parse(row.related) as string[] };
}

export async function countDue(db: D1Database, now: number, category?: string): Promise<number> {
  const sql = category
    ? "SELECT COUNT(*) AS n FROM cards WHERE due <= ? AND category = ?"
    : "SELECT COUNT(*) AS n FROM cards WHERE due <= ?";
  const stmt = category ? db.prepare(sql).bind(now, category) : db.prepare(sql).bind(now);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
}

export type CardRef = { id: string; title: string };

export type CreateResult =
  | { blocked: true; due: number; blockLimit: number }
  | { blocked: false; created: CardRef[]; conflicts: CardRef[]; invalid: { index: number; error: string }[] };

/** 復習がたまっていれば何も作らずに blocked を返す。同じタイトルのカードは作らず conflicts に入れる */
export async function createCards(db: D1Database, inputs: CardInput[]): Promise<CreateResult> {
  const now = Date.now();
  const settings = await getSettings(db);
  const due = await countDue(db, now);
  if (settings.blockEnabled && due >= settings.blockLimit) {
    return { blocked: true, due, blockLimit: settings.blockLimit };
  }

  const created: CardRef[] = [];
  const conflicts: CardRef[] = [];
  const invalid: { index: number; error: string }[] = [];
  for (const [index, input] of inputs.entries()) {
    const title = str(input.title, 200);
    const answer = str(input.answer);
    if (!title || !answer) {
      invalid.push({ index, error: "title_and_answer_required" });
      continue;
    }
    const existing = await db.prepare("SELECT id FROM cards WHERE title = ?").bind(title).first<{ id: string }>();
    if (existing) {
      conflicts.push({ id: existing.id, title });
      continue;
    }
    const id = crypto.randomUUID();
    const card = createEmptyCard(new Date(now));
    await db
      .prepare(
        `INSERT INTO cards (id, title, question, answer, explanation, pitfalls, diagram, category, related, source,
          created_at, updated_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        title,
        str(input.question),
        answer,
        str(input.explanation),
        str(input.pitfalls),
        str(input.diagram, 5000),
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
  return { blocked: false, created, conflicts, invalid };
}

export async function getCard(db: D1Database, id: string): Promise<CardRow | null> {
  return db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first<CardRow>();
}

/** 渡された項目だけを書き換える。タイトルが他のカードと重複する場合は title_exists */
export async function updateCard(
  db: D1Database,
  id: string,
  input: CardInput,
): Promise<{ ok: true; card: CardRow } | { ok: false; error: "not_found" | "title_exists" }> {
  const row = await getCard(db, id);
  if (!row) return { ok: false, error: "not_found" };
  const pick = (key: keyof CardInput, max?: number) => (input[key] === undefined ? undefined : str(input[key], max));
  const title = pick("title", 200) || row.title;
  const answer = pick("answer") || row.answer;
  if (title !== row.title) {
    const dup = await db.prepare("SELECT id FROM cards WHERE title = ? AND id != ?").bind(title, id).first();
    if (dup) return { ok: false, error: "title_exists" };
  }
  await db
    .prepare(
      `UPDATE cards SET title = ?, question = ?, answer = ?, explanation = ?, pitfalls = ?, diagram = ?, category = ?,
        related = ?, source = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      title,
      pick("question") ?? row.question,
      answer,
      pick("explanation") ?? row.explanation,
      pick("pitfalls") ?? row.pitfalls,
      pick("diagram", 5000) ?? row.diagram,
      pick("category", 100) || row.category,
      input.related === undefined ? row.related : JSON.stringify(relatedList(input.related)),
      pick("source", 500) ?? row.source,
      Date.now(),
      id,
    )
    .run();
  return { ok: true, card: (await getCard(db, id))! };
}

export async function getStats(db: D1Database) {
  const now = Date.now();
  const settings = await getSettings(db);
  const { results } = await db
    .prepare("SELECT category AS name, COUNT(*) AS total, SUM(due <= ?) AS due FROM cards GROUP BY category ORDER BY category")
    .bind(now)
    .all<{ name: string; total: number; due: number }>();
  const due = results.reduce((s, r) => s + r.due, 0);
  const total = results.reduce((s, r) => s + r.total, 0);
  return {
    due,
    total,
    categories: results,
    blocked: settings.blockEnabled && due >= settings.blockLimit,
    blockLimit: settings.blockLimit,
  };
}

export async function listTitles(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, title, category FROM cards ORDER BY title")
    .all<{ id: string; title: string; category: string }>();
  return results;
}
