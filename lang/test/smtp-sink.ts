// A loopback SMTP server that keeps what it's sent, for tests (and a study harness): enough of
// RFC 5321 for net/smtp's SendMail without sign-in.
import { createServer, type Server } from "node:net";

export type Received = { from: string; to: string[]; data: string };

export function smtpSink(port: number, host = "0.0.0.0"): Promise<{ received: Received[]; close: () => void; server: Server }> {
  const received: Received[] = [];
  const server = createServer((sock) => {
    let buf = "", inData = false, cur: Received = { from: "", to: [], data: "" };
    const say = (s: string) => sock.write(s + "\r\n");
    say("220 sink ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buf = buf.slice(end + 5); inData = false; received.push(cur); cur = { from: "", to: [], data: "" }; say("250 ok");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") say("250 sink");
        else if (cmd === "MAIL") { cur.from = line.replace(/^MAIL FROM:\s*<?([^>]*)>?.*$/i, "$1"); say("250 ok"); }
        else if (cmd === "RCPT") { cur.to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, "$1")); say("250 ok"); }
        else if (cmd === "DATA") { inData = true; say("354 go on"); }
        else if (cmd === "QUIT") { say("221 bye"); sock.end(); return; }
        else if (cmd === "RSET" || cmd === "NOOP") say("250 ok");
        else say("502 not here");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ received, close: () => server.close(), server })));
}

// Run on its own: node lang/test/smtp-sink.ts <port> <file>, appending each message to the file
// as a JSON line (for a test whose app runs elsewhere, as in WSL).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  const [port, file] = process.argv.slice(2);
  if (port && file) {
    const { appendFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(file, "");
    const sink = await smtpSink(Number(port), "127.0.0.1");
    const push = sink.received.push.bind(sink.received);
    sink.received.push = (...m: Received[]) => { for (const x of m) appendFileSync(file, JSON.stringify(x) + "\n"); return push(...m); };
  }
}
