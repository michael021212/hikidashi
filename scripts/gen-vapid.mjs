// Web Push 用の VAPID 鍵ペアを生成し、.dev.vars / wrangler secret に入れる形式で出力する
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
