# Vendored code

| File | What | Version | Licence |
| --- | --- | --- | --- |
| `qrcode.mjs` | QR Code Generator for JavaScript, by Kazuhiko Arase (npm `qrcode-generator`) | 2.0.4 | MIT (header in the file) |

Vendored rather than installed so the runtime keeps no npm dependencies. QR codes are made on the
server, as Rails Campfire does with RQRCode, so the links they encode (join links, auto-login
links) never go to an outside service.
