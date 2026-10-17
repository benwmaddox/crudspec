// Guarded outbound HTTP for externs that read from the internet (link previews and the like).
// Every hop is resolved once and pinned to that address, which must be public, so DNS rebinding
// and redirects can't reach loopback, private or link-local networks.
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return publicAddress(l.slice(7));
    return !(l === "::" || l === "::1" || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("ff"));
  }
  return false;
}

export async function resolvePublic(host: string): Promise<string | null> {
  try {
    if (isIP(host)) return publicAddress(host) ? host : null;
    const all = await lookup(host, { all: true });
    // every address the name resolves to must be public
    return all.length && all.every((a) => publicAddress(a.address)) ? all[0].address : null;
  } catch { return null; }
}

export type GuardedResponse = { status: number; headers: Record<string, string>; body: Buffer | null; url: string };

export async function guardedFetch(url: string, opts: { method?: "GET" | "HEAD" | "POST"; maxBytes?: number; maxRedirects?: number; timeoutMs?: number; body?: Buffer; headers?: Record<string, string> } = {}): Promise<GuardedResponse | null> {
  const method = opts.method ?? "GET", maxBytes = opts.maxBytes ?? 5 * 1024 * 1024, timeoutMs = opts.timeoutMs ?? 7000;
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 10); hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const ip = await resolvePublic(u.hostname.replace(/^\[|\]$/g, ""));
    if (!ip) return null;
    const res = await new Promise<GuardedResponse | null>((resolve) => {
      const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
        method, timeout: timeoutMs, servername: isIP(u.hostname) ? undefined : u.hostname,
        lookup: (_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: ip, family: isIP(ip) }]) : cb(null, ip, isIP(ip))),   // pinned
        headers: { "User-Agent": "crudspec-runtime", Accept: "text/html,*/*;q=0.5", ...(opts.body ? { "Content-Length": String(opts.body.length) } : {}), ...opts.headers },
      }, (r) => {
        const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v ?? "")]));
        if (method === "HEAD" || (r.statusCode ?? 0) >= 300 && (r.statusCode ?? 0) < 400) { r.resume(); return resolve({ status: r.statusCode ?? 0, headers, body: null, url: current }); }
        if (Number(headers["content-length"] ?? 0) > maxBytes) { r.destroy(); return resolve({ status: r.statusCode ?? 0, headers, body: null, url: current }); }
        const chunks: Buffer[] = []; let n = 0;
        r.on("data", (c: Buffer) => { n += c.length; if (n > maxBytes) { r.destroy(); resolve({ status: r.statusCode ?? 0, headers, body: null, url: current }); } else chunks.push(c); });
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers, body: Buffer.concat(chunks), url: current }));
        r.on("error", () => resolve(null));
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end(opts.body);
    });
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers.location && hop < (opts.maxRedirects ?? 10)) { current = new URL(res.headers.location, current).toString(); continue; }
    return res;
  }
  return null;   // too many redirects
}
