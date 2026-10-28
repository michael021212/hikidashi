const view = document.getElementById("view");
const tabs = document.getElementById("tabs");

// ---- 共通 ----

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

class Unauthorized extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, data });
  return data;
}

function duration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}分`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}日`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}か月`;
  return `${(days / 365).toFixed(1)}年`;
}

function present(nodes) {
  return nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
}

function render(...nodes) {
  view.replaceChildren(...present(nodes));
}

// 入力値を壊さないよう、要素の位置を変えずに中身だけ差し替える
function swap(target, ...nodes) {
  target.replaceChildren(...present(nodes));
}

// ---- ログイン ----

function loginView() {
  tabs.hidden = true;
  const input = h("input", { type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "error", hidden: true }, "トークンが違います");
  render(
    h(
      "form",
      {
        class: "login",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("/api/login", { method: "POST", body: { token: input.value } });
            route();
          } catch {
            error.hidden = false;
          }
        },
      },
      h("img", { src: "/icon-192.png", alt: "", width: 72, height: 72 }),
      h("label", {}, "トークン", input),
      error,
      h("button", { class: "primary" }, "ログイン"),
    ),
  );
  input.focus();
}

// ---- 復習 ----

const review = {
  category: sessionStorage.getItem("category") ?? "",
  queue: [],
  index: 0,
  done: 0,
};

const GRADES = [
  { rating: 1, label: "もう一度", key: "1" },
  { rating: 2, label: "難しい", key: "2" },
  { rating: 3, label: "できた", key: "3" },
  { rating: 4, label: "簡単", key: "4" },
];

let keyHandler = null;
function onKey(handler) {
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = handler;
  if (handler) document.addEventListener("keydown", handler);
}

async function reviewView() {
  const [stats, queue] = await Promise.all([
    api("/api/stats"),
    api(`/api/review${review.category ? `?category=${encodeURIComponent(review.category)}` : ""}`),
  ]);
  review.queue = queue;
  review.index = 0;

  const chips = h("div", { class: "chips" });
  drawChips(chips, stats);
  const stage = h("section", { class: "stage" });
  render(chips, stage);
  showCard(stage);
}

function drawChips(chips, stats) {
  swap(
    chips,
    chip("すべて", "", stats.due),
    stats.categories.filter((c) => c.due > 0 || c.name === review.category).map((c) => chip(c.name, c.name, c.due)),
  );
}

function chip(label, value, count) {
  return h(
    "button",
    {
      class: `chip${review.category === value ? " active" : ""}`,
      onclick: () => {
        review.category = value;
        sessionStorage.setItem("category", value);
        review.done = 0;
        reviewView();
      },
    },
    label,
    h("span", { class: "count" }, count),
  );
}

// Mermaid は大きいので、図のあるカードを開いたときに初めて読み込む
let mermaidReady = null;
let diagramCount = 0;

function loadMermaid() {
  mermaidReady ??= import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // 画面幅に縮めると文字が読めないので、元の大きさで描いて横にスクロールさせる
      // 間隔と文字を小さめにして、スマホの幅に近づける
      sequence: {
        useMaxWidth: false,
        width: 80,
        actorMargin: 24,
        boxMargin: 6,
        noteMargin: 6,
        messageMargin: 28,
        actorFontSize: 13,
        messageFontSize: 13,
        noteFontSize: 12,
      },
      flowchart: { useMaxWidth: false, nodeSpacing: 24, rankSpacing: 32 },
      themeVariables: { fontSize: "13px" },
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    return mermaid;
  });
  return mermaidReady;
}

// 描画に失敗した図は表示しない。説明文があれば内容は伝わる
function diagram(code) {
  const box = h("div", { class: "diagram" });
  const id = `diagram-${++diagramCount}`;
  loadMermaid()
    .then((mermaid) => mermaid.render(id, code))
    .then(({ svg }) => {
      box.innerHTML = svg;
    })
    .catch(() => {
      box.remove();
      // 失敗すると Mermaid が作業用の要素を body に残すので消す
      document.getElementById(`d${id}`)?.remove();
    });
  return box;
}

const ICONS = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
};

function icon(name) {
  const span = h("span", { class: "svg" });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function reviewHeader(stage, card) {
  return h(
    "div",
    { class: "review-header" },
    h("span", { class: "progress" }, `${review.index + 1} / ${review.queue.length}`),
    h("a", { class: "button icon", href: `#/cards/${card.id}/review`, "aria-label": "編集" }, icon("edit")),
    h(
      "button",
      {
        class: "icon danger",
        "aria-label": "削除",
        onclick: async () => {
          if (!confirm(`「${card.title}」を削除しますか？`)) return;
          await api(`/api/cards/${card.id}`, { method: "DELETE" });
          review.queue.splice(review.index, 1);
          showCard(stage);
          drawChips(stage.previousElementSibling, await api("/api/stats"));
        },
      },
      icon("trash"),
    ),
  );
}

