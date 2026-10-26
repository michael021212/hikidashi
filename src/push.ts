// ペイロードなしの Web Push を送る。通知の中身は Service Worker が /api/stats を取得して組み立てる。
// ペイロードを持たないので暗号化は不要で、VAPID の署名だけで済む。

export type PushEnv = {
  APP_URL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
};

const encoder = new TextEncoder();

function b64uEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function vapidJwt(audience: string, env: PushEnv): Promise<string> {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64uEncode(pub.slice(1, 33)),
      y: b64uEncode(pub.slice(33, 65)),
      d: env.VAPID_PRIVATE_KEY,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64uEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64uEncode(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.APP_URL.startsWith("https://") ? env.APP_URL : "mailto:hikidashi@example.com",
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64uEncode(signature)}`;
}

/** 送信結果の HTTP ステータスを返す。404/410 は購読が失効している。 */
export async function sendPush(endpoint: string, env: PushEnv): Promise<number> {
  const jwt = await vapidJwt(new URL(endpoint).origin, env);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: String(12 * 3600),
      Urgency: "high",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: "",
  });
  return res.status;
}
