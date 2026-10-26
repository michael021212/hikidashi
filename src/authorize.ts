// MCP コネクタを接続するときの OAuth 認可画面。
// Hikidashi にログイン済みのブラウザでだけ、接続を許可できる。
import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";

type AuthEnv = { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(body: string): string {
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hikidashi</title>
<link rel="icon" href="/icon-192.png">
<link rel="stylesheet" href="/style.css">
<main>${body}</main>
</html>`;
}

function html(body: string, init: { status?: number; headers?: Headers } = {}) {
  const headers = init.headers ?? new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(page(body), { status: init.status ?? 200, headers });
}

function loginPage(): string {
  return `<form class="login" id="login">
  <img src="/icon-192.png" alt="" width="72" height="72">
  <label>トークン<input type="password" name="token" autocomplete="current-password" required autofocus></label>
  <p class="error" hidden>トークンが違います</p>
  <button class="primary">ログイン</button>
</form>
<script type="module">
  const form = document.getElementById("login");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: form.token.value }),
    });
    if (res.ok) location.reload();
    else form.querySelector(".error").hidden = false;
  });
</script>`;
}

function errorPage(message: string) {
  return html(`<div class="login"><p class="error">${escape(message)}</p></div>`, { status: 400 });
}

function handleError(error: unknown) {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError) return errorPage(error.description ?? "接続を完了できませんでした");
  if (error instanceof CimdFetchError) return errorPage("接続しようとしているアプリを確認できませんでした");
  throw error;
}

export function registerAuthorize<E extends AuthEnv>(
  app: Hono<{ Bindings: E }>,
  isLoggedIn: (c: Context<{ Bindings: E }>) => Promise<boolean>,
) {
  app.get("/authorize", async (c) => {
    if (!(await isLoggedIn(c))) return html(loginPage());
    try {
      const oauth = c.env.OAUTH_PROVIDER;
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const name = escape(details.clientName);
      const body = `<form class="login consent" method="post">
  <img src="/icon-192.png" alt="" width="72" height="72">
  <h1>${name}</h1>
  <p>Hikidashi のカードの閲覧と保存を許可しますか？</p>
  <dl>
    ${details.clientDomain ? `<dt>発行元</dt><dd>${escape(details.clientDomain)}</dd>` : ""}
    <dt>接続先</dt><dd>${escape(details.redirectHost)}</dd>
  </dl>
  ${details.redirectIsLoopback ? `<p class="notice">このパソコン上のアプリに接続します。自分で接続を始めた場合だけ許可してください。</p>` : ""}
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <div class="actions">
    <button name="decision" value="deny">拒否</button>
    <button name="decision" value="approve" class="primary">許可</button>
  </div>
</form>`;
      return html(body, { headers: consent.headers });
    } catch (error) {
      return handleError(error);
    }
  });

  app.post("/authorize", async (c) => {
    if (!(await isLoggedIn(c))) return errorPage("ログインしてからもう一度接続してください");
    try {
      const oauth = c.env.OAUTH_PROVIDER;
      const form = await c.req.raw.clone().formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(c.req.raw, handle);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: {},
        scope: approved.request.scope,
        props: {},
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      return handleError(error);
    }
  });
}
