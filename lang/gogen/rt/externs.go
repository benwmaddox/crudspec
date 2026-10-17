package rt

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Externs: the spec's only ways out of the app (lang/runtime/server.ts EXTERNS).

func (sv *Server) DefaultExterns() map[string]func(args []Val) Val {
	ex := map[string]func(args []Val) Val{
		"post_json": func(a []Val) Val {
			timeout := 7 * time.Second
			if d, ok := arg(a, 2).(Dur); ok {
				timeout = time.Duration(d.MS) * time.Millisecond
			}
			client := &http.Client{Timeout: timeout}
			req, err := http.NewRequest("POST", Plain(arg(a, 0)), strings.NewReader(JSString(arg(a, 1))))
			if err != nil {
				return Obj{"status": int64(0), "content_type": nil, "text": "", "body": nil, "timed_out": false}
			}
			req.Header.Set("Content-Type", "application/json")
			res, err := client.Do(req)
			if err != nil {
				var ne net.Error
				timedOut := errors.As(err, &ne) && ne.Timeout()
				return Obj{"status": int64(0), "content_type": nil, "text": "", "body": nil, "timed_out": timedOut}
			}
			defer res.Body.Close()
			buf, _ := io.ReadAll(res.Body)
			var ct Val
			if c := strings.TrimSpace(strings.Split(res.Header.Get("Content-Type"), ";")[0]); c != "" {
				ct = c
			}
			return Obj{"status": int64(res.StatusCode), "content_type": ct, "text": string(buf), "body": buf, "timed_out": false}
		},
		"opengraph": func(a []Val) Val { return openGraph(Plain(arg(a, 0))) },
		"web_push": func(a []Val) Val {
			payload := map[string]any{"title": Plain(arg(a, 3)), "options": map[string]any{"body": Plain(arg(a, 4)), "data": map[string]any{"path": Plain(arg(a, 5)), "badge": Num(arg(a, 6))}}}
			return SendPush(Plain(arg(a, 0)), Plain(arg(a, 1)), Plain(arg(a, 2)), payload, sv.Vapid)
		},
	}
	// scenario replays stay offline, as the Rails oracle stubs push delivery
	if sv.Test {
		ex["web_push"] = func([]Val) Val { return "sent" }
	}
	return ex
}

// ---- the network guard: every hop resolved once, pinned, and public

func PublicAddress(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		a, b := int(v4[0]), int(v4[1])
		return !(a == 0 || a == 10 || a == 127 || (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31) ||
			(a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)) || a >= 224)
	}
	l := strings.ToLower(ip.String())
	return !(l == "::" || l == "::1" || strings.HasPrefix(l, "fe8") || strings.HasPrefix(l, "fe9") || strings.HasPrefix(l, "fea") || strings.HasPrefix(l, "feb") ||
		strings.HasPrefix(l, "fc") || strings.HasPrefix(l, "fd") || strings.HasPrefix(l, "ff"))
}

func resolvePublic(host string) (string, bool) {
	if ip := net.ParseIP(host); ip != nil {
		return host, PublicAddress(ip)
	}
	addrs, err := net.LookupIP(host)
	if err != nil || len(addrs) == 0 {
		return "", false
	}
	for _, a := range addrs {
		if !PublicAddress(a) {
			return "", false
		}
	}
	return addrs[0].String(), true
}

type guarded struct {
	status  int
	headers http.Header
	body    []byte
}

