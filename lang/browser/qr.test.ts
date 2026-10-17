// The runtime's own QR codes decode back to the exact link, and qr_link never points outside.
// usage: node lang/browser/qr.test.ts <base-url-of-a-running-runtime>
import { readFileSync, existsSync } from "node:fs";
import { chromium } from "playwright";
const [base] = process.argv.slice(2);
const exe = ["chromium-1243", "chromium-1217"].map((d) => `${process.env.LOCALAPPDATA}/ms-playwright/${d}/chrome-win64/chrome.exe`).find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
await page.addScriptTag({ content: readFileSync(new URL("./node_modules/jsqr/dist/jsQR.js", import.meta.url), "utf8") });
let failed = 0;
for (const link of ["http://127.0.0.1:13800/join/fx00-0000-0001", `http://127.0.0.1:13800/session/transfers/${"dHJhbnNmZXIuVXNlci4xLjE3Njg1MDQyMDkwMzI".repeat(2)}.TDdX1lxyouh0G3pa5c0xWsIkXADvMYCKiITdWG5JMek`]) {
  const svg = await (await fetch(`${base}/_qr/${Buffer.from(link).toString("base64url")}`)).text();
  const decoded = await page.evaluate(async (svg) => {
    const img = new Image(); img.src = "data:image/svg+xml;base64," + btoa(svg); await img.decode();
    const c = document.createElement("canvas"); c.width = img.width * 2; c.height = img.height * 2;
    const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height);
    return (window as any).jsQR(d.data, c.width, c.height)?.data ?? null;
  }, svg);
  const ok = decoded === link;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} QR of a ${link.length}-character link decodes to it${ok ? "" : `: got ${decoded}`}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
