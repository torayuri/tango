/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   おえかきレター 通知サーバー（Cloudflare Workers 用）

   絵を送った人のアプリから呼ばれ、受け取る人のスマホに
   Web Push 通知を送ります。

   使い方: Cloudflare の Worker にこのコードを丸ごと貼り付け、
   下の VAPID_PRIVATE_JWK に秘密鍵を入れてデプロイします。
   ※ 秘密鍵は公開リポジトリに入れないでください。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const VAPID_PRIVATE_JWK = null; // ← ここに秘密鍵（{"kty":"EC",...}）を貼る
const VAPID_SUBJECT = 'https://torayuri.github.io/tango/';
const FIREBASE_API_KEY = 'AIzaSyBajglgEdUCfeZcv6NLLW1e199wKw5MMow';
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/oekaki-letter/databases/(default)/documents';
const APP_URL = 'https://torayuri.github.io/tango/index.html#inbox';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ── base64url ── */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const enc = s => new TextEncoder().encode(s);

/* ── VAPID (RFC 8292) ── */
export async function vapidHeader(endpoint, jwk) {
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${head}.${body}`));
  const pub = concat([4], unb64u(jwk.x), unb64u(jwk.y));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(pub)}`;
}

/* ── 本文の暗号化 (RFC 8291 aes128gcm) ── */
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
export async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc(text), [2])));
  return concat(salt, [0, 0, 16, 0], [asPub.length], asPub, ct);
}

async function sendPush(sub, payload, jwk) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, jwk),
      TTL: '86400', Urgency: 'high',
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    },
    body,
  });
  return res.status;
}

/* ── Firebase ── */
async function verifyIdToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  return (await r.json()).users?.[0]?.localId || null;
}
async function getUser(uid, idToken) {
  const r = await fetch(`${FIRESTORE}/users/${encodeURIComponent(uid)}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok) return null;
  const f = (await r.json()).fields || {};
  const subs = (f.pushSubs?.arrayValue?.values || []).map(v => { try { return JSON.parse(v.stringValue); } catch { return null; } }).filter(Boolean);
  return { name: f.name?.stringValue || '', subs };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return reply(200, { ok: true, service: 'oekaki-push' });

    let jwk = VAPID_PRIVATE_JWK || (env && env.VAPID_PRIVATE_JWK);
    if (typeof jwk === 'string') jwk = JSON.parse(jwk);
    if (!jwk) return reply(500, { error: 'VAPID key not set' });

    let req;
    try { req = JSON.parse(await request.text()); } catch { return reply(400, { error: 'bad json' }); }
    const { idToken, to } = req || {};
    if (typeof idToken !== 'string' || typeof to !== 'string' || to.length > 128) return reply(400, { error: 'bad request' });

    // 送った人が本物のユーザーか確認し、なまえは Firestore から取る（なりすまし防止）
    const fromUid = await verifyIdToken(idToken);
    if (!fromUid) return reply(401, { error: 'unauthorized' });
    const [from, target] = await Promise.all([getUser(fromUid, idToken), getUser(to, idToken)]);
    if (!from?.name) return reply(403, { error: 'sender has no name' });
    if (!target?.subs.length) return reply(200, { sent: 0 });

    const payload = { title: `${from.name} さんから絵が届きました`, body: 'タップして見てみよう 🎨', url: APP_URL };
    const results = await Promise.all(target.subs.slice(0, 5).map(s => sendPush(s, payload, jwk).catch(() => 0)));
    return reply(200, { sent: results.filter(s => s >= 200 && s < 300).length, results });
  },
};