function askPrompt(card) {
  const lines = [`Hikidashi の復習カード「${card.title}」について、まだわからないところがあります。`, ""];
  if (card.question) lines.push(`問題：${card.question}`);
  lines.push(`答え：${card.answer}`);
  if (card.explanation) lines.push(`説明：\n${card.explanation}`);
  if (card.pitfalls) lines.push(`つまずいた点：${card.pitfalls}`);
  if (card.diagram) lines.push(`図（Mermaid）：\n${card.diagram}`);
  lines.push("", "わかったら、このカードに追記するか私に確認してください。", "", "わからないところ：");
  return lines.join("\n");
}

// 質問文をコピーしてから Claude を開く。URL で文章を渡せない環境でも、貼り付ければ続けられる
function askButton(card) {
  return h(
    "button",
    {
      onclick: () => {
        const prompt = askPrompt(card);
        const copied = copyText(prompt);
        // model は公式に案内されていない指定なので、効かなければ Claude 側の選択のまま開く
        const query = encodeURIComponent(prompt);
        const url = `https://claude.ai/new?model=claude-sonnet-5-5${query.length < 6000 ? `&q=${query}` : ""}`;
        window.open(url, "_blank");
        return copied;
      },
    },
    "質問する",
  );
}

function flagButton(card) {
  const button = h("button", {
    class: card.flagged_at ? "active" : "",
    "aria-pressed": String(Boolean(card.flagged_at)),
    onclick: async () => {
      const flagged = !card.flagged_at;
      await api(`/api/cards/${card.id}/flag`, { method: "PUT", body: { flagged } });
      card.flagged_at = flagged ? Date.now() : null;
      button.classList.toggle("active", flagged);
      button.setAttribute("aria-pressed", String(flagged));
    },
  }, "あとで調べる");
  return button;
}

function showCard(stage) {
  const card = review.queue[review.index];
  if (!card) return showFinished(stage);

  const response = h("textarea", { rows: 4, placeholder: "回答" });
  const reveal = () => showAnswer(stage, card, response.value);
  swap(
    stage,
    reviewHeader(stage, card),
    h(
      "article",
      { class: "card" },
      h("div", { class: "category" }, card.category),
      h("h2", { class: "question" }, card.question || card.title),
    ),
    response,
    h("button", { class: "primary wide", onclick: reveal }, "答えを見る"),
  );
  onKey((e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) reveal();
  });
  if (matchMedia("(pointer: fine)").matches) response.focus();
}

// 答えを開いたときのカード。編集画面のプレビューでも使う
function answerCard(card, response) {
  return h(
    "article",
    { class: "card" },
    h("div", { class: "category" }, card.category),
    h("h2", { class: "question" }, card.question || card.title),
    response && h("blockquote", { class: "response" }, response),
    h("hr"),
    card.question && h("h3", { class: "title" }, card.title),
    h("p", { class: "answer" }, card.answer),
    card.explanation && h("p", { class: "explanation" }, card.explanation),
    card.diagram && diagram(card.diagram),
    card.pitfalls && h("div", { class: "pitfalls" }, h("h4", {}, "つまずいた点"), h("p", {}, card.pitfalls)),
    card.related.length > 0 &&
      h("div", { class: "related" }, card.related.map((t) => h("span", { class: "tag" }, t))),
  );
}

