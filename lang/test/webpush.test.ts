// Web Push crypto: the RFC 8291 appendix A vector, a round trip decrypted as a browser would,
// and a VAPID signature that verifies.
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify } from "node:crypto";
import { encrypt, vapidHeader, sendPush, type Vapid } from "../runtime/webpush.ts";

let failed = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) failed++; };

// RFC 8291 appendix A
const vec = encrypt(Buffer.from("When I grow up, I want to be a watermelon"),
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
  { senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: "DGv6ra1nlYgDCS1FRnbzlw" });
ok("RFC 8291 appendix A vector", vec.toString("base64url") ===
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");

// a browser's side: decrypt what sendPush posts
const ua = createECDH("prime256v1"); ua.generateKeys();
const auth = Buffer.from("0123456789abcdef");
const sender = createECDH("prime256v1"); sender.generateKeys();
const vapid: Vapid = { publicKey: sender.getPublicKey().toString("base64url"), privateKey: sender.getPrivateKey().toString("base64url"), subject: "mailto:test@example.invalid" };
const h = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();
let seen: any = null;
const result = await sendPush("https://fcm.googleapis.com/fcm/send/abc", ua.getPublicKey().toString("base64url"), auth.toString("base64url"),
  { title: "Room", options: { body: "Ada: hi", data: { path: "/rooms/1", badge: 2 } } }, vapid,
  async (url, opts) => { seen = { url, ...opts }; return { status: 201, headers: {}, body: null, url }; });
ok("delivery reports sent on 201", result === "sent");
const b: Buffer = seen.body;
const salt = b.subarray(0, 16), idlen = b[20], asPublic = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
const ikm = h(h(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
const prk = h(salt, ikm);
const d = createDecipheriv("aes-128-gcm", h(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), h(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
d.setAuthTag(ct.subarray(ct.length - 16));
const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
ok("payload decrypts, ending in the last-record delimiter", plain[plain.length - 1] === 2 && JSON.parse(plain.subarray(0, -1).toString()).options.data.path === "/rooms/1");
ok("headers: aes128gcm, TTL, urgency", seen.headers["Content-Encoding"] === "aes128gcm" && seen.headers.TTL && seen.headers.Urgency === "high");

// VAPID
const m = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", vapid).match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
const pub = Buffer.from(m[4], "base64url");
const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
ok("VAPID JWT verifies with k", verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
ok("VAPID audience is the push service origin", claims.aud === "https://fcm.googleapis.com" && claims.exp > Date.now() / 1000);

const gone = await sendPush("https://fcm.googleapis.com/x", ua.getPublicKey().toString("base64url"), auth.toString("base64url"), {}, vapid, async (url) => ({ status: 410, headers: {}, body: null, url }));
ok("410 means expired", gone === "expired");
ok("http endpoints are refused", await sendPush("http://fcm.googleapis.com/x", "a", "b", {}, vapid) === "failed");
process.exit(failed ? 1 : 0);
