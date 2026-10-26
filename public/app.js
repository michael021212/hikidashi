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

function showCard(stage) {
  const card = review.queue[review.index];
  if (!card) return showFinished(stage);

  const response = h("textarea", { rows: 4, placeholder: "回答" });
  const reveal = () => showAnswer(stage, card, response.value);
  swap(
    stage,
    h("div", { class: "progress" }, `${review.index + 1} / ${review.queue.length}`),
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
    h("div", { class: "progress" }, `${review.index + 1} / ${review.queue.length}`),
    h(
      "article",
      { class: "card" },
      h("div", { class: "category" }, card.category),
      h("h2", { class: "question" }, card.question || card.title),
      response && h("blockquote", { class: "response" }, response),
      h("hr"),
      card.question && h("h3", { class: "title" }, card.title),
      h("p", { class: "answer" }, card.answer),
      card.explanation && h("p", { class: "explanation" }, card.explanation),
      card.pitfalls && h("div", { class: "pitfalls" }, h("h4", {}, "つまずいた点"), h("p", {}, card.pitfalls)),
      card.related.length > 0 &&
        h("div", { class: "related" }, card.related.map((t) => h("span", { class: "tag" }, t))),
    ),
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

async function cardsView() {
  const stats = await api("/api/stats");
  const search = h("input", { type: "search", placeholder: "検索" });
  const category = h(
    "select",
    {},
    h("option", { value: "" }, "すべてのカテゴリ"),
    stats.categories.map((c) => h("option", { value: c.name }, `${c.name}（${c.total}）`)),
  );
  const list = h("ul", { class: "card-list" });
  const load = async () => {
    const params = new URLSearchParams();
    if (search.value) params.set("q", search.value);
    if (category.value) params.set("category", category.value);
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
            h("span", { class: "meta" }, c.category),
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
      h("a", { class: `button primary${stats.blocked ? " disabled" : ""}`, href: stats.blocked ? undefined : "#/cards/new" }, "追加"),
    ),
    stats.blocked && h("p", { class: "notice" }, `復習が${stats.due}問たまっているため追加できません`),
    list,
  );
  await load();
}

// ---- カード編集 ----

async function cardEditView(id) {
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
          location.hash = "#/cards";
        } catch (err) {
          error.textContent =
            err.status === 423 ? `復習が${err.data.due}問たまっているため追加できません` : "保存できませんでした";
          error.hidden = false;
        }
      },
    },
    field("title", "タイトル", h("input", { required: true, maxLength: 200 })),
    field("question", "問題", h("textarea", { rows: 2 })),
    field("answer", "答え", h("textarea", { rows: 3, required: true })),
    field("explanation", "説明", h("textarea", { rows: 6 })),
    field("pitfalls", "つまずいた点", h("textarea", { rows: 3 })),
    field("category", "カテゴリ", h("input", { list: "categories" })),
    field("related", "関連", h("input", { list: "titles" })),
    h("datalist", { id: "categories" }, stats.categories.map((c) => h("option", { value: c.name }))),
    h("datalist", { id: "titles" }, titles.filter((t) => t.id !== id).map((t) => h("option", { value: t.title }))),
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
              location.hash = "#/cards";
            },
          },
          "削除",
        ),
      h("a", { class: "button", href: "#/cards" }, "キャンセル"),
      h("button", { class: "primary" }, "保存"),
    ),
  );
  render(form);
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
      unit,
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
              class: "icon",
              "aria-label": "削除",
              onclick: async () => {
                await save({ notifyTimes: settings.notifyTimes.filter((_, j) => j !== i) });
                drawTimes();
              },
            },
            "×",
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
        "+",
      ),
    );
  drawTimes();

  const block = h("input", {
    type: "checkbox",
    checked: settings.blockEnabled,
    onchange: (e) => save({ blockEnabled: e.target.checked }),
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
      h("div", { class: "row" }, h("label", { class: "check" }, block, "カードの追加を止める"), number("blockLimit", 1, 1000, "問以上")),
      h("h2", {}, "データ"),
      h(
        "div",
        { class: "row" },
        h("a", { class: "button", href: "/api/export.md" }, "Markdownで書き出す"),
        h(
          "button",
          {
            onclick: async () => {
              await api("/api/logout", { method: "POST" });
              route();
            },
          },
          "ログアウト",
        ),
      ),
    ),
  );
}

async function pushControl() {
  const box = h("span", { class: "push" });
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    box.append("非対応");
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
        : h(
            "button",
            {
              class: "primary",
              disabled: Notification.permission === "denied",
              onclick: async () => {
                if ((await Notification.requestPermission()) !== "granted") return draw();
                const { key } = await api("/api/push/key");
                const created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
                await api("/api/push/subscribe", { method: "POST", body: { endpoint: created.endpoint } });
                draw();
              },
            },
            Notification.permission === "denied" ? "ブロック中" : "オンにする",
          ),
    );
  };
  await draw();
  return box;
}

// ---- ルーティング ----

async function route() {
  onKey(null);
  const [, page = "review", arg] = location.hash.split("/");
  tabs.hidden = false;
  for (const a of tabs.querySelectorAll("a")) a.classList.toggle("active", a.dataset.tab === page);
  try {
    if (page === "cards" && arg) await cardEditView(arg === "new" ? null : arg);
    else if (page === "cards") await cardsView();
    else if (page === "settings") await settingsView();
    else await reviewView();
  } catch (err) {
    if (err instanceof Unauthorized) return loginView();
    render(h("p", { class: "error" }, "読み込めませんでした"), h("button", { onclick: route }, "再読み込み"));
    console.error(err);
  }
}

window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
route();