function showAnswer(stage, card, response) {
  const grade = async (rating) => {
    onKey(null);
    stage.classList.add("busy");
    await api(`/api/cards/${card.id}/review`, { method: "POST", body: { rating, response } });
    stage.classList.remove("busy");
    review.index++;
    review.done++;
    showCard(stage);
  };

  swap(
    stage,
    reviewHeader(stage, card),
    answerCard(card, response),
    h("div", { class: "card-actions" }, askButton(card), flagButton(card)),
    h(
      "div",
      { class: "grades" },
      GRADES.map((g) =>
        h(
          "button",
          { class: `grade grade-${g.rating}`, onclick: () => grade(g.rating) },
          h("span", {}, g.label),
          h("small", {}, duration(card.preview[g.rating])),
        ),
      ),
    ),
  );
  stage.scrollIntoView({ block: "start" });
  onKey((e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const g = GRADES.find((x) => x.key === e.key);
    if (g) grade(g.rating);
  });
}

async function showFinished(stage) {
  onKey(null);
  const stats = await api("/api/stats");
  drawChips(stage.previousElementSibling, stats);
  const remaining = review.category
    ? (stats.categories.find((c) => c.name === review.category)?.due ?? 0)
    : stats.due;
  swap(
    stage,
    h(
      "div",
      { class: "finished" },
      h("p", { class: "big" }, review.done > 0 ? `${review.done}問 完了` : "復習待ちはありません"),
      remaining > 0 && h("button", { class: "primary", onclick: () => reviewView() }, `続ける（${remaining}問）`),
    ),
  );
}

// ---- カード一覧 ----

const FLAGGED = "__flagged";

async function cardsView() {
  const stats = await api("/api/stats");
  const search = h("input", { type: "search", placeholder: "検索" });
  const category = h(
    "select",
    {},
    h("option", { value: "" }, "すべてのカテゴリ"),
    stats.flagged > 0 && h("option", { value: FLAGGED }, `あとで調べる（${stats.flagged}）`),
    stats.categories.map((c) => h("option", { value: c.name }, `${c.name}（${c.total}）`)),
  );
  const list = h("ul", { class: "card-list" });
  const load = async () => {
    const params = new URLSearchParams();
    if (search.value) params.set("q", search.value);
    if (category.value === FLAGGED) params.set("flagged", "1");
    else if (category.value) params.set("category", category.value);
    const cards = await api(`/api/cards?${params}`);
    const now = Date.now();
    swap(
      list,
      cards.map((c) =>
        h(
          "li",
          {},
          h(
            "a",
            { href: `#/cards/${c.id}` },
            h("span", { class: "title" }, c.title),
            h("span", { class: "meta" }, c.flagged_at ? `${c.category} · あとで調べる` : c.category),
            h("span", { class: `meta due${c.due <= now ? " now" : ""}` }, c.due <= now ? "復習待ち" : `${duration(c.due - now)}後`),
          ),
        ),
      ),
    );
  };
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  category.addEventListener("change", load);

  render(
    h(
      "div",
      { class: "toolbar" },
      search,
      category,
      h("a", { class: `button${stats.blocked ? " disabled" : ""}`, href: stats.blocked ? undefined : "#/import" }, "取り込む"),
      h("a", { class: `button primary${stats.blocked ? " disabled" : ""}`, href: stats.blocked ? undefined : "#/cards/new" }, "追加"),
    ),
    stats.blocked && h("p", { class: "notice" }, `復習が${stats.due}問たまっているため追加できません`),
    list,
  );
  await load();
}

// ---- カード編集 ----

