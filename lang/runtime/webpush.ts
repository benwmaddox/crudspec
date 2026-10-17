// Web Push: payloads encrypted per RFC 8291 (aes128gcm, RFC 8188) and requests signed with
// VAPID (RFC 8292), using only Node's crypto. Delivery goes through the network guard.
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardedFetch } from "./net.ts";

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export type Vapid = { publicKey: string; privateKey: string; subject: string };

// The VAPID key pair: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment (as Rails reads
// them), else one generated once and kept in the data directory.
export function loadVapid(dataDir: string, subject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.invalid"): Vapid {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject };
  const file = join(dataDir, "vapid.json");
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, "utf8")), subject };
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return { ...keys, subject };
}

function signingKey(v: Vapid): KeyObject {
  const pub = unb64u(v.publicKey);
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: v.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
}

// RFC 8292: a JWT for the push service's origin, signed ES256.
export function vapidHeader(endpoint: string, v: Vapid, now = Date.now()): string {
  const enc = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`;
  const sig = sign("sha256", Buffer.from(unsigned), { key: signingKey(v), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.publicKey}`;
}

// RFC 8291 section 3: one aes128gcm record. `fixed` supplies the sender key and salt (tests only).
export function encrypt(payload: Buffer, p256dh: string, auth: string, fixed?: { senderPrivate: string; salt: string }): Buffer {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(unb64u(fixed.senderPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed ? unb64u(fixed.salt) : randomBytes(16);
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Sends one notification. "sent", "expired" (the service says the subscription is gone, so it
// should be deleted, as Rails' pool does), or "failed".
export async function sendPush(endpoint: string, p256dh: string, auth: string, payload: object, v: Vapid,
  post: typeof guardedFetch = guardedFetch): Promise<"sent" | "expired" | "failed"> {
  let u: URL;
  try { u = new URL(endpoint); } catch { return "failed"; }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || !p256dh || !auth) return "failed";
  let body: Buffer;
  try { body = encrypt(Buffer.from(JSON.stringify(payload)), p256dh, auth); } catch { return "expired"; }   // a broken key never recovers
  const res = await post(endpoint, { method: "POST", maxRedirects: 0, body, headers: {
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "2419200", Urgency: "high", Authorization: vapidHeader(endpoint, v) } });
  if (!res) return "failed";
  if (res.status === 404 || res.status === 410) return "expired";
  return res.status >= 200 && res.status < 300 ? "sent" : "failed";
}

// Served at /service-worker.js: shows a pushed notification and opens its path when clicked
// (Campfire's pwa/service_worker.js).
export const SERVICE_WORKER = `self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title ?? "", data.options ?? {}),
    self.navigator.setAppBadge?.(data.options?.data?.badge || 0),
    self.clients.matchAll({ type: "window" }).then((cs) => cs.forEach((c) => c.postMessage({ push: data }))),
  ]));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.path ?? "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => { const f = cs.find((c) => c.focused); return f ? f.navigate(url) : self.clients.openWindow(url); }));
});
`;