func guardedFetch(link, method string, body []byte, headers map[string]string, maxRedirects int) *guarded {
	const maxBytes = 5 * 1024 * 1024
	current := link
	for hop := 0; hop <= maxRedirects; hop++ {
		u, err := url.Parse(current)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return nil
		}
		ip, ok := resolvePublic(strings.Trim(u.Hostname(), "[]"))
		if !ok {
			return nil
		}
		port := u.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
		}
		pinned := net.JoinHostPort(ip, port)
		tr := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 7 * time.Second}).DialContext(ctx, network, pinned)
		}}
		client := &http.Client{Transport: tr, Timeout: 7 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		var rb io.Reader
		if body != nil {
			rb = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, current, rb)
		if err != nil {
			return nil
		}
		req.Header.Set("User-Agent", "crudspec-runtime")
		req.Header.Set("Accept", "text/html,*/*;q=0.5")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil
		}
		g := &guarded{status: res.StatusCode, headers: res.Header}
		if method != "HEAD" && !(res.StatusCode >= 300 && res.StatusCode < 400) && res.ContentLength <= maxBytes {
			b, _ := io.ReadAll(io.LimitReader(res.Body, maxBytes+1))
			if len(b) <= maxBytes {
				g.body = b
			}
		}
		res.Body.Close()
		if loc := res.Header.Get("Location"); res.StatusCode >= 300 && res.StatusCode < 400 && loc != "" && hop < maxRedirects {
			next, err := u.Parse(loc)
			if err != nil {
				return nil
			}
			current = next.String()
			continue
		}
		return g
	}
	return nil
}

var skipLinks = regexp.MustCompile(`(?i)\.(zip|tar|gz|bz2|xz|rar|7z|dmg|exe|msi|pkg|deb|iso|jpe?g|png|gif|bmp|mp4|mov|avi|mkv|wmv|flv|heic|heif|mp3|wav|ogg|aac|wma|webm|ogv|mpe?g)(\?|#|$)`)
var metaTag = regexp.MustCompile(`(?i)<meta\s[^>]*>`)
var ogKey = regexp.MustCompile(`(?i)(?:property|name)\s*=\s*["']og:([a-z_:]+)["']`)
var ogContent2 = regexp.MustCompile(`(?i)content\s*=\s*"([^"]*)"`)
var ogContent1 = regexp.MustCompile(`(?i)content\s*=\s*'([^']*)'`)
var tagRe = regexp.MustCompile(`<[^>]*>`)

func decodeEntities(x string) string {
	return strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'").Replace(x)
}

// a link preview from a page's og: tags, as opengraph/*.rb
func openGraph(link string) Val {
	if skipLinks.MatchString(link) {
		return nil
	}
	res := guardedFetch(link, "GET", nil, nil, 10)
	if res == nil || res.status != 200 || res.body == nil || !strings.HasPrefix(strings.TrimSpace(strings.Split(res.headers.Get("Content-Type"), ";")[0]), "text/html") {
		return nil
	}
	og := map[string]string{}
	for _, tag := range metaTag.FindAllString(string(res.body), -1) {
		k := ogKey.FindStringSubmatch(tag)
		c := ogContent2.FindStringSubmatch(tag)
		if c == nil {
			c = ogContent1.FindStringSubmatch(tag)
		}
		if k != nil && c != nil {
			if _, have := og[k[1]]; !have {
				og[k[1]] = decodeEntities(c[1])
			}
		}
	}
	strip := func(x string) string { return strings.TrimSpace(tagRe.ReplaceAllString(x, "")) }
	title, desc := strip(og["title"]), strip(og["description"])
	canonical := link
	if httpURL.MatchString(og["url"]) {
		canonical = og["url"]
	}
	var image Val
	if httpURL.MatchString(og["image"]) {
		image = og["image"]
		head := guardedFetch(og["image"], "HEAD", nil, nil, 10)
		ct := ""
		if head != nil {
			ct = strings.ToLower(strings.TrimSpace(strings.Split(head.headers.Get("Content-Type"), ";")[0]))
		}
		if ct != "image/jpeg" && ct != "image/png" && ct != "image/gif" && ct != "image/webp" {
			image = nil
		}
	}
	if title == "" || desc == "" || canonical == "" {
		return nil
	}
	return Obj{"title": title, "url": canonical, "image": image, "description": desc}
}

// ---- Web Push: RFC 8291 (aes128gcm) payloads, RFC 8292 (VAPID) signatures

type Vapid struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
	Subject    string `json:"-"`
}

var b64u = base64.RawURLEncoding