async function cardEditView(id, back = "#/cards") {
  const [card, stats, titles] = await Promise.all([
    id ? api(`/api/cards/${id}`) : Promise.resolve(null),
    api("/api/stats"),
    api("/api/titles"),
  ]);
  const field = (name, label, el) => {
    el.name = name;
    if (card && card[name] !== undefined) el.value = Array.isArray(card[name]) ? card[name].join(", ") : card[name];
    return h("label", {}, label, el);
  };
  const error = h("p", { class: "error", hidden: true });
  const fields = h(
    "div",
    { class: "fields" },
    field("title", "タイトル", h("input", { required: true, maxLength: 200 })),
    field("question", "問題", h("textarea", { rows: 2 })),
    field("answer", "答え", h("textarea", { rows: 3, required: true })),
    field("explanation", "説明", h("textarea", { rows: 6 })),
    field("pitfalls", "つまずいた点", h("textarea", { rows: 3 })),
    field("diagram", "図", h("textarea", { rows: 4, class: "code" })),
    field("category", "カテゴリ", h("input", { list: "categories" })),
    field("related", "関連", h("input", { list: "titles" })),
    h("datalist", { id: "categories" }, stats.categories.map((c) => h("option", { value: c.name }))),
    h("datalist", { id: "titles" }, titles.filter((t) => t.id !== id).map((t) => h("option", { value: t.title }))),
  );
  const preview = h("div", { hidden: true });

  // 入力中の内容を、復習で答えを開いたときの見た目で表示する
  const modes = h("div", { class: "chips" });
  const setMode = (previewing) => {
    fields.hidden = previewing;
    preview.hidden = !previewing;
    if (previewing) {
      const data = Object.fromEntries(new FormData(form));
      const related = data.related.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
      swap(preview, answerCard({ ...data, related }));
    }
    swap(
      modes,
      [false, true].map((p) =>
        h(
          "button",
          { type: "button", class: `chip${p === previewing ? " active" : ""}`, onclick: () => setMode(p) },
          p ? "プレビュー" : "編集",
        ),
      ),
    );
  };

  const form = h(
    "form",
    {
      class: "editor",
      onsubmit: async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        try {
          if (id) {
            await api(`/api/cards/${id}`, { method: "PUT", body: data });
          } else {
            const res = await api("/api/cards", { method: "POST", body: data });
            if (res.conflicts.length) {
              error.textContent = "同じタイトルのカードがあります";
              error.hidden = false;
              return;
            }
          }
          location.hash = back;
        } catch (err) {
          error.textContent =
            err.status === 423 ? `復習が${err.data.due}問たまっているため追加できません` : "保存できませんでした";
          error.hidden = false;
        }
      },
    },
    fields,
    preview,
    error,
    h(
      "div",
      { class: "actions" },
      id &&
        h(
          "button",
          {
            type: "button",
            class: "danger",
            onclick: async () => {
              if (!confirm(`「${card.title}」を削除しますか？`)) return;
              await api(`/api/cards/${id}`, { method: "DELETE" });
              location.hash = back;
            },
          },
          "削除",
        ),
      h("a", { class: "button", href: back }, "キャンセル"),
      h("button", { class: "primary" }, "保存"),
    ),
  );
  // プレビュー中に保存して入力漏れがあったら、編集に戻して該当欄を見せる
  form.addEventListener(
    "invalid",
    () => {
      if (!fields.hidden) return;
      setMode(false);
      setTimeout(() => form.reportValidity());
    },
    true,
  );
  setMode(false);
  render(modes, form);
}

// ---- 取り込み ----