func LoadVapid(dataDir string) *Vapid {
	subject := os.Getenv("VAPID_SUBJECT")
	if subject == "" {
		subject = "mailto:admin@example.invalid"
	}
	if p, k := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"); p != "" && k != "" {
		return &Vapid{p, k, subject}
	}
	file := filepath.Join(dataDir, "vapid.json")
	v := &Vapid{Subject: subject}
	if b, err := os.ReadFile(file); err == nil && json.Unmarshal(b, v) == nil && v.PublicKey != "" {
		return v
	}
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	v.PublicKey, v.PrivateKey = b64u.EncodeToString(key.PublicKey().Bytes()), b64u.EncodeToString(key.Bytes())
	b, _ := json.Marshal(v)
	os.WriteFile(file, b, 0o600)
	return v
}

func hmacSum(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func vapidHeader(endpoint string, v *Vapid) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	enc := func(o any) string { b, _ := json.Marshal(o); return b64u.EncodeToString(b) }
	unsigned := enc(map[string]string{"typ": "JWT", "alg": "ES256"}) + "." + enc(map[string]any{"aud": u.Scheme + "://" + u.Host, "exp": time.Now().Unix() + 12*3600, "sub": v.Subject})
	d, err := b64u.DecodeString(v.PrivateKey)
	if err != nil {
		return "", err
	}
	pub, _ := b64u.DecodeString(v.PublicKey)
	if len(pub) != 65 {
		return "", fmt.Errorf("bad vapid key")
	}
	priv := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pub[1:33]), Y: new(big.Int).SetBytes(pub[33:])}, D: new(big.Int).SetBytes(d)}
	h := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, priv, h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return "vapid t=" + unsigned + "." + b64u.EncodeToString(sig) + ", k=" + v.PublicKey, nil
}

func encryptPush(payload []byte, p256dh, auth string) ([]byte, error) {
	uaPublic, err := b64u.DecodeString(strings.TrimRight(p256dh, "="))
	if err != nil {
		return nil, err
	}
	authSecret, err := b64u.DecodeString(strings.TrimRight(auth, "="))
	if err != nil {
		return nil, err
	}
	uaKey, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, err
	}
	as, _ := ecdh.P256().GenerateKey(rand.Reader)
	asPublic := as.PublicKey().Bytes()
	salt := make([]byte, 16)
	rand.Read(salt)
	secret, err := as.ECDH(uaKey)
	if err != nil {
		return nil, err
	}
	prkKey := hmacSum(authSecret, secret)
	ikm := hmacSum(prkKey, append(append(append([]byte("WebPush: info\x00"), uaPublic...), asPublic...), 1))
	prk := hmacSum(salt, ikm)
	cek := hmacSum(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16]
	nonce := hmacSum(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12]
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	body := gcm.Seal(nil, nonce, append(payload, 2), nil)
	header := make([]byte, 21)
	copy(header, salt)
	binary.BigEndian.PutUint32(header[16:], 4096)
	header[20] = byte(len(asPublic))
	return append(append(header, asPublic...), body...), nil
}

// SendPush delivers one notification: "sent", "expired" (the service no longer knows the
// subscription) or "failed".
func SendPush(endpoint, p256dh, auth string, payload any, v *Vapid) Val {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") || p256dh == "" || auth == "" {
		return "failed"
	}
	body, err := encryptPush([]byte(JSString(payload)), p256dh, auth)
	if err != nil {
		return "expired"
	}
	authz, err := vapidHeader(endpoint, v)
	if err != nil {
		return "failed"
	}
	res := guardedFetch(endpoint, "POST", body, map[string]string{"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "2419200", "Urgency": "high", "Authorization": authz}, 0)
	if res == nil {
		return "failed"
	}
	if res.status == 404 || res.status == 410 {
		return "expired"
	}
	if res.status >= 200 && res.status < 300 {
		return "sent"
	}
	return "failed"
}

const serviceWorker = `self.addEventListener("push", (event) => {
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
`