// AI の返答から JSON を取り出す。コードブロック、前後の文章、{ cards: [...] } の形にも対応する
function parseCards(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : text;
  const start = source.search(/[[{]/);
  const end = Math.max(source.lastIndexOf("]"), source.lastIndexOf("}"));
  if (start < 0 || end < start) return null;
  try {
    const data = JSON.parse(source.slice(start, end + 1));
    const list = Array.isArray(data) ? data : Array.isArray(data.cards) ? data.cards : [data];
    return list.filter((c) => c && typeof c === "object");
  } catch {
    return null;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API が使えない環境向けの代替
    const area = h("textarea", { value: text, readOnly: true, style: "position:fixed;opacity:0" });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// 記号や空白、全角半角、大文字小文字の違いを無視して比べる
function normalizeTitle(title) {
  return title.normalize("NFKC").toLowerCase().replace(/[\s・\-_.,、。()（）［］[\]「」『』]/g, "");
}

// 一方のタイトルがもう一方に含まれる既存カードを返す。「OCSP」と「OCSPレスポンダ」など
function similarTitle(title, titles) {
  const a = normalizeTitle(title);
  if (a.length < 2) return null;
  const hit = titles.find(({ title: other }) => {
    const b = normalizeTitle(other);
    return b.length >= 2 && (a === b || a.includes(b) || b.includes(a));
  });
  return hit ? hit.title : null;
}

async function importView() {
  const [stats, titles] = await Promise.all([api("/api/stats"), api("/api/titles")]);
  const existing = new Set(titles.map((t) => t.title));

  const input = h("textarea", { rows: 6, placeholder: "JSON" });
  input.value = sessionStorage.getItem("importText") ?? "";
  sessionStorage.removeItem("importText");
  const preview = h("ul", { class: "card-list import-list" });
  const save = h("button", { class: "primary wide", disabled: true }, "保存");
  const error = h("p", { class: "error", hidden: true });
  let cards = [];

  // 似たカードは保存しない状態で表示し、保存するかどうかを自分で選ぶ
  const update = () => {
    const parsed = input.value.trim() ? parseCards(input.value) : [];
    error.hidden = parsed !== null;
    error.textContent = "読み取れませんでした";
    const items = (parsed ?? []).map((card) => {
      const title = String(card.title ?? "").trim();
      const status = !title || !card.answer ? "不完全" : existing.has(title) ? "既存" : null;
      const similar = status ? null : similarTitle(title, titles);
      return { card, status, similar, checked: !status && !similar };
    });
    const refresh = () => {
      cards = items.filter((item) => item.checked).map((item) => item.card);
      save.disabled = cards.length === 0 || stats.blocked;
      save.textContent = cards.length ? `${cards.length}枚を保存` : "保存";
    };
    swap(
      preview,
      items.map((item) => {
        const { card, status, similar } = item;
        return h(
          "li",
          { class: status ? "skipped" : "" },
          h(
            "label",
            { class: "import-item" },
            !status &&
              h("input", {
                type: "checkbox",
                checked: item.checked,
                onchange: (e) => {
                  item.checked = e.target.checked;
                  refresh();
                },
              }),
            h(
              "div",
              {},
              h("span", { class: "title" }, card.title || "（タイトルなし）"),
              h("span", { class: "meta" }, similar ? `似ている：${similar}` : card.category || "未分類"),
            ),
          ),
          status && h("span", { class: "meta due" }, status),
        );
      }),
    );
    refresh();
  };
  input.addEventListener("input", update);

  // クリックの直後にコピーしないとブラウザに拒否されることがあるので、先に取得しておく
  const prompt = await fetch("/api/import-prompt").then((r) => r.text());
  const copyPrompt = h(
    "button",
    {
      onclick: async () => {
        copyPrompt.textContent = (await copyText(prompt)) ? "コピーしました" : "コピーできませんでした";
        setTimeout(() => (copyPrompt.textContent = "プロンプトをコピー"), 2000);
      },
    },
    "プロンプトをコピー",
  );
  const paste = h(
    "button",
    {
      onclick: async () => {
        try {
          input.value = await navigator.clipboard.readText();
          update();
        } catch {
          input.focus();
        }
      },
    },
    "貼り付け",
  );

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const res = await api("/api/cards", { method: "POST", body: cards });
      render(
        h(
          "div",
          { class: "finished" },
          h("p", { class: "big" }, `${res.created.length}枚 保存`),
          h("a", { class: "button primary", href: "#/review" }, "復習する"),
        ),
      );
    } catch (err) {
      error.textContent =
        err.status === 423 ? `復習が${err.data.due}問たまっているため追加できません` : "保存できませんでした";
      error.hidden = false;
      save.disabled = false;
    }
  });

  render(
    h(
      "section",
      { class: "import" },
      stats.blocked && h("p", { class: "notice" }, `復習が${stats.due}問たまっているため追加できません`),
      h("div", { class: "import-actions" }, copyPrompt, paste),
      input,
      error,
      preview,
      save,
    ),
  );
  update();
}

// ---- 設定 ----

async function settingsView() {
  const settings = await api("/api/settings");
  const save = async (patch) => Object.assign(settings, await api("/api/settings", { method: "PUT", body: { ...settings, ...patch } }));

  const number = (key, min, max, unit) =>
    h(
      "span",
      { class: "number" },
      h("input", {
        type: "number",
        min,
        max,
        value: settings[key],
        onchange: async (e) => {
          const saved = await save({ [key]: Number(e.target.value) });
          e.target.value = saved[key];
        },
      }),
      h("span", { class: "unit" }, unit),
    );

  const times = h("div", { class: "times" });
  const drawTimes = () =>
    swap(
      times,
      settings.notifyTimes.map((t, i) =>
        h(
          "span",
          { class: "time" },
          h("input", {
            type: "time",
            value: t,
            onchange: async (e) => {
              const next = [...settings.notifyTimes];
              next[i] = e.target.value;
              await save({ notifyTimes: next });
              drawTimes();
            },
          }),
          h(
            "button",
            {
              class: "icon ghost",
              "aria-label": "削除",
              onclick: async () => {
                await save({ notifyTimes: settings.notifyTimes.filter((_, j) => j !== i) });
                drawTimes();
              },
            },
            icon("close"),
          ),
        ),
      ),
      h(
        "button",
        {
          class: "icon",
          "aria-label": "追加",
          onclick: async () => {
            await save({ notifyTimes: [...settings.notifyTimes, "12:00"] });
            drawTimes();
          },
        },
        icon("plus"),
      ),
    );
  drawTimes();

  const blockLimit = number("blockLimit", 1, 1000, "問以上");
  blockLimit.classList.toggle("off", !settings.blockEnabled);
  const block = h("input", {
    type: "checkbox",
    checked: settings.blockEnabled,
    onchange: (e) => {
      blockLimit.classList.toggle("off", !e.target.checked);
      save({ blockEnabled: e.target.checked });
    },
  });

  render(
    h(
      "section",
      { class: "settings" },
      h("h2", {}, "通知"),
      h("div", { class: "row" }, h("span", {}, "この端末"), await pushControl()),
      h("div", { class: "row top" }, h("span", {}, "時刻"), times),
      h("div", { class: "row" }, h("span", {}, "未回答時の再通知間隔"), number("renotifyMinutes", 15, 1440, "分")),
      h("div", { class: "row" }, h("span", {}, "再通知の回数"), number("renotifyMax", 0, 20, "回")),
      h("h2", {}, "復習"),
      h("div", { class: "row" }, h("span", {}, "1回の問題数"), number("sessionSize", 1, 100, "問")),
      h("div", { class: "row" }, h("label", { class: "check" }, block, "カードの追加を止める"), blockLimit),
      h("h2", {}, "データ"),
      h("div", { class: "row" }, h("a", { class: "button", href: "/api/export.md" }, "Markdownで書き出す")),
      h(
        "button",
        {
          class: "logout",
          onclick: async () => {
            await api("/api/logout", { method: "POST" });
            route();
          },
        },
        "ログアウト",
      ),
    ),
  );
}

async function pushControl() {
  const box = h("span", { class: "push" });
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    box.append(h("span", { class: "status" }, "非対応"));
    return box;
  }
  const reg = await navigator.serviceWorker.ready;
  const draw = async () => {
    const sub = await reg.pushManager.getSubscription();
    swap(
      box,
      sub
        ? [
            h("button", { onclick: () => api("/api/push/test", { method: "POST" }) }, "テスト"),
            h(
              "button",
              {
                onclick: async () => {
                  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
                  await sub.unsubscribe();
                  draw();
                },
              },
              "オフにする",
            ),
          ]
        : Notification.permission === "denied"
          ? h("span", { class: "status" }, "ブロック中")
          : h(
              "button",
              {
                class: "primary",
                onclick: async () => {
                  if ((await Notification.requestPermission()) !== "granted") return draw();
                  const { key } = await api("/api/push/key");
                  const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
                  await api("/api/push/subscribe", { method: "POST", body: { endpoint: created.endpoint } });
                  draw();
                },
              },
              "オンにする",
            ),
    );
  };
  await draw();
  return box;
}

// ---- ルーティング ----

async function route() {
  onKey(null);
  const [, page = "review", arg, from] = location.hash.split("/");
  tabs.hidden = false;
  const tab = from === "review" ? "review" : page === "import" ? "cards" : page;
  for (const a of tabs.querySelectorAll("a")) a.classList.toggle("active", a.dataset.tab === tab);
  try {
    if (page === "cards" && arg) await cardEditView(arg === "new" ? null : arg, from === "review" ? "#/review" : "#/cards");
    else if (page === "cards") await cardsView();
    else if (page === "import") await importView();
    else if (page === "settings") await settingsView();
    else await reviewView();
  } catch (err) {
    if (err instanceof Unauthorized) return loginView();
    render(h("p", { class: "error" }, "読み込めませんでした"), h("button", { onclick: route }, "再読み込み"));
    console.error(err);
  }
}

// Android の共有メニューから /import?text=... で開かれたら、本文を取り込み画面に渡す
if (location.pathname === "/import") {
  const params = new URLSearchParams(location.search);
  sessionStorage.setItem("importText", [params.get("text"), params.get("url")].filter(Boolean).join("\n"));
  history.replaceState(null, "", "/#/import");
}

window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
route();
